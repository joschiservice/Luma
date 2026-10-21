/** Metadata kept beside each provider record for lookups, ordering and pagination. */
export interface RecordMeta {
  /** Owning record, for nested collections such as order lines. */
  parent?: string | null | undefined;
  /** Secondary lookup key, such as a SKU code or an external order number. */
  key?: string | null | undefined;
  /** Provider modification time in epoch milliseconds. */
  updatedAt?: number | undefined;
  /** Provider creation time in epoch milliseconds; defaults to the first update time. */
  createdAt?: number | undefined;
}

export interface StoredRecord<T = unknown> {
  kind: string;
  id: string;
  parent: string | null;
  key: string | null;
  createdAt: number;
  updatedAt: number;
  /** Insertion order; stable across updates. */
  seq: number;
  data: T;
}

export interface RecordQuery {
  kind: string;
  parent?: string | undefined;
  key?: string | undefined;
  /** Insertion order or modification order; both break ties by insertion order. */
  order?: 'created' | 'updated' | undefined;
  reverse?: boolean | undefined;
  /** Inclusive lower bound on the modification time. */
  updatedFrom?: number | undefined;
  /** Exclusive upper bound on the modification time, used for search-index lag. */
  updatedBefore?: number | undefined;
  createdFrom?: number | undefined;
  createdBefore?: number | undefined;
  /** Opaque cursor returned by a previous page. */
  after?: string | null | undefined;
  /** Row offset for page-number APIs; ignored when a cursor is given. */
  offset?: number | undefined;
  limit: number;
}

export interface RecordPage<T> {
  items: StoredRecord<T>[];
  /** Cursor for the next page, or null at the end. */
  next: string | null;
}

/**
 * Provider-owned record storage for one simulated provider instance. Implementations are the
 * in-memory store for unit tests and in-process fixtures, and the host's PostgreSQL store.
 * Writes inside one host request commit together.
 */
export interface RecordStore {
  get<T>(kind: string, id: string): Promise<StoredRecord<T> | undefined>;
  getMany<T>(kind: string, ids: readonly string[]): Promise<StoredRecord<T>[]>;
  /** Inserts or replaces a record. Omitted metadata keeps its stored value. */
  put<T>(kind: string, id: string, data: T, meta?: RecordMeta): Promise<void>;
  /**
   * Inserts or fully replaces many records efficiently, for seeding catalogs and history.
   * Unlike `put`, omitted metadata is stored as empty rather than kept.
   */
  putMany(
    records: readonly ({
      kind: string;
      id: string;
      data: unknown;
    } & RecordMeta)[],
  ): Promise<void>;
  delete(kind: string, id: string): Promise<void>;
  page<T>(query: RecordQuery): Promise<RecordPage<T>>;
  count(
    query: Omit<RecordQuery, 'after' | 'offset' | 'limit'>,
  ): Promise<number>;
  /** Allocates the next value of a named counter, starting at `start`. */
  sequence(name: string, start?: number): Promise<number>;
}

/** Encodes a keyset position; the order determines which fields are compared. */
export function encodeCursor(
  record: Pick<StoredRecord, 'seq' | 'updatedAt'>,
  order: 'created' | 'updated',
) {
  return order === 'created'
    ? `c${record.seq}`
    : `u${record.updatedAt}.${record.seq}`;
}

/** Decodes a keyset cursor; rejects cursors produced for another ordering. */
export function decodeCursor(cursor: string, order: 'created' | 'updated') {
  const match =
    order === 'created'
      ? /^c(\d{1,15})$/.exec(cursor)
      : /^u(\d{1,15})\.(\d{1,15})$/.exec(cursor);
  if (!match) throw new Error('Invalid cursor');

  return order === 'created'
    ? { updatedAt: 0, seq: Number(match[1]) }
    : { updatedAt: Number(match[1]), seq: Number(match[2]) };
}

/** Serializable contents of an in-memory store. */
export interface MemorySnapshot {
  seq: number;
  records: StoredRecord[];
  sequences: Record<string, number>;
}

