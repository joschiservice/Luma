import type { AtomicStore } from './atomic-store.js';

/** A fixed counting window: at most `max` requests in `window` seconds. */
export interface CountRule {
  window: number;
  max: number;
}

/** The requests counted in a key's current window and the seconds until it resets. */
interface WindowCount {
  count: number;
  resetIn: number;
}

/** Counts one request for `key` under `rule` and reports its window. */
export type RequestCounter = (
  key: string,
  rule: CountRule,
) => Promise<WindowCount>;

// Counts one request in a fixed window that starts with the first request.
const consumeScript = `local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if count == 1 or ttl < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {count, ttl}`;

const maxMemoryEntries = 10_000;

/** Counts requests in this process only, in fixed windows. */
function memoryCounter() {
  const entries = new Map<string, { count: number; resetAt: number }>();

  return (key: string, rule: CountRule): WindowCount => {
    const now = Date.now();
    if (entries.size >= maxMemoryEntries)
      for (const [stored, entry] of entries)
        if (entry.resetAt <= now) entries.delete(stored);
    // A flood of distinct keys must not grow memory without bound; the oldest windows go first.
    while (entries.size >= maxMemoryEntries)
      entries.delete(entries.keys().next().value!);
    let entry = entries.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + rule.window * 1000 };
      entries.set(key, entry);
    }
    entry.count++;

    return {
      count: entry.count,
      resetIn: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  };
}

/**
 * Counts one request per call in fixed windows kept in Valkey under `prefix`, so every instance
 * shares them, and in process memory when no store is configured. Keys hold a hash of the given
 * key, never the key itself. When Valkey is unreachable a request is counted in memory instead,
 * so an outage weakens limits to per-instance ones rather than refusing every request.
 */
export function createRequestCounter(
  store: AtomicStore | undefined,
  prefix: string,
) {
  const memory = memoryCounter();

  return async (key: string, rule: CountRule): Promise<WindowCount> => {
    if (!store) return memory(key, rule);
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(key),
    );
    const hex = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    const hashed = `${prefix}:${hex}`;
    try {
      const result = await store.run(consumeScript, hashed, [
        String(rule.window),
      ]);
      if (!Array.isArray(result)) throw new Error('Unexpected result');
      const [count, ttl] = result.map(Number);
      if (!Number.isFinite(count) || !Number.isFinite(ttl))
        throw new Error('Unexpected result');

      return { count: count!, resetIn: Math.max(1, ttl!) };
    } catch {
      return memory(key, rule);
    }
  };
}
