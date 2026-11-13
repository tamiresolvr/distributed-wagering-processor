import { BeforeApplicationShutdown, Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import type { Message } from '@aws-sdk/client-sqs';
import { CONFIG, type AppConfig } from '../../config';
import { WagerProcessor } from '../../application/wager-processor';
import { parseSubmitCommand } from '../../application/commands';
import { DomainError, IdempotencyConflictError, ValidationError, WalletNotFoundError } from '../../domain/errors';
import { isTransientDbError } from '../db/database';
import { log } from '../../shared/logger';
import { Loop } from '../../shared/loop';
import { metrics } from '../../shared/metrics';
import { sleep } from '../../shared/util';
import { SqsGateway } from './sqs.gateway';

export const CONSUMER_NAME = 'wager-transactions-consumer';

/**
 * Failure classes:
 *  - business/terminal (REJECTED is a *successful* outcome; idempotency conflict; unknown wallet): ack
 *  - transient (DB/SQS/concurrency, unknown errors): keep message, exponential visibility backoff
 *  - permanent (malformed payload) or receive count exhausted: copy to DLQ, then ack
 */
@Injectable()
export class WagerConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop: Loop;

  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(SqsGateway) private readonly sqs: SqsGateway,
    @Inject(WagerProcessor) private readonly processor: WagerProcessor,
  ) {
    this.loop = new Loop(
      'wager-consumer',
      (stopping) => this.poll(stopping),
      async (name, e) => {
        log.error('consumer loop error', { loop: name, error: (e as Error).message });
        await sleep(1000);
      },
    );
  }

  onApplicationBootstrap(): void {
    if (this.cfg.consumer.enabled) this.start();
  }

  start(): void {
    this.loop.start();
  }

  /** SIGTERM: stop polling, let in-flight messages finish; unstarted ones get their visibility released. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.loop.stop();
  }

  async stop(): Promise<void> {
    await this.loop.stop();
  }

  private async poll(stopping: () => boolean): Promise<void> {
    const urls = await this.sqs.urls();
    const messages = await this.sqs.receive(urls.main, 10, this.cfg.consumer.waitSeconds);
    await Promise.all(messages.map((m) => this.handle(urls.main, urls.dlq, m, stopping)));
  }

  private async handle(mainUrl: string, dlqUrl: string, msg: Message, stopping: () => boolean): Promise<void> {
    const handle = msg.ReceiptHandle as string;
    if (stopping()) {
      await this.sqs.setVisibility(mainUrl, handle, 0).catch(() => undefined);
      return;
    }
    const receiveCount = Number(msg.Attributes?.ApproximateReceiveCount ?? '1');
    let messageId: string | undefined;
    try {
      const envelope = this.parseEnvelope(msg.Body);
      messageId = envelope.messageId;
      const cmd = parseSubmitCommand(envelope.data, (envelope.data as any)?.idempotencyKey, envelope.messageId);
      const result = await this.processor.submit(cmd, { consumerName: CONSUMER_NAME, messageId });
      log.info('message processed', { messageId, transactionId: result.transactionId, status: result.status });
      await this.sqs.delete(mainUrl, handle); // ack strictly after COMMIT
    } catch (e) {
      await this.onFailure(mainUrl, dlqUrl, msg, handle, receiveCount, messageId, e);
    }
  }

  private parseEnvelope(body: string | undefined): { messageId: string; data: unknown } {
    let parsed: any;
    try {
      parsed = JSON.parse(body ?? '');
    } catch {
      throw new ValidationError('message body is not valid JSON', 'MALFORMED_MESSAGE');
    }
    if (parsed?.type !== 'WagerTransactionRequested' || typeof parsed?.messageId !== 'string' || !parsed.messageId) {
      throw new ValidationError('unsupported or malformed message envelope', 'MALFORMED_MESSAGE');
    }
    return { messageId: parsed.messageId, data: parsed.data };
  }

  private async onFailure(
    mainUrl: string,
    dlqUrl: string,
    msg: Message,
    handle: string,
    receiveCount: number,
    messageId: string | undefined,
    e: unknown,
  ): Promise<void> {
    const err = e as Error;
    // Terminal business outcomes: ack, nothing to retry.
    if (e instanceof IdempotencyConflictError || e instanceof WalletNotFoundError) {
      log.warn('message acked with terminal business error', { messageId, code: (e as DomainError).code });
      metrics.transactions.inc({ status: 'ERROR_' + (e as DomainError).code, kind: 'n/a' });
      await this.sqs.delete(mainUrl, handle);
      return;
    }
    const permanent = e instanceof ValidationError;
    const exhausted = receiveCount >= this.cfg.consumer.maxReceiveCount;
    if (permanent || exhausted) {
      const reason = permanent ? (e as DomainError).code : 'MAX_RECEIVE_COUNT';
      log.error('message sent to DLQ', { messageId, reason, receiveCount, error: err.message });
      await this.sqs.send(dlqUrl, msg.Body ?? '', 'dlq', `${msg.MessageId}-dlq`, {
        failureReason: reason,
        receiveCount: String(receiveCount),
      });
      metrics.dlq.inc({ reason });
      await this.sqs.delete(mainUrl, handle);
      return;
    }
    // Transient (or unknown): back off exponentially via visibility timeout.
    const delay = Math.min(300, 2 ** receiveCount);
    log.warn('transient failure, will retry', {
      messageId,
      receiveCount,
      transientDb: isTransientDbError(e),
      error: err.message,
    });
    metrics.retries.inc({ component: 'consumer' });
    await this.sqs.setVisibility(mainUrl, handle, delay).catch(() => undefined);
  }
}
