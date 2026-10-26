export interface BackoffPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * Exponential backoff without jitter: base * 2^(attempt - 1), capped at maxDelayMs.
 * `attempt` is the number of attempts already made (1 for the first retry).
 */
export function exponentialBackoffMs(policy: BackoffPolicy, attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  // Clamp the exponent so the multiplication stays well inside safe integer range.
  const delay = policy.baseDelayMs * 2 ** Math.min(exponent, 30);
  return Math.min(delay, policy.maxDelayMs);
}
