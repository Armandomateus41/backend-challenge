/**
 * HTTP load test against a running instance (default: the Docker Compose api on :8080).
 *
 *   LOAD_BASE_URL   target (default http://localhost:8080)
 *   LOAD_REQUESTS   total wager requests (default 5000)
 *   LOAD_CONCURRENCY concurrent clients (default 50)
 *   LOAD_WALLETS    wallets in the pool (default 100)
 *   LOAD_HOT_SHARE  share of requests aimed at a single hot wallet (default 0.2)
 *
 * Every request uses a unique idempotency key; 5% are immediately re-sent to measure replays.
 * After the run, every wallet is reconciled and the outbox lag is read from /metrics.
 */
const baseUrl = process.env.LOAD_BASE_URL ?? 'http://localhost:8080';
const totalRequests = Number(process.env.LOAD_REQUESTS ?? 5000);
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? 50);
const walletCount = Number(process.env.LOAD_WALLETS ?? 100);
const hotShare = Number(process.env.LOAD_HOT_SHARE ?? 0.2);

interface Wallet {
  id: string;
  playerId: string;
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function metricValue(name: string): Promise<number> {
  const text = await (await fetch(`${baseUrl}/metrics`)).text();
  return text
    .split('\n')
    .filter((line) => line.startsWith(name) && !line.startsWith('#'))
    .reduce((sum, line) => sum + Number(line.split(' ').at(-1)), 0);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

const runId = Date.now().toString(36);
const wallets: Wallet[] = [];
for (let i = 0; i < walletCount; i++) {
  const { body } = await post('/wallets', {
    playerId: `load-${runId}-${i}`,
    initialBalance: { amount: '1000000.00', currency: 'BRL' },
  });
  wallets.push({ id: String(body.id), playerId: String(body.playerId) });
}
const hot = wallets[0]!;

const lockConflictsBefore = await metricValue('wagering_lock_conflicts_total');
const latencies: number[] = [];
const statuses = new Map<number, number>();
let replays = 0;
let next = 0;

async function client(): Promise<void> {
  while (next < totalRequests) {
    const index = next++;
    const wallet = Math.random() < hotShare ? hot : wallets[index % wallets.length]!;
    const externalTransactionId = `load-${runId}-${index}`;
    const payload = {
      providerId: 'load-provider',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${index}`,
      gameId: 'load-game',
      kind: index % 3 === 0 ? 'WIN' : 'BET',
      money: { amount: '1.00', currency: 'BRL' },
    };
    const headers = { 'Idempotency-Key': `load-provider:${externalTransactionId}` };
    const started = performance.now();
    const response = await post('/wagering/transactions', payload, headers);
    latencies.push(performance.now() - started);
    statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
    if (index % 20 === 0) {
      const replay = await post('/wagering/transactions', payload, headers);
      if (replay.body.idempotentReplay === true) replays++;
    }
  }
}

const startedAt = performance.now();
await Promise.all(Array.from({ length: concurrency }, () => client()));
const elapsedSeconds = (performance.now() - startedAt) / 1000;

const sorted = [...latencies].sort((a, b) => a - b);
const errors = [...statuses.entries()]
  .filter(([status]) => status >= 500)
  .reduce((sum, [, count]) => sum + count, 0);

let inconsistent = 0;
for (const wallet of wallets) {
  const { body } = await post(`/wallets/${wallet.id}/reconciliation`, {});
  if (body.consistent !== true) inconsistent++;
}

const report = {
  target: baseUrl,
  requests: totalRequests,
  concurrency,
  wallets: walletCount,
  hotWalletShare: hotShare,
  elapsedSeconds: Number(elapsedSeconds.toFixed(2)),
  throughputRps: Number((totalRequests / elapsedSeconds).toFixed(1)),
  latencyMs: {
    p50: Number(percentile(sorted, 50).toFixed(1)),
    p95: Number(percentile(sorted, 95).toFixed(1)),
    p99: Number(percentile(sorted, 99).toFixed(1)),
    max: Number((sorted.at(-1) ?? 0).toFixed(1)),
  },
  statusCodes: Object.fromEntries(statuses),
  errorRate: Number((errors / totalRequests).toFixed(4)),
  idempotentReplaysConfirmed: replays,
  lockConflictsDuringRun:
    (await metricValue('wagering_lock_conflicts_total')) - lockConflictsBefore,
  outboxLagSecondsAtEnd: await metricValue('wagering_outbox_lag_seconds'),
  outboxPendingAtEnd: await metricValue('wagering_outbox_pending_messages'),
  walletsReconciled: walletCount,
  walletsInconsistent: inconsistent,
};
console.log(JSON.stringify(report, null, 2));
process.exit(inconsistent === 0 && errors === 0 ? 0 : 1);

export {};
