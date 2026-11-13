import { BeforeApplicationShutdown, Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config';
import { WagerProcessor } from './wager-processor';
import { log } from '../shared/logger';
import { Loop } from '../shared/loop';
import { sleep } from '../shared/util';

/** Scheduled worker for PENDING_REFERENCE transactions (backoff + exhaustion live in WagerProcessor). */
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop: Loop;

  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(WagerProcessor) private readonly processor: WagerProcessor,
  ) {
    this.loop = new Loop(
      'pending-reference-worker',
      async () => {
        const n = await this.tick();
        if (n === 0) await sleep(this.cfg.reprocessor.intervalMs);
      },
      async (name, e) => {
        log.error('reprocessor loop error', { loop: name, error: (e as Error).message });
        await sleep(1000);
      },
    );
  }

  onApplicationBootstrap(): void {
    if (this.cfg.reprocessor.enabled) this.loop.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop.stop();
  }

  /** One pass over due transactions; returns how many were actually re-evaluated. */
  async tick(): Promise<number> {
    const due = await this.processor.findDue(50);
    let handled = 0;
    for (const d of due) {
      try {
        if (await this.processor.reprocess(d.id, d.walletId)) handled++;
      } catch (e) {
        log.error('reprocess failed', { transactionId: d.id, walletId: d.walletId, error: (e as Error).message });
      }
    }
    return handled;
  }
}
