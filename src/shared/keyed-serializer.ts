/**
 * Runs tasks that share a key one at a time inside this process, while different keys run in
 * parallel. It is a resource optimization, not a consistency mechanism: correctness across
 * instances still comes from the database row lock.
 */
export class KeyedSerializer {
  private readonly tails = new Map<string, Promise<void>>();
  private waitingCount = 0;

  /** Tasks currently queued behind another task with the same key. */
  get waiting(): number {
    return this.waitingCount;
  }

  get activeKeys(): number {
    return this.tails.size;
  }

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key);
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous ? previous.then(() => current) : current;
    this.tails.set(key, tail);
    try {
      if (previous) {
        this.waitingCount += 1;
        try {
          await previous;
        } finally {
          this.waitingCount -= 1;
        }
      }
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}
