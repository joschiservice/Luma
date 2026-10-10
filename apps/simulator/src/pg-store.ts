import {
  decodeCursor,
  encodeCursor,
  type RecordMeta,
  type RecordQuery,
  type RecordStore,
  type StoredRecord,
} from '@luma/simulator-core';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

export const recordTables = [
  'sim_shopify_records',
  'sim_jtl_records',
  'sim_cin7_records',
  'sim_world_records',
] as const;

export type RecordTable = (typeof recordTables)[number];

interface Row {
  id: string;
  parent: string | null;
  key: string | null;
  created_at: string;
  updated_at: string;
  seq: string;
  data: unknown;
  kind: string;
}

const columns = 'kind, id, parent, key, created_at, updated_at, seq, data';

const queues = new WeakMap<PoolClient, Promise<unknown>>();

/**
 * Runs a query after the connection's previous one. Provider handlers, such as GraphQL field
 * resolvers, read concurrently, but one connection runs one query at a time.
 */
function serialized<R extends QueryResultRow>(
  client: PoolClient,
  text: string,
  values: unknown[],
): Promise<QueryResult<R>> {
  const previous = queues.get(client) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => client.query<R>(text, values));
  queues.set(client, next);

  return next;
}

const toRecord = <T>(row: Row): StoredRecord<T> => ({
  kind: row.kind,
  id: row.id,
  parent: row.parent,
  key: row.key,
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
  seq: Number(row.seq),
  data: row.data as T,
});

function filters(
  query: Omit<RecordQuery, 'limit' | 'after' | 'offset'>,
  values: unknown[],
) {
  const clauses = [
    'run_id = $1',
    'instance = $2',
    `kind = $${values.push(query.kind)}`,
  ];
  if (query.parent !== undefined)
    clauses.push(`parent = $${values.push(query.parent)}`);
  if (query.key !== undefined) clauses.push(`key = $${values.push(query.key)}`);
  if (query.updatedFrom !== undefined)
    clauses.push(`updated_at >= $${values.push(query.updatedFrom)}`);
  if (query.updatedBefore !== undefined)
    clauses.push(`updated_at < $${values.push(query.updatedBefore)}`);
  if (query.createdFrom !== undefined)
    clauses.push(`created_at >= $${values.push(query.createdFrom)}`);
  if (query.createdBefore !== undefined)
    clauses.push(`created_at < $${values.push(query.createdBefore)}`);

  return clauses;
}

/**
 * Provider records for one run and instance in a PostgreSQL table. Every call uses the given
 * client, so a request's reads and writes share its transaction.
 */
