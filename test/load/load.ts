export {};
/**
 * Load test: `bun run test:load` against already-running instances.
 *   TARGETS=http://localhost:3001,http://localhost:3002,http://localhost:3003
 *   WALLETS=50 REQUESTS=5000 CONCURRENCY=64 HOT_RATIO=0.2
 * Measures client-side latency (p50/p95/p99), throughput, error rate, then scrapes
 * /metrics for lock conflicts and outbox lag and runs reconciliation on every wallet.
 * Results are printed as Markdown, ready to paste into docs/LOAD_TEST.md.
 */
const targets = (process.env.TARGETS ?? 'http://localhost:3001,http://localhost:3002,http://localhost:3003').split(',');
const WALLETS = Number(process.env.WALLETS ?? 50);
const REQUESTS = Number(process.env.REQUESTS ?? 5000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 64);
const HOT_RATIO = Number(process.env.HOT_RATIO ?? 0.2); // share of traffic hitting wallet #0

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

const wallets: { id: string; playerId: string }[] = [];
for (let i = 0; i < WALLETS; i++) {
  const r = await post(targets[0]!, '/wallets', { playerId: crypto.randomUUID(), initialBalance: { amount: '1000000.00', currency: 'BRL' } });
  wallets.push((await r.json()) as { id: string; playerId: string });
}

const latencies: number[] = [];
const statuses = new Map<number, number>();
let next = 0;
const runId = crypto.randomUUID().slice(0, 8);

async function worker() {
  for (;;) {
    const n = next++;
    if (n >= REQUESTS) return;
    const w = Math.random() < HOT_RATIO ? wallets[0]! : wallets[Math.floor(Math.random() * wallets.length)]!;
    const ext = `load-${runId}-${n}`;
    const t0 = performance.now();
    let status = 0;
    try {
      const res = await post(targets[n % targets.length]!, '/wagering/transactions', {
        providerId: 'load', externalTransactionId: ext, playerId: w.playerId, walletId: w.id,
        roundId: `r-${n}`, gameId: 'load', kind: 'BET', money: { amount: '1.00', currency: 'BRL' },
      }, { 'idempotency-key': `load:${ext}` });
      status = res.status;
      await res.arrayBuffer();
    } catch {
      status = 0;
    }
    latencies.push(performance.now() - t0);
    statuses.set(status, (statuses.get(status) ?? 0) + 1);
  }
}

const started = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const seconds = (performance.now() - started) / 1000;

const sorted = [...latencies].sort((a, b) => a - b);
const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!.toFixed(1);
const errors = [...statuses].filter(([s]) => s === 0 || s >= 500).reduce((a, [, c]) => a + c, 0);

let inconsistent = 0;
for (const w of wallets) {
  const rec = (await (await post(targets[0]!, `/wallets/${w.id}/reconciliation`, {})).json()) as { consistent: boolean };
  if (!rec.consistent) inconsistent++;
}

const scrape = async (base: string) => (await fetch(base + '/metrics')).text();
const sum = (text: string, name: string) =>
  text.split('\n').filter((l) => l.startsWith(name) && !l.startsWith('#')).reduce((a, l) => a + Number(l.split(' ').pop()), 0);
let conflicts = 0;
let lag = 0;
for (const t of targets) {
  const m = await scrape(t);
  conflicts += sum(m, 'wager_lock_conflicts_total');
  lag = Math.max(lag, sum(m, 'wager_outbox_lag_seconds'));
}

console.log(`# Load test result
- Date: ${new Date().toISOString()}
- Environment: ${process.platform}/${process.arch}, bun ${Bun.version}, ${targets.length} instance(s), CPUs=${navigator.hardwareConcurrency}
- Method: ${REQUESTS} BET requests, concurrency ${CONCURRENCY}, ${WALLETS} wallets, ${(HOT_RATIO * 100).toFixed(0)}% on a hot wallet; client runs on the same host
- Throughput: ${(REQUESTS / seconds).toFixed(1)} req/s over ${seconds.toFixed(1)}s
- Latency ms: p50=${pct(50)} p95=${pct(95)} p99=${pct(99)}
- Status distribution: ${JSON.stringify(Object.fromEntries(statuses))}
- Error rate (0/5xx): ${((errors / REQUESTS) * 100).toFixed(2)}%
- Concurrency conflicts (retried, summed over instances): ${conflicts}
- Outbox lag at end (max over instances, s): ${lag.toFixed(2)}
- Wallets inconsistent after run: ${inconsistent} / ${WALLETS}
`);
process.exit(inconsistent === 0 ? 0 : 1);
