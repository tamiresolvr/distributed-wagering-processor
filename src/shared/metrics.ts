import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const metrics = {
  transactions: new Counter({
    name: 'wager_transactions_total',
    help: 'Wager transactions by resulting status and kind',
    labelNames: ['status', 'kind'] as const,
    registers: [registry],
  }),
  duplicates: new Counter({
    name: 'wager_duplicates_detected_total',
    help: 'Duplicate submissions detected (idempotent replays)',
    labelNames: ['source'] as const,
    registers: [registry],
  }),
  retries: new Counter({
    name: 'wager_retries_total',
    help: 'Retries by component',
    labelNames: ['component'] as const,
    registers: [registry],
  }),
  dlq: new Counter({
    name: 'wager_dlq_messages_total',
    help: 'Messages sent to the DLQ',
    labelNames: ['reason'] as const,
    registers: [registry],
  }),
  lockConflicts: new Counter({
    name: 'wager_lock_conflicts_total',
    help: 'Concurrency conflicts (deadlock, serialization, lost unique race, version guard)',
    labelNames: ['type'] as const,
    registers: [registry],
  }),
  lockWait: new Histogram({
    name: 'wager_wallet_lock_wait_seconds',
    help: 'Time spent acquiring the wallet row lock',
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
    registers: [registry],
  }),
  processingSeconds: new Histogram({
    name: 'wager_processing_seconds',
    help: 'End-to-end processing latency of a submission',
    labelNames: ['source'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  }),
  outboxPublished: new Counter({
    name: 'wager_outbox_published_total',
    help: 'Outbox events published',
    registers: [registry],
  }),
  outboxFailures: new Counter({
    name: 'wager_outbox_publish_failures_total',
    help: 'Outbox publish failures',
    registers: [registry],
  }),
  outboxLag: new Gauge({
    name: 'wager_outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox event',
    registers: [registry],
  }),
  reconciliationDivergences: new Counter({
    name: 'wager_reconciliation_divergences_total',
    help: 'Wallets found inconsistent with their ledger',
    registers: [registry],
  }),
};
