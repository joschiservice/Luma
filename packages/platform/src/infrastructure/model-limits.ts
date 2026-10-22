import { createHash } from 'node:crypto';

import type { AtomicStore } from '../application/atomic-store.js';
import type {
  ModelRequestLimit,
  ModelTokenBudget,
} from '../application/model-gateway.js';
import {
  type CountRule,
  createRequestCounter,
} from '../application/request-counter.js';
import { RateLimitedError } from '../domain/service-error.js';

/** Model-backed requests one person may send in a tenant: ten a minute. */
const modelRequestRule: CountRule = { window: 60, max: 10 };

/**
 * Counts model-backed requests per person and tenant under `model:<tenant>:<actor>`, in the
 * shared Valkey windows of `createRequestCounter`. Without a store, or while it is unreachable,
 * each process counts alone.
 */
export function createModelRequestLimit(
  store?: AtomicStore,
  rule: CountRule = modelRequestRule,
): ModelRequestLimit {
  const count = createRequestCounter(store, 'luma:model-rate');

  return async (tenantId, actorId) => {
    const window = await count(`model:${tenantId}:${actorId}`, rule);
    if (window.count > rule.max)
      throw new RateLimitedError(
        'You sent many requests to Luma’s model features in a short time. Try again in a minute.',
        window.resetIn,
      );
  };
}

// Adds a call's tokens to the day's total; the key outlives its UTC day so late calls still count.
const spendScript = `local total = redis.call('INCRBY', KEYS[1], ARGV[1])
if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return total`;
const readScript = `return tonumber(redis.call('GET', KEYS[1]) or '0')`;
const keyTtlSeconds = String(2 * 24 * 60 * 60);

/**
 * Limits each tenant to `dailyTokens` input and output tokens per UTC day. Totals live in
 * Valkey under a hash of the tenant ID and the day, so the API and workers share them. Tokens
 * that can't be stored are kept in process memory and still count here, so an outage weakens
 * the budget to a per-process one instead of blocking model calls.
 */
export function createDailyTokenBudget(
  dailyTokens: number,
  store?: AtomicStore,
  now: () => Date = () => new Date(),
): ModelTokenBudget {
  // Tenant IDs come from trusted context, so one day's totals stay small.
  let unstored = { day: '', totals: new Map<string, number>() };
  const today = () => {
    const day = now().toISOString().slice(0, 10);
    if (unstored.day !== day) unstored = { day, totals: new Map() };

    return unstored;
  };
  const key = (tenantId: string, day: string) =>
    `luma:model-budget:${createHash('sha256').update(tenantId).digest('hex')}:${day}`;

  return {
    async exhausted(tenantId) {
      const { day, totals } = today();
      let total = totals.get(tenantId) ?? 0;
      if (store)
        try {
          const stored = Number(
            await store.run(readScript, key(tenantId, day), []),
          );
          if (Number.isFinite(stored)) total += stored;
        } catch {
          /* Counted from memory only while Valkey is unreachable. */
        }

      return total >= dailyTokens;
    },
    async spend(tenantId, tokens) {
      if (tokens <= 0) return;
      const { day, totals } = today();
      if (store)
        try {
          await store.run(spendScript, key(tenantId, day), [
            String(tokens),
            keyTtlSeconds,
          ]);

          return;
        } catch {
          /* Kept in memory below. */
        }
      totals.set(tenantId, (totals.get(tenantId) ?? 0) + tokens);
    },
  };
}
