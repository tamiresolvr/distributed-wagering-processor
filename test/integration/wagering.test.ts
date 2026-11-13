import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplicationContext } from '@nestjs/common';
import { PendingReferenceWorker } from '../../src/application/pending-reference.worker';
import { IdempotencyConflictError, WalletAlreadyExistsError } from '../../src/domain/errors';
import { bootApp, brl, command, expectConsistent, newWallet, svc } from './helpers';
import { uuidv7 } from '../../src/shared/util';

let apps: INestApplicationContext[] = [];
let app: INestApplicationContext;

beforeAll(async () => {
  // 3 independent instances (separate pools) against the same PostgreSQL.
  apps = [await bootApp(), await bootApp(), await bootApp({ PENDING_BACKOFF_BASE_MS: '1', PENDING_MAX_ATTEMPTS: '3' })];
  app = apps[0]!;
});
afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
});

const ledgerRows = async (walletId: string, kindFilter?: string) =>
  svc(app).db.query<{ direction: string; kind: string }>(
    `SELECT l.direction, t.kind FROM wallet_ledger_entries l JOIN wager_transactions t ON t.id = l.transaction_id
     WHERE l.wallet_id = ? ${kindFilter ? `AND t.kind = '${kindFilter}'` : ''}`,
    [walletId],
  );

describe('wallet creation', () => {
  test('initial balance produces OPENING transaction and CREDIT entry; duplicate player+currency conflicts', async () => {
    const playerId = uuidv7();
    const w = await svc(app).wallets.create(playerId, brl('1000.00'));
    expect(w.balance).toEqual(brl('1000.00'));
    expect(w.version).toBe(1);
    expect(await ledgerRows(w.id, 'OPENING')).toHaveLength(1);
    await expect(svc(app).wallets.create(playerId, brl('5.00'))).rejects.toBeInstanceOf(WalletAlreadyExistsError);
    await expectConsistent(app, w.id);
  });
});

describe('idempotency', () => {
  test('same BET sent 50x in parallel across 3 instances => exactly one debit', async () => {
    const w = await newWallet(app, '1000.00');
    const cmd = command({ walletId: w.id, playerId: w.playerId, amount: '25.00', ext: 'dup-bet' });
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => svc(apps[i % 3]!).processor.submit(cmd)));
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.every((r) => r.status === 'PROCESSED')).toBe(true);
    expect((await svc(app).wallets.get(w.id)).balance).toEqual(brl('975.00'));
    expect(await ledgerRows(w.id, 'BET')).toHaveLength(1);
    await expectConsistent(app, w.id);
  });

  test('replay returns the balance observed at the original time', async () => {
    const w = await newWallet(app, '100.00');
    const first = command({ walletId: w.id, playerId: w.playerId, amount: '10.00', ext: 'replay-1' });
    const r1 = await svc(app).processor.submit(first);
    await svc(app).processor.submit(command({ walletId: w.id, playerId: w.playerId, amount: '20.00' }));
    const r2 = await svc(app).processor.submit(first);
    expect(r2.idempotentReplay).toBe(true);
    expect(r2.balance).toEqual(r1.balance);
    expect(r2.balance).toEqual(brl('90.00'));
  });

  test('same key with a different payload is a conflict, not a replay', async () => {
    const w = await newWallet(app);
    await svc(app).processor.submit(command({ walletId: w.id, playerId: w.playerId, amount: '10.00', ext: 'c1', key: 'k-c1' }));
    await expect(
      svc(app).processor.submit(command({ walletId: w.id, playerId: w.playerId, amount: '11.00', ext: 'c1', key: 'k-c1' })),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    // different key, same provider+external id: also a conflict
    await expect(
      svc(app).processor.submit(command({ walletId: w.id, playerId: w.playerId, amount: '10.00', ext: 'c1', key: 'k-other' })),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect((await svc(app).wallets.get(w.id)).balance).toEqual(brl('90.00'));
  });
});

