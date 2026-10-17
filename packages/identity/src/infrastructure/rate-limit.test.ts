import type { AtomicStore } from '@luma/platform';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRateLimitStorage } from './rate-limit.js';

const rule = { window: 60, max: 2 };

/** A Valkey stand-in that evaluates the counter script's effect for one fixed window. */
function fakeStore(fail = false) {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  const store: AtomicStore = {
    async run(_script, key) {
      if (fail) throw new Error('unavailable');
      keys.push(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);

      return [counts.get(key), 42];
    },
    ready: async () => !fail,
    close: async () => undefined,
  };

  return { store, keys };
}

afterEach(() => vi.useRealTimers());

describe('auth rate-limit storage', () => {
  it('counts in process memory per key and window without a store', async () => {
    vi.useFakeTimers();
    const storage = createRateLimitStorage();

    expect(await storage.consume('192.0.2.1|/sign-in/email', rule)).toEqual({
      allowed: true,
      retryAfter: null,
    });
    await storage.consume('192.0.2.1|/sign-in/email', rule);
    expect(await storage.consume('192.0.2.1|/sign-in/email', rule)).toEqual({
      allowed: false,
      retryAfter: 60,
    });
    expect(
      (await storage.consume('192.0.2.2|/sign-in/email', rule)).allowed,
    ).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(
      (await storage.consume('192.0.2.1|/sign-in/email', rule)).allowed,
    ).toBe(true);
  });

  it('shares counters through the store under hashed keys', async () => {
    const { store, keys } = fakeStore();
    const storage = createRateLimitStorage(store);

    await storage.consume('192.0.2.1|/sign-in/email', rule);
    await storage.consume('192.0.2.1|/sign-in/email', rule);

    expect(await storage.consume('192.0.2.1|/sign-in/email', rule)).toEqual({
      allowed: false,
      retryAfter: 42,
    });
    expect(keys[0]).toMatch(/^luma:auth-rate:[0-9a-f]{64}$/);
    expect(keys.join()).not.toContain('192.0.2.1');
  });

  it('keeps limiting in memory while the store is unavailable', async () => {
    const storage = createRateLimitStorage(fakeStore(true).store);

    await storage.consume('192.0.2.1|/sign-in/email', rule);
    await storage.consume('192.0.2.1|/sign-in/email', rule);

    expect(
      (await storage.consume('192.0.2.1|/sign-in/email', rule)).allowed,
    ).toBe(false);
  });
});
