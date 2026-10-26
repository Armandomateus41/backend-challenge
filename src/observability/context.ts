import { AsyncLocalStorage } from 'node:async_hooks';

/** Identifiers attached to every log line emitted while handling a request or message. */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export function runWithContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...context }, fn);
}

export function currentContext(): LogContext {
  return storage.getStore() ?? {};
}

/** Adds identifiers discovered during handling (e.g. the transaction id) to the active context. */
export function enrichContext(values: LogContext): void {
  const store = storage.getStore();
  if (store) {
    Object.assign(store, values);
  }
}
