import { Inject, Injectable } from '@nestjs/common';
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { CONFIG, type AppConfig } from '../../config';

export interface QueueUrls {
  main: string;
  dlq: string;
  events: string;
}

@Injectable()
export class SqsGateway {
  readonly client: SQSClient;
  private urlsPromise?: Promise<QueueUrls>;

  constructor(@Inject(CONFIG) private readonly cfg: AppConfig) {
    this.client = new SQSClient({
      endpoint: cfg.sqs.endpoint,
      region: cfg.sqs.region,
      credentials: { accessKeyId: cfg.sqs.accessKeyId, secretAccessKey: cfg.sqs.secretAccessKey },
    });
  }

  /** Idempotent: creates the DLQ, the main queue (with redrive policy) and the events queue. */
  urls(): Promise<QueueUrls> {
    this.urlsPromise ??= this.ensureQueues().catch((e) => {
      this.urlsPromise = undefined; // allow retry once SQS is back
      throw e;
    });
    return this.urlsPromise;
  }

  private async ensureQueues(): Promise<QueueUrls> {
    const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };
    const create = async (name: string, extra: Record<string, string> = {}) =>
      (
        await this.client.send(
          new CreateQueueCommand({ QueueName: name, Attributes: { ...fifo, VisibilityTimeout: '30', ...extra } }),
        )
      ).QueueUrl as string;

    const dlq = await create(this.cfg.queues.dlq);
    const dlqArn = (
      await this.client.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }))
    ).Attributes?.QueueArn as string;
    // Backstop for crashes: SQS itself moves poison messages after maxReceiveCount.
    const main = await create(this.cfg.queues.main, {
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: this.cfg.consumer.maxReceiveCount + 2 }),
    });
    const events = await create(this.cfg.queues.events);
    return { main, dlq, events };
  }

  async ping(): Promise<void> {
    await this.client.send(new GetQueueUrlCommand({ QueueName: this.cfg.queues.main }));
  }

  async receive(queueUrl: string, max: number, waitSeconds: number): Promise<Message[]> {
    const out = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: max,
        WaitTimeSeconds: waitSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    return out.Messages ?? [];
  }

  async delete(queueUrl: string, receiptHandle: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
  }

  async setVisibility(queueUrl: string, receiptHandle: string, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: seconds }),
    );
  }

  async send(queueUrl: string, body: string, groupId: string, dedupId: string, attrs: Record<string, string> = {}) {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
        MessageGroupId: groupId,
        MessageDeduplicationId: dedupId,
        MessageAttributes: Object.fromEntries(
          Object.entries(attrs).map(([k, v]) => [k, { DataType: 'String', StringValue: v }]),
        ),
      }),
    );
  }
}