export function createPgStore(
  client: PoolClient,
  table: RecordTable,
  runId: string,
  instance: string,
): RecordStore {
  if (!recordTables.includes(table)) throw new Error('Unknown record table');

  async function write(
    records: readonly ({
      kind: string;
      id: string;
      data: unknown;
    } & RecordMeta)[],
  ) {
    for (let start = 0; start < records.length; start += 2_000) {
      const chunk = records.slice(start, start + 2_000).map((record) => ({
        kind: record.kind,
        id: record.id,
        parent: record.parent ?? null,
        key: record.key ?? null,
        created_at: record.createdAt ?? record.updatedAt ?? 0,
        updated_at: record.updatedAt ?? 0,
        data: record.data,
      }));
      await serialized(
        client,
        `INSERT INTO ${table} (run_id, instance, kind, id, parent, key, created_at, updated_at, data)
         SELECT $1, $2, r.kind, r.id, r.parent, r.key, r.created_at, r.updated_at, r.data
         FROM jsonb_to_recordset($3::jsonb) AS r(kind text, id text, parent text, key text,
           created_at bigint, updated_at bigint, data jsonb)
         ON CONFLICT (run_id, instance, kind, id) DO UPDATE SET data = excluded.data,
           parent = excluded.parent, key = excluded.key, created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
        [runId, instance, JSON.stringify(chunk)],
      );
    }
  }

  return {
    async get<T>(kind: string, id: string) {
      const { rows } = await serialized<Row>(
        client,
        `SELECT ${columns} FROM ${table} WHERE run_id = $1 AND instance = $2 AND kind = $3 AND id = $4`,
        [runId, instance, kind, id],
      );

      return rows[0] ? toRecord<T>(rows[0]) : undefined;
    },
    async getMany<T>(kind: string, ids: readonly string[]) {
      if (!ids.length) return [];
      const { rows } = await serialized<Row>(
        client,
        `SELECT ${columns} FROM ${table}
         WHERE run_id = $1 AND instance = $2 AND kind = $3 AND id = ANY($4::text[])`,
        [runId, instance, kind, [...ids]],
      );
      const byId = new Map(rows.map((row) => [row.id, toRecord<T>(row)]));

      return ids.flatMap((id) => {
        const record = byId.get(id);

        return record ? [record] : [];
      });
    },
    async put(kind, id, data, meta = {}) {
      const { rows } = await serialized(
        client,
        `UPDATE ${table} SET data = $5,
           parent = CASE WHEN $6::boolean THEN parent ELSE $7 END,
           key = CASE WHEN $8::boolean THEN key ELSE $9 END,
           updated_at = COALESCE($10, updated_at),
           created_at = COALESCE($11, created_at)
         WHERE run_id = $1 AND instance = $2 AND kind = $3 AND id = $4 RETURNING 1`,
        [
          runId,
          instance,
          kind,
          id,
          JSON.stringify(data),
          meta.parent === undefined,
          meta.parent ?? null,
          meta.key === undefined,
          meta.key ?? null,
          meta.updatedAt ?? null,
          meta.createdAt ?? null,
        ],
      );
      if (rows.length) return;
      const updatedAt = meta.updatedAt ?? 0;
      await serialized(
        client,
        `INSERT INTO ${table} (run_id, instance, kind, id, parent, key, created_at, updated_at, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          runId,
          instance,
          kind,
          id,
          meta.parent ?? null,
          meta.key ?? null,
          meta.createdAt ?? updatedAt,
          updatedAt,
          JSON.stringify(data),
        ],
      );
    },
    async putMany(records) {
      await write(records);
    },
    async delete(kind, id) {
      await serialized(
        client,
        `DELETE FROM ${table} WHERE run_id = $1 AND instance = $2 AND kind = $3 AND id = $4`,
        [runId, instance, kind, id],
      );
    },
    async page<T>(query: RecordQuery) {
      const values: unknown[] = [runId, instance];
      const clauses = filters(query, values);
      const order = query.order ?? 'created';
      const direction = query.reverse ? 'DESC' : 'ASC';
      const comparison = query.reverse ? '<' : '>';
      if (query.after) {
        const position = decodeCursor(query.after, order);
        clauses.push(
          order === 'created'
            ? `seq ${comparison} $${values.push(position.seq)}`
            : `(updated_at, seq) ${comparison} ($${values.push(position.updatedAt)}, $${values.push(position.seq)})`,
        );
      }
      const sort =
        order === 'created'
          ? `seq ${direction}`
          : `updated_at ${direction}, seq ${direction}`;
      const offset =
        !query.after && query.offset
          ? ` OFFSET $${values.push(query.offset)}`
          : '';
      const { rows } = await serialized<Row>(
        client,
        `SELECT ${columns} FROM ${table} WHERE ${clauses.join(' AND ')}
         ORDER BY ${sort} LIMIT $${values.push(query.limit + 1)}${offset}`,
        values,
      );
      const items = rows.slice(0, query.limit).map((row) => toRecord<T>(row));
      const last = items.at(-1);

      return {
        items,
        next:
          rows.length > query.limit && last ? encodeCursor(last, order) : null,
      };
    },
    async count(query) {
      const values: unknown[] = [runId, instance];
      const { rows } = await serialized<{ count: string }>(
        client,
        `SELECT count(*) FROM ${table} WHERE ${filters(query, values).join(' AND ')}`,
        values,
      );

      return Number(rows[0]?.count ?? 0);
    },
    async sequence(name, start = 1) {
      const { rows } = await serialized<{ value: string }>(
        client,
        `INSERT INTO sim_sequences (run_id, instance, name, value) VALUES ($1, $2, $3, $4)
         ON CONFLICT (run_id, instance, name) DO UPDATE SET value = sim_sequences.value + 1
         RETURNING value`,
        [runId, instance, name, start],
      );

      return Number(rows[0]!.value);
    },
  };
}
