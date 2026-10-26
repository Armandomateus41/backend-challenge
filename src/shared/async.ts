/** Resolves after `ms`, or earlier (without rejecting) when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Resolves with the promise result, or with `undefined` once `ms` elapses. */
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs `tick` repeatedly until stopped. When a tick reports no work, the loop waits
 * `idleDelayMs` before the next one. `stop()` waits for the tick in progress to finish.
 */
export class PollingLoop {
  private readonly controller = new AbortController();
  private running: Promise<void> | undefined;

  constructor(
    private readonly name: string,
    private readonly tick: () => Promise<boolean>,
    private readonly idleDelayMs: number,
    private readonly onError: (name: string, error: unknown) => void,
  ) {}

  start(): void {
    if (!this.running) {
      this.running = this.run();
    }
  }

  async stop(): Promise<void> {
    this.controller.abort();
    await this.running;
  }

  private async run(): Promise<void> {
    const { signal } = this.controller;
    while (!signal.aborted) {
      let hadWork = false;
      try {
        hadWork = await this.tick();
      } catch (error) {
        this.onError(this.name, error);
      }
      if (!hadWork) {
        await sleep(this.idleDelayMs, signal);
      }
    }
  }
}
