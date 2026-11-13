import { Inject, Injectable } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config';
import { Database, isTransientDbError, type Queryable } from '../infrastructure/db/database';
import { inboxRepo, ledgerRepo, outboxRepo, txRepo, walletRepo } from '../infrastructure/db/repositories';
import {
  ConcurrentDuplicateError,
  ConcurrentModificationError,
  IdempotencyConflictError,
  InsufficientFundsError,
  WalletNotFoundError,
} from '../domain/errors';
import { FailureCode } from '../domain/failure-code';
import {
  EventContext,
  IntegrationEvent,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events';
import { LedgerDirection, WalletLedgerEntry } from '../domain/ledger-entry';
import { OutboxMessage } from '../domain/messaging';
import { Money } from '../domain/money';
import { Wallet } from '../domain/wallet';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import { log } from '../shared/logger';
import { metrics } from '../shared/metrics';
import { sleep, uuidv7 } from '../shared/util';
import { InboxOrigin, SubmitWagerCommand, WagerResult, payloadHashOf } from './commands';

const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, WagerTransactionKind[]>> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
};

const MAX_CONFLICT_RETRIES = 4;

function conflictType(e: unknown): string | undefined {
  if (e instanceof ConcurrentDuplicateError) return 'unique_race';
  if (e instanceof ConcurrentModificationError) return 'version_guard';
  const code = (e as { code?: string })?.code;
  if (code === '40P01') return 'deadlock';
  if (code === '40001') return 'serialization';
  return undefined;
}

interface TxOutcome {
  result: WagerResult;
  replay: boolean;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
}

/**
 * The single financial use case. Shared by HTTP, the SQS consumer and the
 * pending-reference reprocessor: one transaction = wallet lock + idempotency
 * check + decision + wallet/ledger/transaction rows + inbox + outbox.
 */
@Injectable()
export class WagerProcessor {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  async submit(cmd: SubmitWagerCommand, origin?: InboxOrigin): Promise<WagerResult> {
    const hash = payloadHashOf(cmd);
    const started = performance.now();
    for (let attempt = 1; ; attempt++) {
      try {
        const out = await this.db.transaction((q) => this.submitInTx(q, cmd, hash, origin));
        // Metrics only after COMMIT, so rolled-back attempts are never counted.
        if (out.replay) metrics.duplicates.inc({ source: origin ? 'inbox' : 'http' });
        else metrics.transactions.inc({ status: out.status, kind: out.kind });
        metrics.processingSeconds.observe({ source: origin ? 'sqs' : 'http' }, (performance.now() - started) / 1000);
        return out.result;
      } catch (e) {
        const type = conflictType(e);
        if (type && attempt < MAX_CONFLICT_RETRIES) {
          metrics.lockConflicts.inc({ type });
          metrics.retries.inc({ component: 'processor' });
          await sleep(5 * attempt + Math.random() * 10);
          continue;
        }
        if (type) metrics.lockConflicts.inc({ type });
        throw e;
      }
    }
  }

