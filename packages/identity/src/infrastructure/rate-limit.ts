import {
  type AtomicStore,
  createRequestCounter,
  type RequestCounter,
} from '@luma/platform';
import type { BetterAuthOptions } from 'better-auth';

type RateLimitStorage = NonNullable<
  NonNullable<BetterAuthOptions['rateLimit']>['customStorage']
>;

/** Counts auth and API app requests in shared windows; see `createRequestCounter`. */
export function createAuthRequestCounter(store?: AtomicStore): RequestCounter {
  return createRequestCounter(store, 'luma:auth-rate');
}

/**
 * Stores auth rate-limit counters through `createAuthRequestCounter`. Keys hold a hash of the
 * client address and path, never the address itself.
 */
export function createRateLimitStorage(store?: AtomicStore): RateLimitStorage {
  const count = createAuthRequestCounter(store);

  return {
    async consume(key, rule) {
      const window = await count(key, rule);

      return window.count <= rule.max
        ? { allowed: true, retryAfter: null }
        : { allowed: false, retryAfter: window.resetIn };
    },
  };
}
