import type { RecordQuery, RecordStore } from '@luma/simulator-core';

/**
 * Wraps the record store of a transaction that holds its run's lock and remembers each read
 * until the transaction writes a record of the same kind. Only use it where nobody else can
 * change the run's records meanwhile: then a repeated read, such as the engine's per-minute
 * checks of pending picks, freezes and stalls, returns what the database would. The wrapped
 * store must run calls in call order, as the PostgreSQL store does, so a read issued after a
 * write sees it. Results are copies; callers may change them.
 */
export function cacheReads(store: RecordStore): RecordStore {
  const reads = new Map<string, Map<string, Promise<unknown>>>();

  function cached<T>(kind: string, key: string, read: () => Promise<T>) {
    let entries = reads.get(kind);
    if (!entries) {
      entries = new Map();
      reads.set(kind, entries);
    }
    let pending = entries.get(key) as Promise<T> | undefined;
    if (!pending) {
      const result = read();
      const owner = entries;
      // A failed read is not remembered; the caller still receives the error.
      result.catch(() => {
        if (owner.get(key) === result) owner.delete(key);
      });
      entries.set(key, result);
      pending = result;
    }

    return pending.then((value) => structuredClone(value));
  }

  const changed = (kind: string) => reads.delete(kind);

  return {
    get<T>(kind: string, id: string) {
      return cached(kind, `get\u0000${id}`, () => store.get<T>(kind, id));
    },
    getMany<T>(kind: string, ids: readonly string[]) {
      return cached(kind, `many\u0000${JSON.stringify(ids)}`, () =>
        store.getMany<T>(kind, ids),
      );
    },
    page<T>(query: RecordQuery) {
      return cached(query.kind, `page\u0000${JSON.stringify(query)}`, () =>
        store.page<T>(query),
      );
    },
    count: (query) =>
      cached(query.kind, `count\u0000${JSON.stringify(query)}`, () =>
        store.count(query),
      ),
    put(kind, id, data, meta) {
      changed(kind);

      return store.put(kind, id, data, meta);
    },
    putMany(records) {
      for (const kind of new Set(records.map((record) => record.kind)))
        changed(kind);

      return store.putMany(records);
    },
    delete(kind, id) {
      changed(kind);

      return store.delete(kind, id);
    },
    sequence: (name, start) => store.sequence(name, start),
  };
}

const refuse = () =>
  Promise.reject(new Error('A provider read cannot change records'));

/**
 * Wraps the record store of a provider read, which runs outside the run lock, so that a
 * handler that writes during a read fails instead of changing records unserialized.
 */
export function readOnly(store: RecordStore): RecordStore {
  return {
    ...store,
    put: refuse,
    putMany: refuse,
    delete: refuse,
    sequence: refuse,
  };
}
