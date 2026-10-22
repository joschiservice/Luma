import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSlotQueue } from './slots.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('Code Step process slots', () => {
  it('lets waiting tenants take turns instead of serving the largest backlog first', async () => {
    const slots = createSlotQueue({ slots: 1, perTenant: 1, waitMs: 60_000 });
    expect(await slots.acquire('a')).toBe('admitted');
    const order: string[] = [];
    const waits = ['a1', 'a2', 'a3', 'b1', 'c1', 'b2'].map((name) =>
      slots.acquire(name[0]!).then((admission) => {
        order.push(name);
        expect(admission).toBe('admitted');
      }),
    );
    // Each release frees the run admitted before it.
    for (const tenantId of ['a', 'a', 'b', 'c', 'a', 'b'])
      slots.release(tenantId);
    await Promise.all(waits);

    expect(order).toEqual(['a1', 'b1', 'c1', 'a2', 'b2', 'a3']);
  });

  it('reports a busy runner after the bounded wait and frees the place in line', async () => {
    vi.useFakeTimers();
    const slots = createSlotQueue({ slots: 1, perTenant: 1, waitMs: 1000 });
    await slots.acquire('a');
    const waiting = slots.acquire('b');
    vi.advanceTimersByTime(1000);
    expect(await waiting).toBe('busy');

    slots.release('a');
    expect(await slots.acquire('c')).toBe('admitted');
  });

  it('cancels a waiting run without consuming a slot', async () => {
    const slots = createSlotQueue({ slots: 1, perTenant: 1, waitMs: 60_000 });
    await slots.acquire('a');
    const stop = new AbortController();
    const waiting = slots.acquire('b', stop.signal);
    stop.abort();
    expect(await waiting).toBe('cancelled');

    slots.release('a');
    expect(await slots.acquire('c')).toBe('admitted');
    expect(await slots.acquire('d', AbortSignal.abort())).toBe('cancelled');
  });

  it('keeps a slot open for other tenants while one tenant has a backlog', async () => {
    const slots = createSlotQueue({ slots: 3, perTenant: 2, waitMs: 60_000 });
    expect(await slots.acquire('a')).toBe('admitted');
    expect(await slots.acquire('a')).toBe('admitted');
    let third: string | undefined;
    const waiting = slots.acquire('a').then((admission) => {
      third = admission;
    });
    await Promise.resolve();
    expect(third).toBeUndefined();
    expect(await slots.acquire('b')).toBe('admitted');

    slots.release('a');
    await waiting;
    expect(third).toBe('admitted');
  });
});
