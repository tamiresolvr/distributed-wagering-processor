import { BeforeApplicationShutdown, Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../../config';
import { Database } from '../db/database';
import { outboxRepo } from '../db/repositories';
import { log } from '../../shared/logger';
import { Loop } from '../../shared/loop';
import { metrics } from '../../shared/metrics';
import { sleep } from '../../shared/util';
import { SqsGateway } from './sqs.gateway';

/**
 * Transactional-outbox relay. Each tick claims a batch with FOR UPDATE SKIP LOCKED,
 * so N publishers take disjoint rows. If a process dies mid-tick its transaction
 * rolls back, the rows are unlocked and any other instance publishes them.
 * Crash between SQS send and COMMIT => duplicate publication (at-least-once);
 * consumers dedupe on eventId and FIFO dedup uses eventId as well.
 */
@Injectable()
export class OutboxPublisher implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop: Loop;

  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(Database) private readonly db: Database,
    @Inject(SqsGateway) private readonly sqs: SqsGateway,
  ) {
    this.loop = new Loop(
      'outbox-publisher',
      async () => {
        const n = await this.tick();
        if (n === 0) await sleep(this.cfg.publisher.intervalMs);
      },
      async (name, e) => {
        log.error('publisher loop error', { loop: name, error: (e as Error).message });
        await sleep(1000);
      },
    );
  }

  onApplicationBootstrap(): void {
    if (this.cfg.publisher.enabled) this.loop.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop.stop();
  }

  /** Publishes one batch; returns the number of events published. */
  async tick(): Promise<number> {
    const urls = await this.sqs.urls();
    return this.db.transaction(async (q) => {
      const now = new Date();
      const batch = await outboxRepo.lockDue(q, now, this.cfg.publisher.batchSize);
      let published = 0;
      for (const m of batch) {
        try {
          await this.sqs.send(urls.events, JSON.stringify(m.payload), m.aggregateId, m.id, { eventType: m.eventType });
          m.markPublished(new Date());
          await outboxRepo.markPublished(q, m);
          metrics.outboxPublished.inc();
          published++;
        } catch (e) {
          m.scheduleRetry(now);
          await outboxRepo.saveRetry(q, m);
          metrics.outboxFailures.inc();
          metrics.retries.inc({ component: 'outbox' });
          log.warn('outbox publish failed', { eventId: m.id, attempts: m.attempts, error: (e as Error).message });
        }
      }
      return published;
    });
  }
}
