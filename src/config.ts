export interface AppConfig {
  port: number;
  databaseUrl: string;
  dbPoolMax: number;
  sqs: { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string };
  queues: { main: string; dlq: string; events: string };
  consumer: { enabled: boolean; maxReceiveCount: number; waitSeconds: number };
  publisher: { enabled: boolean; intervalMs: number; batchSize: number };
  reprocessor: { enabled: boolean; intervalMs: number; maxAttempts: number; backoffBaseMs: number; backoffMaxMs: number };
}

const bool = (v: string | undefined, d: boolean) => (v === undefined ? d : v === 'true');
const int = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

/** Read at module-creation time (tests override process.env before booting). */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  return {
    port: int(env.PORT, 3000),
    databaseUrl: env.DATABASE_URL ?? 'postgres://wager:wager@localhost:5432/wager',
    dbPoolMax: int(env.DB_POOL_MAX, 10),
    sqs: {
      endpoint: env.SQS_ENDPOINT ?? 'http://localhost:4566',
      region: env.AWS_REGION ?? 'us-east-1',
      accessKeyId: env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
    queues: {
      main: env.QUEUE_MAIN ?? 'wager-transactions.fifo',
      dlq: env.QUEUE_DLQ ?? 'wager-transactions-dlq.fifo',
      events: env.QUEUE_EVENTS ?? 'wager-events.fifo',
    },
    consumer: {
      enabled: bool(env.CONSUMER_ENABLED, true),
      maxReceiveCount: int(env.CONSUMER_MAX_RECEIVE_COUNT, 5),
      waitSeconds: int(env.CONSUMER_WAIT_SECONDS, 2),
    },
    publisher: {
      enabled: bool(env.PUBLISHER_ENABLED, true),
      intervalMs: int(env.PUBLISHER_INTERVAL_MS, 500),
      batchSize: int(env.PUBLISHER_BATCH_SIZE, 50),
    },
    reprocessor: {
      enabled: bool(env.REPROCESSOR_ENABLED, true),
      intervalMs: int(env.REPROCESSOR_INTERVAL_MS, 1000),
      maxAttempts: int(env.PENDING_MAX_ATTEMPTS, 12),
      backoffBaseMs: int(env.PENDING_BACKOFF_BASE_MS, 2000),
      backoffMaxMs: int(env.PENDING_BACKOFF_MAX_MS, 60_000),
    },
  };
}

export const CONFIG = 'APP_CONFIG';