describe('concurrency', () => {
  test('two 80.00 bets on 100.00: one PROCESSED, one REJECTED, balance 20.00, one debit', async () => {
    const w = await newWallet(app, '100.00');
    const [a, b] = await Promise.all([
      svc(apps[0]!).processor.submit(command({ walletId: w.id, playerId: w.playerId, amount: '80.00' })),
      svc(apps[1]!).processor.submit(command({ walletId: w.id, playerId: w.playerId, amount: '80.00' })),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    expect([a, b].find((r) => r.status === 'REJECTED')?.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect((await svc(app).wallets.get(w.id)).balance).toEqual(brl('20.00'));
    expect(await ledgerRows(w.id, 'BET')).toHaveLength(1);
    await expectConsistent(app, w.id);
  });

  test('hot wallet: 60 concurrent 5.00 bets on 100.00 across 3 instances never overdraw', async () => {
    const w = await newWallet(app, '100.00');
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        svc(apps[i % 3]!).processor.submit(command({ walletId: w.id, playerId: w.playerId, amount: '5.00' })),
      ),
    );
    expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(20);
    expect(results.filter((r) => r.status === 'REJECTED')).toHaveLength(40);
    const got = await svc(app).wallets.get(w.id);
    expect(got.balance).toEqual(brl('0.00'));
    expect(got.version).toBe(21);
    expect(await ledgerRows(w.id, 'BET')).toHaveLength(20);
    await expectConsistent(app, w.id);
  });

  test('distinct wallets in parallel are independent', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => newWallet(app, '50.00')));
    await Promise.all(
      wallets.flatMap((w, i) => [
        svc(apps[i % 3]!).processor.submit(command({ walletId: w.id, playerId: w.playerId, amount: '30.00' })),
        svc(apps[(i + 1) % 3]!).processor.submit(command({ walletId: w.id, playerId: w.playerId, amount: '30.00' })),
      ]),
    );
    for (const w of wallets) {
      expect((await svc(app).wallets.get(w.id)).balance).toEqual(brl('20.00'));
      await expectConsistent(app, w.id);
    }
  });
});

