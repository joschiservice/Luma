import { createServer } from 'node:http';

export type HealthState = 'starting' | 'running' | 'stopping';

/**
 * Reports whether a running process is doing its work. A probe that returns false or throws
 * turns a `running` process `unhealthy`.
 */
export type HealthProbe = () => boolean;

/**
 * Reads the optional health listener port from `key`. Unset or empty disables the listener;
 * any other value must be an integer from 1 to 65535.
 */
export function readHealthPort(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
) {
  const value = env[key]?.trim();
  if (!value) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error(`${key} must be an integer from 1 to 65535`);

  return port;
}

/**
 * Serves `GET /health` on all interfaces: 200 while the process reports `running` and its probe,
 * if any, passes; 503 while it is starting, stopping or `unhealthy`. The body carries only the
 * state. Other paths answer 404. Call `close` after shutdown to release the port.
 */
export async function startHealthServer(port: number) {
  let state: HealthState = 'starting';
  let probe: HealthProbe | undefined;
  const report = () => {
    if (state !== 'running' || !probe) return state;
    try {
      return probe() ? state : 'unhealthy';
    } catch {
      return 'unhealthy';
    }
  };
  const server = createServer((request, response) => {
    if (
      (request.method !== 'GET' && request.method !== 'HEAD') ||
      request.url?.split('?')[0] !== '/health'
    ) {
      response.writeHead(404).end();

      return;
    }
    const reported = report();
    response
      .writeHead(reported === 'running' ? 200 : 503, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      })
      .end(
        request.method === 'HEAD'
          ? undefined
          : JSON.stringify({ state: reported }),
      );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();

  return {
    /** Bound port, which differs from `port` only when 0 was requested. */
    port: typeof address === 'object' && address ? address.port : port,
    set(next: HealthState) {
      state = next;
    },
    /** Checks `next` on every request while the process is running. */
    watch(next: HealthProbe) {
      probe = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/**
 * Creates the process health reporter. With a port, `listen` starts the health listener;
 * without one, every method does nothing. `close` is safe to call whether or not it listens.
 */
export function createHealth(port: number | undefined) {
  let server: Awaited<ReturnType<typeof startHealthServer>> | undefined;

  return {
    listen: async () => {
      if (port !== undefined) server = await startHealthServer(port);
    },
    set: (state: HealthState) => server?.set(state),
    watch: (probe: HealthProbe) => server?.watch(probe),
    close: async () => server?.close(),
  };
}
