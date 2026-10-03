import type { RecordStore } from '@luma/simulator-core';
import { describe, expect, it } from 'vitest';

import { itemsPage, jtl } from './index.js';
import {
  createFixture,
  items,
  seeded,
  suppliers,
} from './test-support/fixture.js';
import type { JtlSeedItem } from './types.js';

/** Counts store calls by method. */
function instrument(store: RecordStore) {
  const calls: Record<string, number> = {};
  for (const method of Object.keys(store) as (keyof RecordStore)[]) {
    const original = store[method].bind(store) as (
      ...args: unknown[]
    ) => unknown;
    (store as unknown as Record<string, unknown>)[method] = (
      ...args: unknown[]
    ) => {
      calls[method] = (calls[method] ?? 0) + 1;

      return original(...args);
    };
  }

  return calls;
}

describe('JTL catalog seeding', () => {
  it('bulk-inserts a large catalog in one write', async () => {
    const { context } = createFixture();
    const calls = instrument(context.store);
    const catalog: JtlSeedItem[] = Array.from(
      { length: 40000 },
      (_, index) => ({
        id: String(index + 1),
        sku: `SKU-${index + 1}`,
        name: `Item ${index + 1}`,
        price: '19.99',
        gtin: null,
        manufacturer: 'Luma Goods',
        active: true,
        shopActive: true,
        stock: { '1': index % 50, '2': 3 },
        suppliers: [{ supplierId: '1', netPrice: 8, isDefault: true }],
      }),
    );
    const started = performance.now();
    await jtl.command(context, {
      kind: 'seed-catalog',
      items: catalog,
      suppliers,
    });
    expect(performance.now() - started).toBeLessThan(10000);
    expect(calls).toEqual({ getMany: 3, count: 1, putMany: 1 });
    const page = await itemsPage(context, { limit: 2 });
    expect(page.items).toEqual([
      {
        id: '1',
        sku: 'SKU-1',
        name: 'Item 1',
        total: 3,
        reserved: 0,
        available: 3,
        warehouses: { '1': 0, '2': 3 },
      },
      expect.objectContaining({ id: '2', total: 4 }),
    ]);
    expect(
      (await itemsPage(context, { limit: 1, after: page.next })).items,
    ).toMatchObject([{ id: '3' }]);
  });

  it('continues assignment IDs and refuses duplicates and unknown references', async () => {
    const { context } = await seeded();
    await jtl.command(context, {
      kind: 'seed-catalog',
      items: [{ ...items[1]!, id: '3', sku: 'LUMA-003' }],
      suppliers: [],
    });
    expect(
      (
        await context.store.page({
          kind: 'item-supplier',
          parent: '3',
          limit: 5,
        })
      ).items[0]?.id,
    ).toBe('4');
    await expect(
      jtl.command(context, {
        kind: 'seed-catalog',
        items: [items[0]!],
        suppliers: [],
      }),
    ).rejects.toThrow('already exists');
    await expect(
      jtl.command(context, {
        kind: 'seed-catalog',
        items: [
          {
            ...items[0]!,
            id: '4',
            suppliers: [{ supplierId: '9', netPrice: 1, isDefault: true }],
          },
        ],
        suppliers: [],
      }),
    ).rejects.toThrow('Supplier not found');
    for (const item of [
      { ...items[0]!, id: '0' },
      { ...items[0]!, id: '4', price: 'free' },
      { ...items[0]!, id: '4', stock: { '3': 1 } },
      { ...items[0]!, id: '4', stock: { '1': -1 } },
    ])
      await expect(
        jtl.command(context, {
          kind: 'seed-catalog',
          items: [item],
          suppliers: [],
        }),
      ).rejects.toThrow('Invalid item');
  });
});
