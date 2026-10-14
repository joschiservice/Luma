import { withDispatchGuard } from '@luma/connector-core/dispatch';
import { describe, expect, it, vi } from 'vitest';

import { createClient } from './client.js';
import type { BudgetFeedback } from './read-budget.js';
import { createSharedReadBudget } from './shared-budget.js';

describe('shared Shopify admission failure boundaries', () => {
  it('preserves an accepted mutation when recording its budget fails', async () => {
    const run = vi.fn(
      async (_script: string, _key: string, args: readonly string[]) => {
        if (args[0] === 'complete') throw new Error('coordinator unavailable');

        return [1, 10, Date.now() + 1000];
      },
    );
    const fetch = vi.fn(async () =>
      Response.json({
        data: { applied: true },
        extensions: {
          cost: {
            requestedQueryCost: 10,
            actualQueryCost: 10,
            throttleStatus: {
              maximumAvailable: 2000,
              currentlyAvailable: 1990,
              restoreRate: 100,
            },
          },
        },
      }),
    );
    const budget = createSharedReadBudget({ store: { run }, key: 'scoped' });
    const client = createClient({
      shop: 'example.myshopify.com',
      accessToken: async () => 'token',
      fetch,
      budget,
    });
    await expect(client('mutation Apply { applied }', {})).resolves.toEqual({
      applied: true,
    });
    await expect(
      client('mutation Apply { applied }', {}),
    ).rejects.toMatchObject({
      failure: { code: 'unavailable', providerCode: 'ADMISSION_DEFERRED' },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('returns unused capacity when final authority checks reject dispatch', async () => {
    const run = vi.fn<
      (
        script: string,
        key: string,
        args: readonly string[],
      ) => Promise<number[]>
    >(async () => [1, 1000, Date.now() + 5000]);
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createClient({
      shop: 'example.myshopify.com',
      accessToken: async () => 'token',
      fetch,
      budget: createSharedReadBudget({ store: { run }, key: 'scoped' }),
    });
    await expect(
      withDispatchGuard(
        async () => {
          throw new Error('authority revoked');
        },
        () => client('mutation Apply { applied }', {}),
      ),
    ).rejects.toThrow('authority revoked');
    expect(fetch).not.toHaveBeenCalled();
    expect(run.mock.calls.at(-1)?.[2]?.[0]).toBe('cancel');
  });

  it('does not send or retry a mutation that cannot obtain capacity', async () => {
    const run = vi.fn(async () => [0, 250, 0]);
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createClient({
      shop: 'example.myshopify.com',
      accessToken: async () => 'token',
      fetch,
      budget: createSharedReadBudget({
        store: { run },
        key: 'scoped',
        maxWaitMs: 0,
      }),
    });
    await expect(
      client('mutation Apply { applied }', {}),
    ).rejects.toMatchObject({
      failure: { providerCode: 'ADMISSION_DEFERRED', effect: 'none' },
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('retains compound-read progress while a subsequent request waits briefly for capacity', async () => {
    let acquires = 0;
    const run = async (
      _script: string,
      _key: string,
      args: readonly string[],
    ) => (args[0] === 'acquire' && ++acquires === 2 ? [0, 10, 0] : [1, 0, 0]);
    const budget = createSharedReadBudget({
      store: { run },
      key: 'scoped',
      maxWaitMs: 0,
      continuationWaitMs: 100,
    });
    const parent = vi.fn(async (feedback: BudgetFeedback) => {
      feedback.observe('parent', 1, 1999, 100, 1, 2000);

      return 'parent';
    });
    await expect(budget.run('parent', parent)).resolves.toBe('parent');
    await expect(budget.run('child', async () => 'child')).resolves.toBe(
      'child',
    );
    expect(parent).toHaveBeenCalledTimes(1);
    expect(acquires).toBe(3);
  });

  it('bounds admission by elapsed time even when the wall clock does not advance', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1);
    const budget = createSharedReadBudget({
      store: { run: async () => [0, 10, 0] },
      key: 'scoped',
      maxWaitMs: 40,
    });
    try {
      await expect(budget.run('query', async () => true)).rejects.toMatchObject(
        { failure: { providerCode: 'ADMISSION_DEFERRED' } },
      );
    } finally {
      now.mockRestore();
    }
  });

  it('cancels a waiting read before resolving credentials or sending a provider request', async () => {
    const signal = AbortSignal.abort();
    const accessToken = vi.fn(async () => 'token');
    const run = vi.fn(async () => [0, 1000, 0]);
    const client = createClient({
      shop: 'example.myshopify.com',
      accessToken,
      signal,
      budget: createSharedReadBudget({
        store: { run },
        key: 'scoped',
        maxWaitMs: 0,
      }),
    });
    await expect(
      client('query Shop { shop { id } }', {}),
    ).rejects.toMatchObject({ failure: { code: 'timeout' } });
    expect(run).not.toHaveBeenCalled();
    expect(accessToken).not.toHaveBeenCalled();
  });
});
