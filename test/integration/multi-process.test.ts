import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ensureMigrated, waitFor } from './helpers';

declare global {
  interface Response {
    json(): Promise<any>;
  }
}

const PORTS = [3911, 3912, 3913];
const procs = new Map<number, ReturnType<typeof Bun.spawn>>();
const url = (p: number, path: string) => `http://127.0.0.1:${p}${path}`;

function start(port: number) {
  const proc = Bun.spawn(['bun', 'run', 'src/main.ts'], {
    env: { ...process.env, PORT: String(port), LOG_LEVEL: 'silent', CONSUMER_ENABLED: 'true', PUBLISHER_ENABLED: 'true', REPROCESSOR_ENABLED: 'true' },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  procs.set(port, proc);
}

const post = (port: number, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url(port, path), { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

beforeAll(async () => {
  await ensureMigrated();
  PORTS.forEach(start);
  for (const p of PORTS) {
    await waitFor(async () => {
      try {
        return (await fetch(url(p, '/health/ready'))).status === 200;
      } catch {
        return false;
      }
    }, 60_000, 500);
  }
});
afterAll(() => {
  for (const p of procs.values()) p.kill('SIGTERM');
});

const wallet = async (amount = '100.00') => {
  const res = await post(PORTS[0]!, '/wallets', { playerId: crypto.randomUUID(), initialBalance: { amount, currency: 'BRL' } });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; playerId: string };
};
const bet = (w: { id: string; playerId: string }, ext: string, amount = '10.00', extra: Record<string, unknown> = {}) => ({
  providerId: 'provider-mp', externalTransactionId: ext, playerId: w.playerId, walletId: w.id,
  roundId: 'r1', gameId: 'g', kind: 'BET', money: { amount, currency: 'BRL' }, ...extra,
});

describe('3 real processes', () => {
  test('health: live and ready (PostgreSQL + SQS) without auth', async () => {
    expect((await fetch(url(PORTS[0]!, '/health/live'))).status).toBe(200);
    const ready = await (await fetch(url(PORTS[0]!, '/health/ready'))).json();
    expect(ready.checks).toEqual({ postgres: 'up', sqs: 'up' });
  });

  test('HTTP contract: 200 / 202 / 422 / 409 / 400 are distinguishable and consistent', async () => {
    const w = await wallet('50.00');
    const ok = await post(PORTS[0]!, '/wagering/transactions', bet(w, 'h1', '10.00'), { 'idempotency-key': 'provider-mp:h1' });
    expect(ok.status).toBe(200);
    expect((await ok.json()).idempotentReplay).toBe(false);
    const replay = await post(PORTS[1]!, '/wagering/transactions', bet(w, 'h1', '10.00'), { 'idempotency-key': 'provider-mp:h1' });
    expect(replay.status).toBe(200);
    expect((await replay.json()).idempotentReplay).toBe(true);

    const conflict = await post(PORTS[2]!, '/wagering/transactions', bet(w, 'h1', '11.00'), { 'idempotency-key': 'provider-mp:h1' });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe('IDEMPOTENCY_CONFLICT');

    const rejected = await post(PORTS[0]!, '/wagering/transactions', bet(w, 'h2', '999.00'), { 'idempotency-key': 'provider-mp:h2' });
    expect(rejected.status).toBe(422);
    expect((await rejected.json()).failureCode).toBe('INSUFFICIENT_FUNDS');

    const pending = await post(PORTS[0]!, '/wagering/transactions', bet(w, 'h3', '10.00', { kind: 'REFUND', referenceExternalTransactionId: 'nope' }), { 'idempotency-key': 'provider-mp:h3' });
    expect(pending.status).toBe(202);

    const noKey = await post(PORTS[0]!, '/wagering/transactions', bet(w, 'h4'));
    expect(noKey.status).toBe(400);
    const badMoney = await post(PORTS[0]!, '/wagering/transactions', bet(w, 'h5', '1e3'), { 'idempotency-key': 'k5' });
    expect(badMoney.status).toBe(400);
    const opening = await post(PORTS[0]!, '/wagering/transactions', bet(w, 'h6', '1.00', { kind: 'OPENING' }), { 'idempotency-key': 'k6' });
    expect(opening.status).toBe(400);

    const dup = await post(PORTS[0]!, '/wallets', { playerId: w.playerId, initialBalance: { amount: '1.00', currency: 'BRL' } });
    expect(dup.status).toBe(409);
    const q = await (await fetch(url(PORTS[1]!, `/providers/provider-mp/wagering/transactions/h1`))).json();
    expect(q.status).toBe('PROCESSED');
  });

  test('parallel bets across 3 processes + SIGKILL/restart of one: consistent final state, outbox drains', async () => {
    const w = await wallet('100.00');
    const fire = (i: number) =>
      post(PORTS[i % 3]!, '/wagering/transactions', bet(w, `mp-${i}`, '10.00'), { 'idempotency-key': `provider-mp:mp-${i}` })
        .then((r) => r.status)
        .catch(() => 0);
    const first = Promise.all(Array.from({ length: 30 }, (_, i) => fire(i)));
    procs.get(PORTS[2]!)!.kill('SIGKILL'); // hard crash mid-flight
    await first;
    start(PORTS[2]!); // restart
    await waitFor(async () => (await fetch(url(PORTS[2]!, '/health/ready')).catch(() => ({ status: 0 }))).status === 200, 60_000, 500);

    // provider retries everything with the same keys (at-least-once)
    const retried = await Promise.all(Array.from({ length: 30 }, (_, i) => post(PORTS[i % 2]!, '/wagering/transactions', bet(w, `mp-${i}`, '10.00'), { 'idempotency-key': `provider-mp:mp-${i}` }).then((r) => r.status)));
    expect(retried.every((s) => s === 200 || s === 422)).toBe(true);

    const rec = await (await post(PORTS[0]!, `/wallets/${w.id}/reconciliation`, {})).json();
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.amount).toBe('0.00'); // exactly 10 x 10.00 debited
    expect(rec.checkedEntries).toBe(11); // opening + 10 bets

    const ledger = await (await fetch(url(PORTS[1]!, `/wallets/${w.id}/ledger?limit=4`))).json();
    expect(ledger.items).toHaveLength(4);
    const page2 = await (await fetch(url(PORTS[1]!, `/wallets/${w.id}/ledger?limit=100&cursor=${ledger.nextCursor}`))).json();
    expect(page2.items).toHaveLength(7);
    expect(page2.nextCursor).toBeNull();

    const metricsText = await (await fetch(url(PORTS[0]!, '/metrics'))).text();
    expect(metricsText).toContain('wager_outbox_lag_seconds');
    expect(metricsText).toContain('wager_transactions_total');
  });
});