  private async submitInTx(q: Queryable, cmd: SubmitWagerCommand, hash: string, origin?: InboxOrigin): Promise<TxOutcome> {
    const now = new Date();

    if (origin) {
      const first = await inboxRepo.receive(q, origin.consumerName, origin.messageId, hash, now);
      if (!first) {
        const prior = await inboxRepo.payloadHash(q, origin.consumerName, origin.messageId);
        const existing = await txRepo.findByIdempotencyKey(q, cmd.idempotencyKey);
        if (prior !== hash || !existing) {
          throw new IdempotencyConflictError(`messageId ${origin.messageId} was already consumed with a different payload`);
        }
        return this.replayOf(existing);
      }
    }

    const lockStart = performance.now();
    const wallet = await walletRepo.lockById(q, cmd.walletId);
    metrics.lockWait.observe((performance.now() - lockStart) / 1000);
    if (!wallet) throw new WalletNotFoundError(cmd.walletId);

    const existing =
      (await txRepo.findByIdempotencyKey(q, cmd.idempotencyKey)) ??
      (await txRepo.findByProviderExternal(q, cmd.providerId, cmd.externalTransactionId));
    if (existing) {
      if (existing.idempotencyKey !== cmd.idempotencyKey || !existing.matchesPayload(hash)) {
        throw new IdempotencyConflictError('same idempotency key / external id used with a different payload');
      }
      return this.replayOf(existing);
    }

    const t = WagerTransaction.create({
      id: uuidv7(),
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      idempotencyKey: cmd.idempotencyKey,
      payloadHash: hash,
      walletId: cmd.walletId,
      playerId: cmd.playerId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: cmd.kind,
      money: cmd.money,
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
      createdAt: now,
    });

    const entry = await this.decide(q, wallet, t, now);

    // Transaction row first: the ledger entry references it.
    if (!(await txRepo.insert(q, t, cmd.correlationId))) throw new ConcurrentDuplicateError('lost unique race');
    await this.persistEffects(q, wallet, t, entry, cmd.correlationId, now);

    log.info('wager transaction handled', {
      correlationId: cmd.correlationId,
      messageId: origin?.messageId,
      transactionId: t.id,
      walletId: t.walletId,
      providerId: t.providerId,
      status: t.status,
      failureCode: t.failureCode,
    });
    return { result: this.resultOf(t, false), replay: false, kind: t.kind, status: t.status };
  }

