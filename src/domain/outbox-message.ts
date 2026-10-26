import { type IntegrationEvent } from './events/integration-event';
import { type BackoffPolicy, exponentialBackoffMs } from './shared/backoff';
import { InvariantViolationError } from './shared/errors';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  orderingKey: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | undefined;
  publishedAt: Date | undefined;
  lastError: string | undefined;
}

/**
 * Pending integration event stored in the same SQL transaction as the change that produced it.
 * The id equals the event id, which consumers use to discard duplicate deliveries.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly orderingKey: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
    private _lastError?: string,
    private _retryDelayMs?: number,
  ) {}

  /**
   * New messages have no next attempt time: they are due immediately. Comparing an
   * application-clock timestamp with the database clock would delay them under clock skew.
   */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = JSON.parse(JSON.stringify(event.toJSON())) as Record<string, unknown>;
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.orderingKey(),
      event.eventType,
      payload,
      event.occurredAt,
      0,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.orderingKey,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.lastError,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (!this._nextAttemptAt || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvariantViolationError(`Outbox message ${this.id} already published`);
    }
    this._attempts += 1;
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
    this._retryDelayMs = undefined;
    this._lastError = undefined;
  }

  /** Delay chosen by the last scheduleRetry; persistence anchors it to the database clock. */
  get retryDelayMs(): number | undefined {
    return this._retryDelayMs;
  }

  /** Increments attempts and schedules the next try with exponential backoff. */
  scheduleRetry(now: Date, policy: BackoffPolicy, error?: string): void {
    if (!this.isPending()) {
      throw new InvariantViolationError(`Outbox message ${this.id} already published`);
    }
    this._attempts += 1;
    this._retryDelayMs = exponentialBackoffMs(policy, this._attempts);
    this._nextAttemptAt = new Date(now.getTime() + this._retryDelayMs);
    this._lastError = error;
  }
}