/** Creates an in-memory record store; snapshots are plain JSON for checkpoints and fixtures. */
export function createMemoryStore(snapshot?: MemorySnapshot) {
  const kinds = new Map<string, Map<string, StoredRecord>>();
  const sequences: Record<string, number> = { ...snapshot?.sequences };
  let seq = snapshot?.seq ?? 0;
  for (const record of snapshot?.records ?? [])
    table(record.kind).set(record.id, structuredClone(record));

  function table(kind: string) {
    let rows = kinds.get(kind);
    if (!rows) {
      rows = new Map();
      kinds.set(kind, rows);
    }

    return rows;
  }

  function write(
    kind: string,
    id: string,
    data: unknown,
    meta: RecordMeta = {},
  ) {
    const rows = table(kind);
    const previous = rows.get(id);
    const updatedAt = meta.updatedAt ?? previous?.updatedAt ?? 0;
    rows.set(id, {
      kind,
      id,
      parent:
        meta.parent === undefined ? (previous?.parent ?? null) : meta.parent,
      key: meta.key === undefined ? (previous?.key ?? null) : meta.key,
      createdAt: meta.createdAt ?? previous?.createdAt ?? updatedAt,
      updatedAt,
      seq: previous?.seq ?? ++seq,
      data: structuredClone(data),
    });
  }

  function select(query: Omit<RecordQuery, 'limit'>) {
    return [...table(query.kind).values()].filter(
      (record) =>
        (query.parent === undefined || record.parent === query.parent) &&
        (query.key === undefined || record.key === query.key) &&
        (query.updatedFrom === undefined ||
          record.updatedAt >= query.updatedFrom) &&
        (query.updatedBefore === undefined ||
          record.updatedAt < query.updatedBefore) &&
        (query.createdFrom === undefined ||
          record.createdAt >= query.createdFrom) &&
        (query.createdBefore === undefined ||
          record.createdAt < query.createdBefore),
    );
  }

  const store: RecordStore & { snapshot(): MemorySnapshot } = {
    async get<T>(kind: string, id: string) {
      const record = kinds.get(kind)?.get(id);

      return record ? (structuredClone(record) as StoredRecord<T>) : undefined;
    },
    async getMany<T>(kind: string, ids: readonly string[]) {
      return ids.flatMap((id) => {
        const record = kinds.get(kind)?.get(id);

        return record ? [structuredClone(record) as StoredRecord<T>] : [];
      });
    },
    async put(kind, id, data, meta) {
      write(kind, id, data, meta);
    },
    async putMany(records) {
      for (const { kind, id, data, ...meta } of records)
        write(kind, id, data, {
          parent: meta.parent ?? null,
          key: meta.key ?? null,
          updatedAt: meta.updatedAt ?? 0,
          createdAt: meta.createdAt ?? meta.updatedAt ?? 0,
        });
    },
    async delete(kind, id) {
      kinds.get(kind)?.delete(id);
    },
    async page<T>(query: RecordQuery) {
      const order = query.order ?? 'created';
      const direction = query.reverse ? -1 : 1;
      const compare = (a: StoredRecord, b: StoredRecord) =>
        direction *
        (order === 'updated'
          ? a.updatedAt - b.updatedAt || a.seq - b.seq
          : a.seq - b.seq);
      let rows = select(query);
      // The engine asks for the first record often, such as its earliest event; that
      // needs one pass rather than a sort.
      if (query.limit === 1 && !query.after && !query.offset) {
        const first = rows.reduce<StoredRecord | undefined>(
          (best, row) => (!best || compare(row, best) < 0 ? row : best),
          undefined,
        );

        return {
          items: first ? [structuredClone(first) as StoredRecord<T>] : [],
          next: rows.length > 1 && first ? encodeCursor(first, order) : null,
        };
      }
      rows.sort(compare);
      if (query.after) {
        const position = decodeCursor(query.after, order);
        const marker = { ...position } as StoredRecord;
        rows = rows.filter((row) => compare(row, marker) > 0);
      } else if (query.offset) rows = rows.slice(query.offset);
      const items = rows
        .slice(0, query.limit)
        .map((row) => structuredClone(row) as StoredRecord<T>);
      const last = items.at(-1);

      return {
        items,
        next:
          rows.length > query.limit && last ? encodeCursor(last, order) : null,
      };
    },
    async count(query) {
      return select(query).length;
    },
    async sequence(name, start = 1) {
      sequences[name] = (sequences[name] ?? start - 1) + 1;

      return sequences[name];
    },
    snapshot() {
      return {
        seq,
        sequences: { ...sequences },
        records: [...kinds.values()].flatMap((rows) =>
          [...rows.values()].map((row) => structuredClone(row)),
        ),
      };
    },
  };

  return store;
}