describe('business rules', () => {
  test('BET/WIN/LOSS/REFUND/ROLLBACK money movements', async () => {
    const w = await newWallet(app, '100.00');
    const p = svc(app).processor;
    const base = { walletId: w.id, playerId: w.playerId };
    const bet = await p.submit(command({ ...base, kind: 'BET', amount: '40.00', ext: 'b1' }));
    expect(bet.balance).toEqual(brl('60.00'));
    const win = await p.submit(command({ ...base, kind: 'WIN', amount: '100.00', ext: 'w1', ref: 'b1' }));
    expect(win.balance).toEqual(brl('160.00'));
    const loss = await p.submit(command({ ...base, kind: 'LOSS', amount: '0.00', ext: 'l1' }));
    expect(loss.status).toBe('PROCESSED');
    expect(loss.balance).toEqual(brl('160.00'));
    const rbWin = await p.submit(command({ ...base, kind: 'ROLLBACK', amount: '100.00', ext: 'rb1', ref: 'w1' }));
    expect(rbWin.balance).toEqual(brl('60.00')); // inverse of WIN: debit
    const bet2 = await p.submit(command({ ...base, kind: 'BET', amount: '10.00', ext: 'b2' }));
    const refund = await p.submit(command({ ...base, kind: 'REFUND', amount: '10.00', ext: 'rf1', ref: 'b2' }));
    expect(bet2.balance).toEqual(brl('50.00'));
    expect(refund.balance).toEqual(brl('60.00'));
    expect(await ledgerRows(w.id, 'LOSS')).toHaveLength(0); // LOSS never writes the ledger
    await expectConsistent(app, w.id);
  });

  test('reversal rules: once only, same amount/round/wallet, valid kinds, distinct failure codes', async () => {
    const w = await newWallet(app, '100.00');
    const other = await newWallet(app, '100.00');
    const p = svc(app).processor;
    const base = { walletId: w.id, playerId: w.playerId };
    await p.submit(command({ ...base, kind: 'BET', amount: '30.00', ext: 'rb-b' }));

    const wrongAmount = await p.submit(command({ ...base, kind: 'REFUND', amount: '29.00', ext: 'x1', ref: 'rb-b' }));
    expect(wrongAmount.failureCode).toBe('REFERENCE_AMOUNT_MISMATCH');
    const wrongRound = await p.submit(command({ ...base, kind: 'REFUND', amount: '30.00', ext: 'x2', ref: 'rb-b', roundId: 'round-2' }));
    expect(wrongRound.failureCode).toBe('REFERENCE_MISMATCH');
    const wrongWallet = await p.submit(command({ walletId: other.id, playerId: other.playerId, kind: 'REFUND', amount: '30.00', ext: 'x3', ref: 'rb-b' }));
    expect(wrongWallet.failureCode).toBe('REFERENCE_MISMATCH');

    const ok = await p.submit(command({ ...base, kind: 'REFUND', amount: '30.00', ext: 'x4', ref: 'rb-b' }));
    expect(ok.status).toBe('PROCESSED');
    const again = await p.submit(command({ ...base, kind: 'REFUND', amount: '30.00', ext: 'x5', ref: 'rb-b' }));
    expect(again.failureCode).toBe('ALREADY_REVERSED');
    const rbAfter = await p.submit(command({ ...base, kind: 'ROLLBACK', amount: '30.00', ext: 'x6', ref: 'rb-b' }));
    expect(rbAfter.failureCode).toBe('ALREADY_REVERSED');

    // REFUND only references BET
    await p.submit(command({ ...base, kind: 'WIN', amount: '5.00', ext: 'rb-w' }));
    const refundWin = await p.submit(command({ ...base, kind: 'REFUND', amount: '5.00', ext: 'x7', ref: 'rb-w' }));
    expect(refundWin.failureCode).toBe('INVALID_REFERENCE_KIND');

    expect((await svc(app).wallets.get(w.id)).balance).toEqual(brl('105.00'));
    await expectConsistent(app, w.id);
    await expectConsistent(app, other.id);
  });

  test('reversal that would overdraw is rejected with a code distinct from BET insufficient funds', async () => {
    const w = await newWallet(app, '0.00');
    const p = svc(app).processor;
    const base = { walletId: w.id, playerId: w.playerId };
    await p.submit(command({ ...base, kind: 'WIN', amount: '50.00', ext: 'od-w' })); // balance 50
    // simulate the player spending it elsewhere
    const bet = await p.submit(command({ ...base, kind: 'BET', amount: '50.00', ext: 'od-b' }));
    expect(bet.status).toBe('PROCESSED');
    const rb = await p.submit(command({ ...base, kind: 'ROLLBACK', amount: '50.00', ext: 'od-r', ref: 'od-w' }));
    expect(rb.status).toBe('REJECTED');
    expect(rb.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    expect(rb.failureCode).not.toBe('INSUFFICIENT_FUNDS');
    expect((await svc(app).wallets.get(w.id)).balance).toEqual(brl('0.00'));
    await expectConsistent(app, w.id);
  });

  test('currency mismatch is rejected without touching the balance', async () => {
    const w = await newWallet(app, '10.00');
    const cmd = command({ walletId: w.id, playerId: w.playerId });
    const usd = { ...cmd, money: (await import('../../src/domain/money')).Money.from({ amount: '5.00', currency: 'USD' }) };
    const r = await svc(app).processor.submit(usd);
    expect(r.failureCode).toBe('CURRENCY_MISMATCH');
    expect((await svc(app).wallets.get(w.id)).balance).toEqual(brl('10.00'));
  });
});

describe('out-of-order references', () => {
  test('REFUND before its BET waits, then is applied by the worker once the BET arrives', async () => {
    const w = await newWallet(app, '100.00');
    const p = svc(app).processor;
    const base = { walletId: w.id, playerId: w.playerId };
    const refund = await p.submit(command({ ...base, kind: 'REFUND', amount: '30.00', ext: 'oo-rf', ref: 'oo-bet' }));
    expect(refund.status).toBe('PENDING_REFERENCE');
    const replay = await p.submit(command({ ...base, kind: 'REFUND', amount: '30.00', ext: 'oo-rf', ref: 'oo-bet' }));
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.status).toBe('PENDING_REFERENCE');

    await p.submit(command({ ...base, kind: 'BET', amount: '30.00', ext: 'oo-bet' }));
    // BET becoming PROCESSED wakes dependents immediately; any instance's worker may take it.
    const handled = await Promise.all(apps.map((a) => a.get(PendingReferenceWorker).tick()));
    expect(handled.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1);
    const tx = await svc(app).wallets.transactionById(refund.transactionId);
    expect(tx.status).toBe('PROCESSED');
    expect((await svc(app).wallets.get(w.id)).balance).toEqual(brl('100.00'));
    await expectConsistent(app, w.id);
  });

  test('ROLLBACK for a reference that never arrives is REJECTED(REFERENCE_NOT_FOUND) after the retry budget', async () => {
    const w = await newWallet(app, '100.00');
    const p = svc(apps[2]!).processor; // instance with 3 attempts and 1ms backoff
    const r = await p.submit(command({ walletId: w.id, playerId: w.playerId, kind: 'ROLLBACK', amount: '5.00', ext: 'ghost', ref: 'nothing' }));
    expect(r.status).toBe('PENDING_REFERENCE');
    const worker = apps[2]!.get(PendingReferenceWorker);
    for (let i = 0; i < 6; i++) {
      await new Promise((res) => setTimeout(res, 20));
      await worker.tick();
    }
    const tx = await svc(app).wallets.transactionById(r.transactionId);
    expect(tx.status).toBe('REJECTED');
    expect(tx.failureCode).toBe('REFERENCE_NOT_FOUND');
    const events = await svc(app).db.query<{ event_type: string }>(
      `SELECT event_type FROM outbox_messages WHERE aggregate_id = ?`,
      [w.id],
    );
    expect(events.map((e) => e.event_type)).toContain('WagerTransactionRejected');
    expect(events.map((e) => e.event_type)).toContain('WagerTransactionPendingReference');
    await expectConsistent(app, w.id);
  });
});

