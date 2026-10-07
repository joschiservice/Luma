import { Client } from 'pg';

type Wakeup = { connected: boolean; topics?: readonly string[] };

const payloadPattern = /^([0-9a-f-]{36})(?::([a-z,]{1,400}))?$/;

/**
 * Owns one dedicated LISTEN connection. Payloads are `tenant` or `tenant:topic,topic`; a wake-up
 * without topics, including every reconnection, asks subscribers to reconcile everything.
 */
export function createMetricListener(databaseUrl: string) {
  const subscribers = new Map<string, Set<(event: Wakeup) => void>>();
  let client: Client | undefined;
  let connected = false;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let delay = 100;
  const wake = (tenantId?: string, topics?: readonly string[]) => {
    for (const [id, callbacks] of subscribers) {
      if (tenantId && tenantId !== id) continue;
      for (const callback of callbacks)
        callback(topics ? { connected, topics } : { connected });
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
      const match = payloadPattern.exec(message.payload);
      if (match)
        wake(
          match[1],
          match[2]?.split(',').filter((topic) => topic !== ''),
        );
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
    subscribe(tenantId: string, callback: (event: Wakeup) => void) {
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
