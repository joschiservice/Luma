import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AtomicStore } from '../application/atomic-store.js';
import { RateLimitedError } from '../domain/service-error.js';
import {
  createDailyTokenBudget,
  createModelRequestLimit,
} from './model-limits.js';

/** A Valkey stand-in that keeps integer values per key and evaluates the scripts' effects. */
function fakeStore() {
  const values = new Map<string, number>();
  let failing = false;
  const store: AtomicStore = {
    async run(script, key, arguments_) {
      if (failing) throw new Error('unavailable');
      if (script.includes('INCRBY')) {
        values.set(key, (values.get(key) ?? 0) + Number(arguments_[0]));

        return values.get(key);
      }
      if (script.includes('INCR')) {
        values.set(key, (values.get(key) ?? 0) + 1);

        return [values.get(key), 42];
      }

      return values.get(key) ?? 0;
    },
    ready: async () => !failing,
    close: async () => undefined,
  };

  return {
    store,
    values,
    fail(value: boolean) {
      failing = value;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('model request limit', () => {
  it('admits ten requests a minute per person and refuses the next with the wait', async () => {
    vi.useFakeTimers();
    const admit = createModelRequestLimit();
    for (let index = 0; index < 10; index++)
      await admit('tenant-1', 'member-1');

    const refused = await admit('tenant-1', 'member-1').catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(RateLimitedError);
    expect(refused).toMatchObject({ statusCode: 429, retryAfterSeconds: 60 });
    // Others in the workspace, and the same person elsewhere, keep their own windows.
    await expect(admit('tenant-1', 'member-2')).resolves.toBeUndefined();
    await expect(admit('tenant-2', 'member-1')).resolves.toBeUndefined();

    vi.advanceTimersByTime(60_000);
    await expect(admit('tenant-1', 'member-1')).resolves.toBeUndefined();
  });

  it('shares windows through the store under a hashed key', async () => {
    const { store, values } = fakeStore();
    const first = createModelRequestLimit(store);
    const second = createModelRequestLimit(store);
    for (let index = 0; index < 10; index++)
      await (index % 2 ? first : second)('tenant-1', 'member-1');

    await expect(first('tenant-1', 'member-1')).rejects.toMatchObject({
      statusCode: 429,
      retryAfterSeconds: 42,
    });
    const [key] = values.keys();
    expect(key).toMatch(/^luma:model-rate:[0-9a-f]{64}$/);
  });
});

describe('daily token budget', () => {
  it('is exhausted once a tenant used its tokens for the UTC day', async () => {
    let now = new Date('2026-10-22T23:00:00.000Z');
    const { store, values } = fakeStore();
    const budget = createDailyTokenBudget(1000, store, () => now);

    await budget.spend('tenant-1', 600);
    expect(await budget.exhausted('tenant-1')).toBe(false);
    await budget.spend('tenant-1', 400);
    expect(await budget.exhausted('tenant-1')).toBe(true);
    expect(await budget.exhausted('tenant-2')).toBe(false);
    expect([...values.keys()]).toEqual([
      expect.stringMatching(/^luma:model-budget:[0-9a-f]{64}:2026-10-22$/),
    ]);

    now = new Date('2026-10-23T00:00:00.000Z');
    expect(await budget.exhausted('tenant-1')).toBe(false);
  });

  it('keeps counting in memory while the store is unreachable', async () => {
    const { store, fail } = fakeStore();
    const budget = createDailyTokenBudget(1000, store);

    await budget.spend('tenant-1', 700);
    fail(true);
    await budget.spend('tenant-1', 200);
    expect(await budget.exhausted('tenant-1')).toBe(false);
    await budget.spend('tenant-1', 200);
    // Unstored tokens alone don't reach the budget while the store is unreachable.
    expect(await budget.exhausted('tenant-1')).toBe(false);

    fail(false);
    // Stored and unstored tokens together reach it once the store answers again.
    expect(await budget.exhausted('tenant-1')).toBe(true);
  });

  it('counts in process memory without a store', async () => {
    const budget = createDailyTokenBudget(1000);

    await budget.spend('tenant-1', 1000);
    expect(await budget.exhausted('tenant-1')).toBe(true);
  });
});