  /** Re-evaluates a PENDING_REFERENCE transaction. Safe to run on many instances. */
  async reprocess(transactionId: string, walletId: string): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      try {
        const out = await this.db.transaction(async (q) => {
          const now = new Date();
          const wallet = await walletRepo.lockById(q, walletId); // wallet first, then tx: global lock order
          const t = await txRepo.lockById(q, transactionId);
          if (!wallet || !t) return undefined;
          if (t.status !== WagerTransactionStatus.PendingReference) return undefined;
          if (t.nextAttemptAt && t.nextAttemptAt > now) return undefined;

          const entry = await this.decide(q, wallet, t, now);
          await txRepo.update(q, t);
          await this.persistEffects(q, wallet, t, entry, t.id, now);
          log.info('pending transaction reprocessed', {
            transactionId: t.id,
            walletId: t.walletId,
            providerId: t.providerId,
            status: t.status,
            failureCode: t.failureCode,
          });
          return t;
        });
        if (out) metrics.transactions.inc({ status: out.status, kind: out.kind });
        return out !== undefined;
      } catch (e) {
        const type = conflictType(e);
        if (type && attempt < MAX_CONFLICT_RETRIES) {
          metrics.lockConflicts.inc({ type });
          await sleep(5 * attempt);
          continue;
        }
        throw e;
      }
    }
  }

  async findDue(limit = 50) {
    return txRepo.dueIds(this.db, new Date(), limit);
  }

  // ------------------------------------------------------------------ rules
  /**
   * Applies business rules to `t` (mutating it and the wallet in memory) and
   * returns the ledger entry when the balance moved. Persistence is separate.
   */
  private async decide(q: Queryable, wallet: Wallet, t: WagerTransaction, now: Date): Promise<WalletLedgerEntry | undefined> {
    const reject = (code: FailureCode) => t.reject(code, now, wallet.balance);

    if (t.money.currency !== wallet.currency) return void reject(FailureCode.CurrencyMismatch);
    if (t.playerId !== wallet.playerId) return void reject(FailureCode.WalletPlayerMismatch);

    let ref: WagerTransaction | undefined;
    if (t.referenceExternalTransactionId) {
      ref = await txRepo.findByProviderExternal(q, t.providerId, t.referenceExternalTransactionId);
      const unresolved =
        !ref || ref.status === WagerTransactionStatus.Pending || ref.status === WagerTransactionStatus.PendingReference;
      if (unresolved) {
        if (t.requiresReference()) {
          return void this.waitOrReject(t, wallet, now, ref ? FailureCode.ReferenceNotProcessed : FailureCode.ReferenceNotFound);
        }
        ref = undefined; // WIN/LOSS: reference is optional and only linked when resolvable
      } else if (ref!.status !== WagerTransactionStatus.Processed) {
        return void reject(FailureCode.ReferenceNotProcessed);
      }
    }

    if (ref) {
      if (
        ref.walletId !== t.walletId ||
        ref.playerId !== t.playerId ||
        ref.roundId !== t.roundId ||
        ref.money.currency !== t.money.currency
      ) {
        return void reject(FailureCode.ReferenceMismatch);
      }
      if (!ALLOWED_REFERENCE_KINDS[t.kind]?.includes(ref.kind)) return void reject(FailureCode.InvalidReferenceKind);
      if (t.requiresReference()) {
        if (!ref.money.equals(t.money)) return void reject(FailureCode.ReferenceAmountMismatch);
        if (await txRepo.findProcessedReversalOf(q, ref.id)) return void reject(FailureCode.AlreadyReversed);
      }
    }

    if (!t.affectsBalance()) {
      t.markProcessed(ref?.id, now, wallet.balance);
      return undefined;
    }

    try {
      const direction = t.ledgerDirectionFor(ref);
      const entry =
        direction === LedgerDirection.Debit
          ? wallet.debit(t.money, t.id, uuidv7(), now)
          : wallet.credit(t.money, t.id, uuidv7(), now);
      t.markProcessed(ref?.id, now, wallet.balance);
      return entry;
    } catch (e) {
      if (e instanceof InsufficientFundsError) {
        reject(t.kind === WagerTransactionKind.Bet ? FailureCode.InsufficientFunds : FailureCode.ReversalInsufficientFunds);
        return undefined;
      }
      throw e;
    }
  }

  /** Backoff 2^n with a ceiling; after `maxAttempts` waits the transaction is REJECTED. */
  private waitOrReject(t: WagerTransaction, wallet: Wallet, now: Date, exhaustedCode: FailureCode): void {
    const r = this.cfg.reprocessor;
    if (t.attempts + 1 >= r.maxAttempts) {
      t.reject(exhaustedCode, now, wallet.balance);
      return;
    }
    const delay = Math.min(r.backoffMaxMs, r.backoffBaseMs * 2 ** t.attempts);
    t.markPendingReference(new Date(now.getTime() + delay), wallet.balance);
  }

  // ------------------------------------------------------------ persistence
  private async persistEffects(
    q: Queryable,
    wallet: Wallet,
    t: WagerTransaction,
    entry: WalletLedgerEntry | undefined,
    correlationId: string,
    now: Date,
  ): Promise<void> {
    if (entry) {
      await walletRepo.saveBalance(q, wallet);
      await ledgerRepo.insert(q, entry);
    }
    const ctx = (): EventContext => ({ eventId: uuidv7(), correlationId, causationId: t.id, occurredAt: now });
    const events: IntegrationEvent<unknown>[] = [];
    switch (t.status) {
      case WagerTransactionStatus.Processed:
        events.push(WagerTransactionProcessed.from(t, ctx()));
        break;
      case WagerTransactionStatus.Rejected:
        events.push(WagerTransactionRejected.from(t, ctx()));
        break;
      case WagerTransactionStatus.PendingReference:
        events.push(WagerTransactionPendingReference.from(t, ctx()));
        break;
      default:
        break;
    }
    if (entry) events.push(WalletBalanceChanged.from(wallet, entry, ctx()));
    for (const ev of events) await outboxRepo.insert(q, OutboxMessage.enqueue(ev));

    if (t.status === WagerTransactionStatus.Processed) {
      await txRepo.wakeDependents(q, t.providerId, t.externalTransactionId, now);
    }
  }

  private replayOf(t: WagerTransaction): TxOutcome {
    return { result: this.resultOf(t, true), replay: true, kind: t.kind, status: t.status };
  }

  private resultOf(t: WagerTransaction, replay: boolean): WagerResult {
    return {
      transactionId: t.id,
      status: t.status,
      failureCode: t.failureCode,
      balance: (t.balanceAfter ?? Money.zero(t.money.currency)).toJSON(),
      idempotentReplay: replay,
    };
  }
}
