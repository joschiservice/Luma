import { createMemoryStore, type RecordStore } from '@luma/simulator-core';
import { describe, expect, it } from 'vitest';

import { cacheReads, readOnly } from './stores.js';

/** A memory store that counts the reads reaching it. */
function countingStore() {
  const store = createMemoryStore();
  const reads = { count: 0 };
  const counted: RecordStore = {
    ...store,
    get: (kind, id) => (reads.count++, store.get(kind, id)),
    getMany: (kind, ids) => (reads.count++, store.getMany(kind, ids)),
    page: (query) => (reads.count++, store.page(query)),
    count: (query) => (reads.count++, store.count(query)),
  };

  return { store: counted, reads };
}

describe('cacheReads', () => {
  it('reads each query once until a record of its kind changes', async () => {
    const { store, reads } = countingStore();
    const cached = cacheReads(store);
    await cached.put('pick', '1', { n: 1 }, { key: 'a', updatedAt: 5 });
    await cached.put('freeze', '1', {});

    const first = await cached.page({ kind: 'pick', key: 'a', limit: 10 });
    expect(await cached.page({ kind: 'pick', key: 'a', limit: 10 })).toEqual(
      first,
    );
    expect(await cached.count({ kind: 'pick' })).toBe(1);
    expect(await cached.count({ kind: 'pick' })).toBe(1);
    await cached.get('freeze', '1');
    expect(reads.count).toBe(3);

    await cached.put('freeze', '2', {});
    expect(await cached.count({ kind: 'pick' })).toBe(1);
    expect(reads.count).toBe(3);

    await cached.delete('pick', '1');
    expect(await cached.count({ kind: 'pick' })).toBe(0);
    expect(
      (await cached.page({ kind: 'pick', key: 'a', limit: 10 })).items,
    ).toEqual([]);
    expect(reads.count).toBe(5);
  });

  it('sees a write issued before a read that is still pending', async () => {
    const { store } = countingStore();
    const cached = cacheReads(store);
    const before = cached.get('order', '1');
    const write = cached.putMany([{ kind: 'order', id: '1', data: { n: 1 } }]);
    const after = cached.get('order', '1');
    await write;

    expect(await before).toBeUndefined();
    expect((await after)?.data).toEqual({ n: 1 });
  });

  it('returns copies, so changing a result does not change later reads', async () => {
    const cached = cacheReads(createMemoryStore());
    await cached.put('item', '1', { stock: 1 });
    const record = await cached.get<{ stock: number }>('item', '1');
    record!.data.stock = 9;

    expect((await cached.get<{ stock: number }>('item', '1'))?.data).toEqual({
      stock: 1,
    });
  });

  it('does not remember a failed read', async () => {
    const store = createMemoryStore();
    let fail = true;
    const cached = cacheReads({
      ...store,
      get: (kind, id) =>
        fail ? Promise.reject(new Error('lost')) : store.get(kind, id),
    });

    await expect(cached.get('item', '1')).rejects.toThrow('lost');
    fail = false;
    expect(await cached.get('item', '1')).toBeUndefined();
  });
});

describe('readOnly', () => {
  it('reads records and refuses every write', async () => {
    const store = createMemoryStore();
    await store.put('item', '1', { stock: 1 });
    const reader = readOnly(store);

    expect((await reader.get('item', '1'))?.data).toEqual({ stock: 1 });
    await expect(reader.put('item', '2', {})).rejects.toThrow(
      'cannot change records',
    );
    await expect(reader.putMany([])).rejects.toThrow();
    await expect(reader.delete('item', '1')).rejects.toThrow();
    await expect(reader.sequence('event')).rejects.toThrow();
    expect(await store.count({ kind: 'item' })).toBe(1);
  });
});
