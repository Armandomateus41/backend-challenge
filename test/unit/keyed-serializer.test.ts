import { describe, expect, test } from 'bun:test';
import { KeyedSerializer } from '../../src/shared/keyed-serializer';

const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('KeyedSerializer', () => {
  test('runs tasks with the same key one at a time, in arrival order', async () => {
    const serializer = new KeyedSerializer();
    const order: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const task = (name: string) => async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      order.push(`start ${name}`);
      await Bun.sleep(5);
      order.push(`end ${name}`);
      running -= 1;
      return name;
    };
    const results = await Promise.all(
      ['a', 'b', 'c'].map((name) => serializer.run('w1', task(name))),
    );
    expect(results).toEqual(['a', 'b', 'c']);
    expect(maxRunning).toBe(1);
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    expect(serializer.activeKeys).toBe(0);
  });

  test('different keys run in parallel', async () => {
    const serializer = new KeyedSerializer();
    const gate = deferred();
    const first = serializer.run('w1', () => gate.promise);
    let otherDone = false;
    await serializer.run('w2', () => {
      otherDone = true;
      return Promise.resolve();
    });
    expect(otherDone).toBe(true);
    gate.resolve();
    await first;
  });

  test('a failing task releases the key and reports its own error', async () => {
    const serializer = new KeyedSerializer();
    const failing = serializer.run('w1', () => Promise.reject(new Error('boom')));
    const next = serializer.run('w1', () => Promise.resolve('ok'));
    expect(serializer.waiting).toBe(1);
    let failure: unknown;
    try {
      await failing;
    } catch (error) {
      failure = error;
    }
    expect(failure).toHaveProperty('message', 'boom');
    expect(await next).toBe('ok');
    expect(serializer.waiting).toBe(0);
    expect(serializer.activeKeys).toBe(0);
  });
});
