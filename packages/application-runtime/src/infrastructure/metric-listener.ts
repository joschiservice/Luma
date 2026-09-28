import { Client } from 'pg';

/** Owns one dedicated LISTEN connection; reconnection always requests full reconciliation. */
export function createMetricListener(databaseUrl: string) {
  const subscribers = new Map<
    string,
    Set<(event: { connected: boolean }) => void>
  >();
  let client: Client | undefined;
  let connected = false;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let delay = 100;
  const wake = (tenantId?: string) => {
    for (const [id, callbacks] of subscribers) {
      if (tenantId && tenantId !== id) continue;
      for (const callback of callbacks) callback({ connected });
    }
  };
  const connect = async () => {
    if (stopped) return;
    const current = new Client({
      connectionString: databaseUrl,
      application_name: 'luma-metric-listener',
      connectionTimeoutMillis: 3000,
      keepAlive: true,
    });
    client = current;
    let failed = false;
    const disconnect = () => {
      if (failed || stopped) return;
      failed = true;
      connected = false;
      wake();
      void current.end().catch(() => {
        /* The failed connection is already being replaced or closed. */
      });
      retry = setTimeout(() => void connect(), delay);
      retry.unref();
      delay = Math.min(delay * 2, 10000);
    };
    current.on('error', disconnect);
    current.on('end', disconnect);
    current.on('notification', (message) => {
      if (
        message.channel !== 'luma_metrics' ||
        !message.payload ||
        failed ||
        stopped
      )
        return;
      if (/^[0-9a-f-]{36}$/.test(message.payload)) wake(message.payload);
    });
    try {
      await current.connect();
      await current.query('LISTEN luma_metrics');
      if (stopped || failed) {
        await current.end().catch(() => {
          /* The failed connection is already being replaced or closed. */
        });

        return;
      }
      connected = true;
      delay = 100;
      wake();
    } catch {
      disconnect();
    }
  };
  void connect();

  return {
    get connected() {
      return connected;
    },
    subscribe(
      tenantId: string,
      callback: (event: { connected: boolean }) => void,
    ) {
      const entries = subscribers.get(tenantId) ?? new Set();
      entries.add(callback);
      subscribers.set(tenantId, entries);

      return () => {
        entries.delete(callback);
        if (!entries.size) subscribers.delete(tenantId);
      };
    },
    async close() {
      stopped = true;
      connected = false;
      clearTimeout(retry);
      subscribers.clear();
      await client?.end().catch(() => {
        /* The failed connection is already being replaced or closed. */
      });
    },
  };
}
