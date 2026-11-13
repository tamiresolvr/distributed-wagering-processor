import { ConcurrentModificationError } from '../../domain/errors';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/ledger-entry';
import { OutboxMessage } from '../../domain/messaging';
import { Money } from '../../domain/money';
import { Wallet } from '../../domain/wallet';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import { FailureCode } from '../../domain/failure-code';
import type { Queryable, Row } from './database';

const date = (v: unknown): Date | undefined => (v == null ? undefined : new Date(v as string | number | Date));
const ph = (n: number) => Array.from({ length: n }, () => '?').join(',');

// ---------------------------------------------------------------- wallets
const toWallet = (r: Row): Wallet =>
  Wallet.rehydrate({
    id: r.id,
    playerId: r.player_id,
    currency: r.currency,
    balance: Money.from({ amount: r.balance, currency: r.currency }),
    version: Number(r.version),
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  });

export const walletRepo = {
  /** Pessimistic per-wallet row lock: the unit of concurrency is the wallet. */
  async lockById(q: Queryable, id: string): Promise<Wallet | undefined> {
    const rows = await q.query('SELECT * FROM wallets WHERE id = ? FOR UPDATE', [id]);
    return rows[0] ? toWallet(rows[0]) : undefined;
  },

  async findById(q: Queryable, id: string): Promise<Wallet | undefined> {
    const rows = await q.query('SELECT * FROM wallets WHERE id = ?', [id]);
    return rows[0] ? toWallet(rows[0]) : undefined;
  },

  /** Returns false when (player, currency) already has a wallet. */
  async insert(q: Queryable, w: Wallet): Promise<boolean> {
    const rows = await q.query(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?) ON CONFLICT ON CONSTRAINT uq_wallet_player_currency DO NOTHING RETURNING id`,
      [w.id, w.playerId, w.currency, w.balance.toString(), w.version, w.createdAt, w.updatedAt],
    );
    return rows.length === 1;
  },

  /** Version-guarded update (belt and braces on top of the row lock). */
  async saveBalance(q: Queryable, w: Wallet): Promise<void> {
    const rows = await q.query(
      `UPDATE wallets SET balance = ?, version = ?, updated_at = ? WHERE id = ? AND version = ? RETURNING id`,
      [w.balance.toString(), w.version, w.updatedAt, w.id, w.persistedVersion],
    );
    if (rows.length !== 1) throw new ConcurrentModificationError(`wallet ${w.id} changed concurrently`);
  },
};

// ------------------------------------------------------- wager_transactions
const toTx = (r: Row): WagerTransaction =>
  WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.provider_id,
    externalTransactionId: r.external_transaction_id,
    idempotencyKey: r.idempotency_key,
    payloadHash: r.payload_hash,
    walletId: r.wallet_id,
    playerId: r.player_id,
    roundId: r.round_id,
    gameId: r.game_id,
    kind: r.kind as WagerTransactionKind,
    money: Money.from({ amount: r.amount, currency: r.currency }),
    referenceExternalTransactionId: r.reference_external_transaction_id ?? undefined,
    createdAt: new Date(r.created_at),
    status: r.status as WagerTransactionStatus,
    referenceTransactionId: r.reference_transaction_id ?? undefined,
    failureCode: (r.failure_code ?? undefined) as FailureCode | undefined,
    processedAt: date(r.processed_at),
    balanceAfter: r.balance_after == null ? undefined : Money.from({ amount: r.balance_after, currency: r.currency }),
    attempts: Number(r.attempts),
    nextAttemptAt: date(r.next_attempt_at),
  });

const TX_COLUMNS = `id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
  round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status,
  failure_code, balance_after, attempts, next_attempt_at, correlation_id, created_at, processed_at`;

export const txRepo = {
  async findById(q: Queryable, id: string): Promise<WagerTransaction | undefined> {
    const rows = await q.query('SELECT * FROM wager_transactions WHERE id = ?', [id]);
    return rows[0] ? toTx(rows[0]) : undefined;
  },

  async lockById(q: Queryable, id: string): Promise<WagerTransaction | undefined> {
    const rows = await q.query('SELECT * FROM wager_transactions WHERE id = ? FOR UPDATE', [id]);
    return rows[0] ? toTx(rows[0]) : undefined;
  },

  async findByIdempotencyKey(q: Queryable, key: string): Promise<WagerTransaction | undefined> {
    const rows = await q.query('SELECT * FROM wager_transactions WHERE idempotency_key = ?', [key]);
    return rows[0] ? toTx(rows[0]) : undefined;
  },

  async findByProviderExternal(q: Queryable, providerId: string, externalId: string): Promise<WagerTransaction | undefined> {
    const rows = await q.query(
      'SELECT * FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?',
      [providerId, externalId],
    );
    return rows[0] ? toTx(rows[0]) : undefined;
  },

  /** A PROCESSED reversal (REFUND/ROLLBACK) pointing at `referenceId`, if any. */
  async findProcessedReversalOf(q: Queryable, referenceId: string): Promise<WagerTransaction | undefined> {
    const rows = await q.query(
      `SELECT * FROM wager_transactions
       WHERE reference_transaction_id = ? AND status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`,
      [referenceId],
    );
    return rows[0] ? toTx(rows[0]) : undefined;
  },

  /** false => lost a unique race (idempotency key or provider+external id). */
  async insert(q: Queryable, t: WagerTransaction, correlationId: string): Promise<boolean> {
    const rows = await q.query(
      `INSERT INTO wager_transactions (${TX_COLUMNS}) VALUES (${ph(22)}) ON CONFLICT DO NOTHING RETURNING id`,
      [
        t.id, t.providerId, t.externalTransactionId, t.idempotencyKey, t.payloadHash, t.walletId, t.playerId,
        t.roundId, t.gameId, t.kind, t.money.toString(), t.money.currency,
        t.referenceExternalTransactionId ?? null, t.referenceTransactionId ?? null, t.status,
        t.failureCode ?? null, t.balanceAfter?.toString() ?? null, t.attempts, t.nextAttemptAt ?? null,
        correlationId, t.createdAt, t.processedAt ?? null,
      ],
    );
    return rows.length === 1;
  },

  async update(q: Queryable, t: WagerTransaction): Promise<void> {
    await q.query(
      `UPDATE wager_transactions SET status = ?, failure_code = ?, reference_transaction_id = ?, balance_after = ?,
         attempts = ?, next_attempt_at = ?, processed_at = ? WHERE id = ?`,
      [
        t.status, t.failureCode ?? null, t.referenceTransactionId ?? null, t.balanceAfter?.toString() ?? null,
        t.attempts, t.nextAttemptAt ?? null, t.processedAt ?? null, t.id,
      ],
    );
  },

  /** A transaction just became PROCESSED: dependents waiting for it can retry right away. */
  async wakeDependents(q: Queryable, providerId: string, externalId: string, now: Date): Promise<void> {
    await q.query(
      `UPDATE wager_transactions SET next_attempt_at = ?
       WHERE status = 'PENDING_REFERENCE' AND provider_id = ? AND reference_external_transaction_id = ?
         AND next_attempt_at > ?`,
      [now, providerId, externalId, now],
    );
  },

  async dueIds(q: Queryable, now: Date, limit: number): Promise<{ id: string; walletId: string }[]> {
    const rows = await q.query(
      `SELECT id, wallet_id FROM wager_transactions
       WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?`,
      [now, limit],
    );
    return rows.map((r) => ({ id: r.id, walletId: r.wallet_id }));
  },
};

// ------------------------------------------------------------------- ledger
export interface LedgerPage {
  items: { seq: string; entry: WalletLedgerEntry }[];
  hasMore: boolean;
}

const toEntry = (r: Row): WalletLedgerEntry =>
  WalletLedgerEntry.rehydrate({
    id: r.id,
    walletId: r.wallet_id,
    transactionId: r.transaction_id,
    direction: r.direction as LedgerDirection,
    money: Money.from({ amount: r.amount, currency: r.currency }),
    balanceBefore: Money.from({ amount: r.balance_before, currency: r.currency }),
    balanceAfter: Money.from({ amount: r.balance_after, currency: r.currency }),
    createdAt: new Date(r.created_at),
  });

export const ledgerRepo = {
  async insert(q: Queryable, e: WalletLedgerEntry): Promise<void> {
    await q.query(
      `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        e.id, e.walletId, e.transactionId, e.direction, e.money.toString(), e.money.currency,
        e.balanceBefore.toString(), e.balanceAfter.toString(), e.createdAt,
      ],
    );
  },

  /** Keyset pagination on the per-wallet monotonic `seq` (stable under concurrent inserts). */
  async page(q: Queryable, walletId: string, afterSeq: string, limit: number): Promise<LedgerPage> {
    const rows = await q.query(
      `SELECT *, seq::text AS seq_text FROM wallet_ledger_entries
       WHERE wallet_id = ? AND seq > ?::bigint ORDER BY seq ASC LIMIT ?`,
      [walletId, afterSeq, limit + 1],
    );
    const items = rows.slice(0, limit).map((r) => ({ seq: r.seq_text as string, entry: toEntry(r) }));
    return { items, hasMore: rows.length > limit };
  },

  /** One statement => one snapshot: stored balance vs. balance rebuilt from the ledger. */
  async reconcile(q: Queryable, walletId: string) {
    const rows = await q.query(
      `SELECT w.balance AS stored, w.currency,
         COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(20,2) AS calculated,
         COUNT(l.id)::int AS entries
       FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
       WHERE w.id = ? GROUP BY w.id`,
      [walletId],
    );
    return rows[0];
  },
};

