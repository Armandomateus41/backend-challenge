import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** Prometheus metrics exposed on GET /metrics. One registry per process. */
export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

export const metrics = {
  transactions: new Counter({
    name: 'wagering_transactions_total',
    help: 'Wager transactions settled, by resulting status, kind and entry point',
    labelNames: ['status', 'kind', 'source'] as const,
    registers: [metricsRegistry],
  }),
  duplicates: new Counter({
    name: 'wagering_duplicates_total',
    help: 'Duplicates detected: idempotent replays and inbox redeliveries',
    labelNames: ['type', 'source'] as const,
    registers: [metricsRegistry],
  }),
  idempotencyConflicts: new Counter({
    name: 'wagering_idempotency_conflicts_total',
    help: 'Idempotency keys reused with a different payload',
    labelNames: ['source'] as const,
    registers: [metricsRegistry],
  }),
  retries: new Counter({
    name: 'wagering_retries_total',
    help: 'Retries scheduled, by operation',
    labelNames: ['operation'] as const,
    registers: [metricsRegistry],
  }),
  dlqMessages: new Counter({
    name: 'wagering_dlq_messages_total',
    help: 'Messages moved to the dead-letter queue, by reason',
    labelNames: ['reason'] as const,
    registers: [metricsRegistry],
  }),
  lockConflicts: new Counter({
    name: 'wagering_lock_conflicts_total',
    help: 'Lock timeouts, deadlocks, serialization failures and concurrent unique-key races',
    labelNames: ['type'] as const,
    registers: [metricsRegistry],
  }),
  outboxPending: new Gauge({
    name: 'wagering_outbox_pending_messages',
    help: 'Outbox messages not yet published',
    registers: [metricsRegistry],
  }),
  outboxLag: new Gauge({
    name: 'wagering_outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox message',
    registers: [metricsRegistry],
  }),
  outboxPublished: new Counter({
    name: 'wagering_outbox_published_total',
    help: 'Outbox messages published',
    labelNames: ['event_type'] as const,
    registers: [metricsRegistry],
  }),
  retentionDeleted: new Counter({
    name: 'wagering_retention_deleted_total',
    help: 'Rows removed by the retention job, by table',
    labelNames: ['table'] as const,
    registers: [metricsRegistry],
  }),
  walletGateQueued: new Gauge({
    name: 'wagering_wallet_gate_queued_requests',
    help: 'Requests waiting in memory behind another request for the same wallet',
    registers: [metricsRegistry],
  }),
  processingDuration: new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'Latency of wager transaction processing, by entry point and outcome',
    labelNames: ['source', 'outcome'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [metricsRegistry],
  }),
  reconciliationMismatches: new Counter({
    name: 'wagering_reconciliation_mismatches_total',
    help: 'Reconciliations where the stored balance differs from the ledger',
    registers: [metricsRegistry],
  }),
  pendingReferenceExpired: new Counter({
    name: 'wagering_pending_reference_expired_total',
    help: 'PENDING_REFERENCE transactions rejected after the resolution window',
    registers: [metricsRegistry],
  }),
};
