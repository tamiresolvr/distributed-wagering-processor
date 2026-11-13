import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplicationContext } from '@nestjs/common';
import { OutboxPublisher } from '../../src/infrastructure/sqs/outbox.publisher';
import { SqsGateway } from '../../src/infrastructure/sqs/sqs.gateway';
import { WagerConsumer, CONSUMER_NAME } from '../../src/infrastructure/sqs/wager.consumer';
import { bootApp, command, expectConsistent, newWallet, svc, waitFor, brl } from './helpers';
import { uuidv7 } from '../../src/shared/util';

let a: INestApplicationContext;
let b: INestApplicationContext;
let consumerApp: INestApplicationContext;

beforeAll(async () => {
  [a, b] = [await bootApp(), await bootApp()];
  consumerApp = await bootApp(); // consumer is started explicitly by tests
});
afterAll(async () => {
  await Promise.all([a, b, consumerApp].map((x) => x.close()));
});

const pendingOutbox = (walletId: string) =>
  svc(a).db.query<{ id: string; published_at: Date | null; attempts: number }>(
    `SELECT id, published_at, attempts FROM outbox_messages WHERE aggregate_id = ?`,
    [walletId],
  );

describe('transactional outbox', () => {
  test('commit -> process dies before publish -> another instance publishes -> duplicates are harmless', async () => {
    const w = await newWallet(a, '100.00');
    await svc(a).processor.submit(command({ walletId: w.id, playerId: w.playerId, amount: '10.00' }));
    // "instance A died after COMMIT": events exist, nothing published.
    const before = await pendingOutbox(w.id);
    expect(before.length).toBe(3);
    expect(before.every((r) => r.published_at === null)).toBe(true);

    // Two publishers race over the same outbox; count every send per eventId.
    const sent = new Map<string, number>();
    for (const app of [a, b]) {
      const gw = app.get(SqsGateway);
      const original = gw.send.bind(gw);
      gw.send = async (url, body, group, dedup, attrs) => {
        if (group === w.id) sent.set(dedup, (sent.get(dedup) ?? 0) + 1);
        return original(url, body, group, dedup, attrs);
      };
    }
    await Promise.all([a.get(OutboxPublisher).tick(), b.get(OutboxPublisher).tick(), a.get(OutboxPublisher).tick()]);
    await waitFor(async () => {
      await b.get(OutboxPublisher).tick();
      return (await pendingOutbox(w.id)).every((r) => r.published_at !== null);
    });
    expect(sent.size).toBe(3);
    for (const n of sent.values()) expect(n).toBe(1); // SKIP LOCKED => no double publication

    // The events really are on the queue, deduplicated by FIFO dedup id = eventId.
    const urls = await a.get(SqsGateway).urls();
    const gw = a.get(SqsGateway);
    const types: string[] = [];
    await waitFor(async () => {
      for (const m of await gw.receive(urls.events, 10, 1)) {
        const env = JSON.parse(m.Body!);
        if (env.aggregateId === w.id) types.push(env.eventType);
        await gw.delete(urls.events, m.ReceiptHandle!);
      }
      return types.length >= 3;
    });
    expect(types.sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged', 'WalletBalanceChanged']);
  });

  test('publish failure schedules a retry with backoff instead of losing the event', async () => {
    const w = await newWallet(a, '10.00');
    const gw = a.get(SqsGateway);
    const original = gw.send.bind(gw);
    gw.send = async (...args) => {
      if (args[2] === w.id) throw new Error('sqs down');
      return original(...args);
    };
    await a.get(OutboxPublisher).tick();
    const rows = await pendingOutbox(w.id);
    expect(rows[0]!.published_at).toBeNull();
    expect(rows[0]!.attempts).toBe(1);
    gw.send = original;
  });
});

describe('SQS consumer', () => {
  const send = async (body: unknown, dedup = uuidv7(), group = 'g') => {
    const gw = consumerApp.get(SqsGateway);
    const urls = await gw.urls();
    await gw.send(urls.main, typeof body === 'string' ? body : JSON.stringify(body), group, dedup);
  };
  const message = (w: { id: string; playerId: string }, messageId: string, ext: string, amount = '25.00') => ({
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-q',
      externalTransactionId: ext,
      idempotencyKey: `provider-q:${ext}`,
      playerId: w.playerId,
      walletId: w.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: brl(amount),
    },
  });

  test('redelivery (same messageId, distinct SQS dedup ids) debits once; inbox has one row', async () => {
    const w = await newWallet(a, '100.00');
    const msg = message(w, `msg-${uuidv7()}`, `q-${uuidv7()}`);
    const consumer = consumerApp.get(WagerConsumer);
    consumer.start();
    try {
      await send(msg, 'd1', w.id);
      await send(msg, 'd2', w.id);
      await send(msg, 'd3', w.id);
      await waitFor(async () => (await svc(a).wallets.get(w.id)).balance.amount === '75.00');
      await new Promise((r) => setTimeout(r, 3000)); // let duplicates drain
    } finally {
      await consumer.stop();
    }
    expect((await svc(a).wallets.get(w.id)).balance).toEqual(brl('75.00'));
    const inbox = await svc(a).db.query(`SELECT 1 FROM inbox_messages WHERE consumer_name = ? AND message_id = ?`, [
      CONSUMER_NAME,
      msg.messageId,
    ]);
    expect(inbox).toHaveLength(1);
    await expectConsistent(a, w.id);
  });

  test('worker dies after COMMIT and before ACK: redelivered message produces no second effect', async () => {
    const w = await newWallet(a, '100.00');
    const msg = message(w, `msg-${uuidv7()}`, `q-${uuidv7()}`);
    const gw = consumerApp.get(SqsGateway);
    const urls = await gw.urls();
    await send(msg, uuidv7(), w.id);
    // A "worker" receives and processes (COMMIT) but is killed before delete.
    const got = await waitFor(async () => {
      const ms = await gw.receive(urls.main, 10, 1);
      for (const m of ms) {
        if (JSON.parse(m.Body!).messageId === msg.messageId) return m;
        await gw.setVisibility(urls.main, m.ReceiptHandle!, 0);
      }
      return undefined;
    });
    const { parseSubmitCommand } = await import('../../src/application/commands');
    await svc(a).processor.submit(parseSubmitCommand(msg.data, msg.data.idempotencyKey, 'c'), {
      consumerName: CONSUMER_NAME,
      messageId: msg.messageId,
    });
    await gw.setVisibility(urls.main, got.ReceiptHandle!, 0); // visibility expires => redelivery
    const consumer = consumerApp.get(WagerConsumer);
    consumer.start();
    try {
      await waitFor(async () => {
        const m = await svc(a).db.query(`SELECT 1 FROM outbox_messages WHERE aggregate_id = ?`, [w.id]);
        return m.length >= 3;
      });
      await new Promise((r) => setTimeout(r, 3000));
    } finally {
      await consumer.stop();
    }
    expect((await svc(a).wallets.get(w.id)).balance).toEqual(brl('75.00'));
    await expectConsistent(a, w.id);
  });

  test('malformed message goes to the DLQ; business rejection is acked (not retried, not DLQ)', async () => {
    const w = await newWallet(a, '10.00');
    const broken = `not-json-${uuidv7()}`;
    const rejected = message(w, `msg-${uuidv7()}`, `q-${uuidv7()}`, '500.00'); // insufficient funds
    const consumer = consumerApp.get(WagerConsumer);
    const gw = consumerApp.get(SqsGateway);
    const urls = await gw.urls();
    consumer.start();
    try {
      await send(broken, uuidv7(), 'g-bad');
      await send(rejected, uuidv7(), w.id);
      const dlqBodies: string[] = [];
      await waitFor(async () => {
        for (const m of await gw.receive(urls.dlq, 10, 1)) {
          dlqBodies.push(m.Body!);
          await gw.delete(urls.dlq, m.ReceiptHandle!);
        }
        return dlqBodies.includes(broken);
      });
      const tx = await waitFor(async () => {
        const r = await svc(a).db.query<{ status: string; failure_code: string }>(
          `SELECT status, failure_code FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET'`,
          [w.id],
        );
        return r[0];
      });
      expect(tx).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
      expect(dlqBodies).not.toContain(JSON.stringify(rejected));
    } finally {
      await consumer.stop();
    }
    expect((await svc(a).wallets.get(w.id)).balance).toEqual(brl('10.00'));
  });

  test('graceful shutdown: stop() resolves after in-flight work and leaves no half-applied state', async () => {
    const w = await newWallet(a, '100.00');
    const consumer = consumerApp.get(WagerConsumer);
    consumer.start();
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => send(message(w, `msg-${uuidv7()}`, `q-${uuidv7()}`, '1.00'), uuidv7(), w.id)),
    );
    await new Promise((r) => setTimeout(r, 500));
    await consumer.stop(); // simulates SIGTERM: awaits in-flight batch
    const r = await expectConsistent(a, w.id);
    expect(r.checkedEntries).toBeGreaterThanOrEqual(1);
  });
});