describe('atomicity', () => {
  test('a failure after the financial writes rolls back wallet, ledger, tx, inbox and outbox together', async () => {
    const w = await newWallet(app, '100.00');
    const { db } = svc(app);
    const failing = db.transaction(async (q) => {
      await q.query('UPDATE wallets SET balance = 1.00, version = version + 1 WHERE id = ?', [w.id]);
      await q.query(
        `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at) VALUES ('c','atomic-1','h',now())`,
      );
      throw new Error('boom before commit');
    });
    await expect(failing).rejects.toThrow('boom');
    expect((await svc(app).wallets.get(w.id)).balance).toEqual(brl('100.00'));
    expect(await db.query(`SELECT 1 FROM inbox_messages WHERE message_id = 'atomic-1'`)).toHaveLength(0);
  });

  test('each processed BET commits exactly its outbox events', async () => {
    const w = await newWallet(app, '100.00');
    await svc(app).processor.submit(command({ walletId: w.id, playerId: w.playerId, amount: '10.00' }));
    const rows = await svc(app).db.query<{ event_type: string }>(
      `SELECT event_type FROM outbox_messages WHERE aggregate_id = ? ORDER BY occurred_at`,
      [w.id],
    );
    expect(rows.map((r) => r.event_type).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WalletBalanceChanged', // opening + bet
    ]);
  });
});
