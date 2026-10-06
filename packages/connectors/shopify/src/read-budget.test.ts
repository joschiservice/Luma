import { describe, expect, it } from 'vitest';

import { createReadBudget } from './read-budget.js';

describe('Shopify read admission', () => {
  it('uses requested cost, refunded balance and restore rate before admitting a request', async () => {
    let time = 0;
    const waits: number[] = [];
    const budget = createReadBudget({
      now: () => time,
      sleep: async (ms) => {
        waits.push(ms);
        time += ms;
      },
    });
    budget.observe('orders', 727, 100, 100);
    await budget.run('orders', async () => undefined);
    expect(waits).toEqual([6270]);
    budget.observe('orders', 727, 900, 100);
    await budget.run('orders', async () => undefined);
    expect(waits).toEqual([6270]);
    await budget.run('unknown', async () => undefined);
    expect(waits).toEqual([6270, 1000]);
  });

  it('shares cooldown and serializes admission without losing the queue after failure', async () => {
    let time = 0;
    const order: string[] = [];
    const budget = createReadBudget({
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
    });
    budget.cooldown(2000);
    const result = await Promise.allSettled([
      budget.run('first', async () => {
        order.push('first');
        throw new Error('provider unavailable');
      }),
      budget.run('second', async () => {
        order.push('second');

        return time;
      }),
    ]);
    expect(order).toEqual(['first', 'second']);
    expect(result).toEqual([
      { status: 'rejected', reason: expect.any(Error) },
      { status: 'fulfilled', value: 2000 },
    ]);
  });
});
