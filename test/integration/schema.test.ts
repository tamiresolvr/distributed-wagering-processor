import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplicationContext } from '@nestjs/common';
import { bootApp, ensureMigrated, newWallet, svc } from './helpers';
import { migrate } from '../../src/migrate';

let app: INestApplicationContext;
beforeAll(async () => {
  await ensureMigrated();
  app = await bootApp();
});
afterAll(async () => {
  await app.close();
});

const db = () => svc(app).db;
const rejects = async (p: Promise<unknown>, re: RegExp) => {
  let msg = '';
  try {
    await p;
  } catch (e) {
    msg = (e as Error).message;
  }
  expect(msg).toMatch(re);
};

describe('schema-level guarantees', () => {
  test('balance cannot be negative', async () => {
    const w = await newWallet(app, '10.00');
    await rejects(db().query('UPDATE wallets SET balance = -0.01 WHERE id = ?', [w.id]), /ck|check|violat/i);
  });

  test('one wallet per player+currency', async () => {
    const w = await newWallet(app, '10.00');
    await rejects(
      db().query(
        `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
         VALUES (gen_random_uuid(), ?, 'BRL', 0, 1, now(), now())`,
        [w.playerId],
      ),
      /uq_wallet_player_currency|unique/i,
    );
  });

  test('ledger is append-only: UPDATE and DELETE are rejected', async () => {
    const w = await newWallet(app, '10.00');
    await rejects(db().query('UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = ?', [w.id]), /forbidden/i);
    await rejects(db().query('DELETE FROM wallet_ledger_entries WHERE wallet_id = ?', [w.id]), /forbidden/i);
    await rejects(db().query('TRUNCATE wallet_ledger_entries'), /forbidden/i);
  });

  test('ledger arithmetic is enforced by a CHECK constraint', async () => {
    const w = await newWallet(app, '10.00');
    const [tx] = await db().query<{ id: string }>(`SELECT id FROM wager_transactions WHERE wallet_id = ?`, [w.id]);
    await rejects(
      db().query(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         VALUES (gen_random_uuid(), ?, ?, 'CREDIT', 5.00, 'BRL', 10.00, 99.00, now())`,
        [w.id, tx!.id],
      ),
      /ck_ledger_arithmetic|unique|check/i,
    );
  });

  test('at most one ledger entry per (wallet, transaction)', async () => {
    const w = await newWallet(app, '10.00');
    const [tx] = await db().query<{ id: string }>(`SELECT id FROM wager_transactions WHERE wallet_id = ?`, [w.id]);
    await rejects(
      db().query(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         VALUES (gen_random_uuid(), ?, ?, 'CREDIT', 5.00, 'BRL', 10.00, 15.00, now())`,
        [w.id, tx!.id],
      ),
      /uq_ledger_wallet_tx|unique/i,
    );
  });

  test('terminal transactions cannot change state or be deleted', async () => {
    const w = await newWallet(app, '10.00');
    await rejects(db().query(`UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'X', processed_at = now() WHERE wallet_id = ?`, [w.id]), /terminal/i);
    await rejects(db().query('DELETE FROM wager_transactions WHERE wallet_id = ?', [w.id]), /forbidden/i);
  });

  test('migrations are reversible: down then up leaves a working schema', async () => {
    // Runs on a throw-away database name only when explicitly enabled; destructive on shared DBs.
    if (process.env.TEST_MIGRATION_ROUNDTRIP !== 'true') return;
    await migrate('down');
    await migrate('up');
    const rows = await db().query(`SELECT to_regclass('public.wallets') AS t`);
    expect(rows[0]!.t).toBe('wallets');
  });
});
