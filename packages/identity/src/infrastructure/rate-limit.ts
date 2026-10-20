import { createHash } from 'node:crypto';

import type { AtomicStore } from '@luma/platform';
import type { BetterAuthOptions } from 'better-auth';

type RateLimitStorage = NonNullable<
  NonNullable<BetterAuthOptions['rateLimit']>['customStorage']
>;

type Rule = { window: number; max: number };

// Counts one request in a fixed window that starts with the first request.
const consumeScript = `local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if count == 1 or ttl < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {count, ttl}`;

const maxMemoryEntries = 10_000;

/** The requests counted in a key's current window and the seconds until it resets. */
export interface WindowCount {
  count: number;
  resetIn: number;
}

/** Counts requests in this process only, in fixed windows. */
function memoryCounter() {
  const entries = new Map<string, { count: number; resetAt: number }>();

  return (key: string, rule: Rule): WindowCount => {
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
 * Counts one request per call in fixed windows kept in Valkey, so every API instance shares
 * them, and in process memory when no store is configured. Keys hold a hash of the given key,
 * never the key itself. When Valkey is unreachable a request is counted in memory instead, so
 * an outage weakens limits to per-instance ones rather than refusing every request.
 */
export function createRequestCounter(store?: AtomicStore) {
  const memory = memoryCounter();

  return async (key: string, rule: Rule): Promise<WindowCount> => {
    if (!store) return memory(key, rule);
    const hashed = `luma:auth-rate:${createHash('sha256').update(key).digest('hex')}`;
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

/**
 * Stores auth rate-limit counters through `createRequestCounter`. Keys hold a hash of the
 * client address and path, never the address itself.
 */
export function createRateLimitStorage(store?: AtomicStore): RateLimitStorage {
  const count = createRequestCounter(store);

  return {
    async consume(key, rule) {
      const window = await count(key, rule);

      return window.count <= rule.max
        ? { allowed: true, retryAfter: null }
        : { allowed: false, retryAfter: window.resetIn };
    },
  };
}
