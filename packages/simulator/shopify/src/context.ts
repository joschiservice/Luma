import type { RecordStore, StoredRecord } from '@luma/simulator-core';

import type { ShopifyContext } from './records.js';

/** Batches record reads issued while resolving one GraphQL level into one `getMany` per kind. */
export function createLoader(store: RecordStore) {
  const cache = new Map<string, Promise<StoredRecord | undefined>>();
  let queue = new Map<
    string,
    Map<string, (record: StoredRecord | undefined) => void>
  >();
  let failures: ((error: unknown) => void)[] = [];
  let scheduled = false;

  async function flush() {
    const batch = queue;
    const fail = failures;
    queue = new Map();
    failures = [];
    scheduled = false;
    try {
      await Promise.all(
        [...batch].map(async ([kind, waiting]) => {
          const found = new Map(
            (await store.getMany(kind, [...waiting.keys()])).map((record) => [
              record.id,
              record,
            ]),
          );
          for (const [id, resolve] of waiting) resolve(found.get(id));
        }),
      );
    } catch (error) {
      for (const reject of fail) reject(error);
    }
  }

  return {
    /** Reads a record; reads issued in the same turn share one store query per kind. */
    load<T>(kind: string, id: string): Promise<StoredRecord<T> | undefined> {
      const key = `${kind}\u0000${id}`;
      let pending = cache.get(key);
      if (!pending) {
        pending = new Promise((resolve, reject) => {
          let waiting = queue.get(kind);
          if (!waiting) {
            waiting = new Map();
            queue.set(kind, waiting);
          }
          waiting.set(id, resolve);
          failures.push(reject);
        });
        cache.set(key, pending);
        if (!scheduled) {
          scheduled = true;
          // A macrotask collects reads from every resolver of the current level.
          setImmediate(() => void flush());
        }
      }

      // Records of a kind always hold that kind's data.
      return pending as Promise<StoredRecord<T> | undefined>;
    },
    /** Forgets cached reads after a mutation changed records. */
    clear() {
      cache.clear();
    },
  };
}

export type Loader = ReturnType<typeof createLoader>;

/** State shared by the resolvers of one GraphQL request. */
export interface RequestContext {
  shop: ShopifyContext;
  loader: Loader;
  /** Set when a mutation changed provider state. */
  committed: boolean;
  /** Bulk queries read complete connections without synchronous paging limits. */
  bulk?: boolean;
}
