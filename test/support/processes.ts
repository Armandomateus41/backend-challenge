import { type Subprocess } from 'bun';

/** Asks the OS for a free TCP port. */
export function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = server.port;
  void server.stop(true);
  if (port === undefined) {
    throw new Error('could not allocate a port');
  }
  return port;
}

export interface ChildProcess {
  proc: Subprocess;
  baseUrl?: string;
  /** Forced termination (SIGKILL / TerminateProcess): no shutdown hook runs. */
  kill(): Promise<void>;
}

const childOutput = process.env.TEST_CHILD_LOGS === '1' ? 'inherit' : 'ignore';

export function spawnScript(script: string, env: Record<string, string>): ChildProcess {
  // process.execPath is the bun binary itself: spawning a 'bun' shim would leave the real
  // process running after kill() on Windows.
  const proc = Bun.spawn([process.execPath, script], {
    env: { ...process.env, ...env },
    stdout: childOutput,
    stderr: childOutput,
  });
  return {
    proc,
    kill: async () => {
      proc.kill('SIGKILL');
      await proc.exited;
    },
  };
}

/** Starts `bun src/main.ts` as a separate OS process and waits until it is ready. */
export async function spawnApp(
  env: Record<string, string>,
): Promise<ChildProcess & { baseUrl: string }> {
  const port = freePort();
  const child = spawnScript('src/main.ts', { ...env, HTTP_PORT: String(port) });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.proc.exitCode !== null) {
      throw new Error(`app process exited early with code ${child.proc.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      if (response.status === 200) {
        return { ...child, baseUrl };
      }
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(200);
  }
  await child.kill();
  throw new Error('app process did not become ready');
}
