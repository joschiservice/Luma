import { describe, expect, it, vi } from 'vitest';

import { createResourceScope } from './resources.js';

describe('runtime resource ownership', () => {
  it('drains resources in reverse order and shares concurrent shutdown', async () => {
    const scope = createResourceScope();
    const order: string[] = [];
    scope.add(async () => {
      order.push('database');
    });
    scope.add(async () => {
      order.push('worker');
    });
    const first = scope.close();
    expect(scope.close()).toBe(first);
    await first;
    expect(order).toEqual(['worker', 'database']);
    expect(() => scope.add(vi.fn())).toThrow('Resource scope is closing');
  });

  it('releases earlier resources even when a later resource fails to close', async () => {
    const scope = createResourceScope();
    const closeDatabase = vi.fn();
    const failure = new Error('worker close failed');
    scope.add(closeDatabase);
    scope.add(async () => {
      throw failure;
    });
    await expect(scope.close()).rejects.toMatchObject({ errors: [failure] });
    expect(closeDatabase).toHaveBeenCalledOnce();
    await expect(scope.close()).rejects.toThrow('Resource cleanup failed');
    expect(closeDatabase).toHaveBeenCalledOnce();
  });
});