// -------------------------------------------------------------------- inbox
export const inboxRepo = {
  /** true if this (consumer, message) was seen for the first time. Blocks on an in-flight duplicate. */
  async receive(q: Queryable, consumer: string, messageId: string, hash: string, now: Date): Promise<boolean> {
    const rows = await q.query(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING message_id`,
      [consumer, messageId, hash, now, now],
    );
    return rows.length === 1;
  },

  async payloadHash(q: Queryable, consumer: string, messageId: string): Promise<string | undefined> {
    const rows = await q.query('SELECT payload_hash FROM inbox_messages WHERE consumer_name = ? AND message_id = ?', [
      consumer,
      messageId,
    ]);
    return rows[0]?.payload_hash;
  },
};

// ------------------------------------------------------------------- outbox
const toOutbox = (r: Row): OutboxMessage =>
  OutboxMessage.rehydrate({
    id: r.id,
    aggregateId: r.aggregate_id,
    eventType: r.event_type,
    payload: r.payload,
    occurredAt: new Date(r.occurred_at),
    attempts: Number(r.attempts),
    nextAttemptAt: date(r.next_attempt_at),
    publishedAt: date(r.published_at),
  });

export const outboxRepo = {
  async insert(q: Queryable, m: OutboxMessage): Promise<void> {
    await q.query(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
       VALUES (?,?,?,?::jsonb,?,?,?)`,
      [m.id, m.aggregateId, m.eventType, JSON.stringify(m.payload), m.occurredAt, m.attempts, m.nextAttemptAt ?? m.occurredAt],
    );
  },

  /** Claims due rows; SKIP LOCKED lets concurrent publishers take disjoint batches. */
  async lockDue(q: Queryable, now: Date, limit: number): Promise<OutboxMessage[]> {
    const rows = await q.query(
      `SELECT * FROM outbox_messages WHERE published_at IS NULL AND next_attempt_at <= ?
       ORDER BY occurred_at, id LIMIT ? FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    return rows.map(toOutbox);
  },

  async markPublished(q: Queryable, m: OutboxMessage): Promise<void> {
    await q.query('UPDATE outbox_messages SET published_at = ? WHERE id = ?', [m.publishedAt ?? new Date(), m.id]);
  },

  async saveRetry(q: Queryable, m: OutboxMessage): Promise<void> {
    await q.query('UPDATE outbox_messages SET attempts = ?, next_attempt_at = ? WHERE id = ?', [
      m.attempts,
      m.nextAttemptAt ?? new Date(),
      m.id,
    ]);
  },

  async lagSeconds(q: Queryable): Promise<number> {
    const rows = await q.query(
      `SELECT COALESCE(EXTRACT(EPOCH FROM (now() - MIN(occurred_at))), 0)::float8 AS lag
       FROM outbox_messages WHERE published_at IS NULL`,
    );
    return Number(rows[0]?.lag ?? 0);
  },
};
