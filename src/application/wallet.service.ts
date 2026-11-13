import { Inject, Injectable } from '@nestjs/common';
import { Database } from '../infrastructure/db/database';
import { ledgerRepo, outboxRepo, txRepo, walletRepo } from '../infrastructure/db/repositories';
import {
  TransactionNotFoundError,
  ValidationError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../domain/errors';
import { WalletBalanceChanged } from '../domain/events';
import { OutboxMessage } from '../domain/messaging';
import { Money, MoneyProps } from '../domain/money';
import { Wallet } from '../domain/wallet';
import type { FailureCode } from '../domain/failure-code';
import type { WagerTransactionStatus } from '../domain/wager-transaction';
import { WagerTransaction } from '../domain/wager-transaction';
import { log } from '../shared/logger';
import { metrics } from '../shared/metrics';
import { uuidv7 } from '../shared/util';

@Injectable()
export class WalletService {
  constructor(@Inject(Database) private readonly db: Database) {}

  /** Wallet + OPENING transaction + CREDIT ledger entry + outbox event: one SQL transaction. */
  async create(playerId: unknown, initial: MoneyProps) {
    if (typeof playerId !== 'string' || playerId.length === 0 || playerId.length > 200) {
      throw new ValidationError('"playerId" must be a non-empty string');
    }
    const initialBalance = Money.from(initial);
    const now = new Date();
    const walletId = uuidv7();
    const openingTxId = uuidv7();
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId,
      initialBalance,
      openingTransactionId: openingTxId,
      openingEntryId: uuidv7(),
      now,
    });

    await this.db.transaction(async (q) => {
      if (!(await walletRepo.insert(q, wallet))) throw new WalletAlreadyExistsError();
      if (openingEntry) {
        const opening = WagerTransaction.opening({ id: openingTxId, walletId, playerId, money: initialBalance, now });
        await txRepo.insert(q, opening, walletId);
        await ledgerRepo.insert(q, openingEntry);
        const ev = WalletBalanceChanged.from(wallet, openingEntry, {
          eventId: uuidv7(),
          correlationId: walletId,
          causationId: openingTxId,
          occurredAt: now,
        });
        await outboxRepo.insert(q, OutboxMessage.enqueue(ev));
      }
    });
    log.info('wallet created', { walletId });
    return this.view(wallet);
  }

  async get(walletId: string) {
    const w = await walletRepo.findById(this.db, walletId);
    if (!w) throw new WalletNotFoundError(walletId);
    return this.view(w);
  }

  async ledger(walletId: string, cursor: string | undefined, limitRaw: string | undefined) {
    const limit = limitRaw === undefined ? 50 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ValidationError('limit must be 1..200');
    let after = '0';
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s?: string };
        if (typeof decoded.s !== 'string' || !/^\d+$/.test(decoded.s)) throw new Error('bad cursor');
        after = decoded.s;
      } catch {
        throw new ValidationError('invalid cursor', 'INVALID_CURSOR');
      }
    }
    if (!(await walletRepo.findById(this.db, walletId))) throw new WalletNotFoundError(walletId);
    const page = await ledgerRepo.page(this.db, walletId, after, limit);
    const last = page.items[page.items.length - 1];
    return {
      items: page.items.map(({ entry: e }) => ({
        id: e.id,
        transactionId: e.transactionId,
        direction: e.direction,
        money: e.money.toJSON(),
        balanceBefore: e.balanceBefore.toJSON(),
        balanceAfter: e.balanceAfter.toJSON(),
        createdAt: e.createdAt.toISOString(),
      })),
      nextCursor: page.hasMore && last ? Buffer.from(JSON.stringify({ s: last.seq })).toString('base64url') : null,
    };
  }

  /** Never "fixes" anything: reports, logs and counts divergences. */
  async reconcile(walletId: string) {
    const r = await ledgerRepo.reconcile(this.db, walletId);
    if (!r) throw new WalletNotFoundError(walletId);
    const stored = Money.from({ amount: r.stored, currency: r.currency });
    const calculated = Money.from({ amount: r.calculated, currency: r.currency });
    const difference = stored.subtract(calculated);
    const consistent = difference.isZero();
    if (!consistent) {
      metrics.reconciliationDivergences.inc();
      log.error('wallet reconciliation divergence', { walletId, checkedEntries: r.entries });
    }
    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: Number(r.entries),
    };
  }

  async transactionById(id: string) {
    const t = await txRepo.findById(this.db, id);
    if (!t) throw new TransactionNotFoundError();
    return this.txView(t);
  }

  async transactionByProvider(providerId: string, externalId: string) {
    const t = await txRepo.findByProviderExternal(this.db, providerId, externalId);
    if (!t) throw new TransactionNotFoundError();
    return this.txView(t);
  }

  private view(w: Wallet) {
    return { id: w.id, playerId: w.playerId, balance: w.balance.toJSON(), version: w.version };
  }

  private txView(t: WagerTransaction) {
    return {
      transactionId: t.id,
      providerId: t.providerId,
      externalTransactionId: t.externalTransactionId,
      walletId: t.walletId,
      playerId: t.playerId,
      roundId: t.roundId,
      kind: t.kind,
      money: t.money.toJSON(),
      status: t.status as `${WagerTransactionStatus}`,
      failureCode: (t.failureCode ?? null) as `${FailureCode}` | null,
      referenceTransactionId: t.referenceTransactionId ?? null,
      balance: t.balanceAfter?.toJSON() ?? null,
      attempts: t.attempts,
      createdAt: t.createdAt.toISOString(),
      processedAt: t.processedAt?.toISOString() ?? null,
    };
  }
}
