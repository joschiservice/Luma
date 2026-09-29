import type { TenantContext } from '@luma/identity';
import { requireTenant } from '@luma/identity';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';

import type {
  RecordDetail,
  RecordExplorer,
  RecordKind,
  RecordSummary,
} from '../application/records.js';

type Row = {
  kind: RecordKind;
  id: string;
  document: Record<string, unknown> | null;
  connectionId: string | null;
  connection: Record<string, unknown> | null;
  externalId: string | null;
  mappingMethod: string | null;
};

const projectionRows = `
  SELECT e.kind, e.id, s.document, s.connection_id AS "connectionId",
    c.document AS connection, m.external_id AS "externalId", m.method AS "mappingMethod"
  FROM orders_entities e
  JOIN orders_projections p ON p.tenant_id=e.tenant_id AND p.entity_id=e.id
  JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
  LEFT JOIN connector_installations c ON c.tenant_id=e.tenant_id AND c.id=p.connection_id
  LEFT JOIN connector_source_mappings m ON m.tenant_id=e.tenant_id
    AND m.connection_id=p.connection_id AND m.resource=e.kind AND m.canonical_id=e.id
  WHERE e.tenant_id=$1 AND e.kind IN ('order','fulfillment')
  UNION ALL
  SELECT e.kind, e.id, s.document, s.connection_id AS "connectionId",
    c.document AS connection, NULL::text AS "externalId", NULL::text AS "mappingMethod"
  FROM inventory_entities e
  JOIN inventory_projections p ON p.tenant_id=e.tenant_id AND p.entity_id=e.id
  JOIN inventory_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
  LEFT JOIN connector_installations c ON c.tenant_id=e.tenant_id AND c.id=p.connection_id
  WHERE e.tenant_id=$1 AND e.kind='position'
  UNION ALL
  SELECT e.kind, e.id, NULL::jsonb AS document, m.connection_id AS "connectionId",
    c.document AS connection, m.external_id AS "externalId", m.method AS "mappingMethod"
  FROM inventory_entities e
  JOIN connector_source_mappings m ON m.tenant_id=e.tenant_id AND m.canonical_id=e.id AND m.resource=e.kind
  LEFT JOIN connector_installations c ON c.tenant_id=m.tenant_id AND c.id=m.connection_id
  WHERE e.tenant_id=$1 AND e.kind IN ('sku','product')
  UNION ALL
  SELECT 'issue' AS kind, e.id, e.document, NULL::uuid AS "connectionId",
    NULL::jsonb AS connection, NULL::text AS "externalId", NULL::text AS "mappingMethod"
  FROM exceptions e WHERE e.tenant_id=$1`;

function string(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function summary(rows: Row[]): RecordSummary {
  const ordered = [...rows].sort((left, right) =>
    (
      string(right.document?.sourceUpdatedAt) ??
      string(right.document?.observedAt) ??
      ''
    ).localeCompare(
      string(left.document?.sourceUpdatedAt) ??
        string(left.document?.observedAt) ??
        '',
    ),
  );
  const first = ordered[0]!;
  const snapshots = ordered
    .map((row) => row.document)
    .filter(Boolean) as Record<string, unknown>[];
  const current = snapshots[0] ?? {};
  const data = object(current.data);
  const subject = object(current.subject);
  const label =
    first.kind === 'order'
      ? (string(data.displayNumber) ?? `Order ${first.id.slice(0, 8)}`)
      : first.kind === 'issue'
        ? (string(current.summary) ?? `Issue ${first.id.slice(0, 8)}`)
        : `${first.kind === 'position' ? 'Stock position' : first.kind === 'sku' ? 'SKU' : first.kind === 'product' ? 'Product' : 'Fulfillment'} ${first.externalId ?? first.id.slice(0, 8)}`;
  const description =
    first.kind === 'position'
      ? `SKU ${string(data.skuId)?.slice(0, 8) ?? 'unknown'} · ${string(data.available) ?? 'Unknown'} ${string(data.unit) ?? ''} available`
      : first.kind === 'issue'
        ? `${string(subject.subjectKind) ?? 'Record'} · ${string(subject.subjectId) ?? 'unknown'}`
        : first.kind === 'order'
          ? `${Array.isArray(data.lines) ? data.lines.length : 0} lines · ${string(data.paymentStatus) ?? 'Payment unknown'}`
          : first.kind === 'fulfillment'
            ? `Order ${string(data.orderId)?.slice(0, 8) ?? 'unknown'}`
            : (first.externalId ?? 'Source identity');
  const sources = ordered.flatMap((row) => {
    if (!row.connectionId) return [];
    const connection = object(row.connection);

    return [
      {
        connectionId: row.connectionId,
        label:
          string(connection.label) ??
          string(object(connection.target).kind) ??
          'Connected source',
        status: string(connection.status) ?? 'unknown',
        externalId: row.externalId,
        mappingMethod: row.mappingMethod,
        observedAt: string(row.document?.observedAt),
        sourceUpdatedAt: string(row.document?.sourceUpdatedAt),
      },
    ];
  });
  const times = sources
    .map((source) => source.observedAt)
    .filter((time): time is string => !!time)
    .sort();
  const sourceTimes = sources
    .map((source) => source.sourceUpdatedAt)
    .filter((time): time is string => !!time)
    .sort();

  return {
    kind: first.kind,
    id: first.id,
    label,
    description,
    status:
      current.deleted === true
        ? 'removed at source'
        : new Set(
              snapshots
                .map((snapshot) => string(object(snapshot.data).status))
                .filter(Boolean),
            ).size > 1
          ? 'differs by source'
          : (string(data.status) ??
            string(current.state) ??
            (snapshots.length ? 'current' : 'identity only')),
    coverage: snapshots.length ? 'projected' : 'identity_only',
    sources,
    observedAt: times.at(-1) ?? null,
    sourceUpdatedAt: sourceTimes.at(-1) ?? null,
  };
}

async function rowsFor(
  tx: SqlTransaction,
  tenantId: string,
  kind?: RecordKind,
  id?: string,
  query = '',
  connectionId?: string,
) {
  const result = await tx.query<Row>(
    `WITH records AS MATERIALIZED (${projectionRows}), matched AS MATERIALIZED (
     SELECT * FROM records
     WHERE ($2::text IS NULL OR kind=$2) AND ($3::uuid IS NULL OR id=$3)
     AND ($6::uuid IS NULL OR "connectionId"=$6)
     AND ($4::text='' OR id::text ILIKE $5 OR "externalId" ILIKE $5
       OR document->'data'->>'displayNumber' ILIKE $5
       OR document->'data'->>'status' ILIKE $5
       OR document->>'summary' ILIKE $5
       OR document->'subject'->>'subjectId' ILIKE $5)
     ), selected AS (
       SELECT kind,id,max(COALESCE(document->>'observedAt','')) AS latest
       FROM matched GROUP BY kind,id ORDER BY latest DESC,kind,id LIMIT 50
     )
     SELECT matched.* FROM matched JOIN selected USING(kind,id)
     ORDER BY kind,id,"connectionId"`,
    [
      tenantId,
      kind ?? null,
      id ?? null,
      query,
      `%${query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`,
      connectionId ?? null,
    ],
  );

  return result.rows;
}

/** Reads current tenant records, retaining separate source snapshots and explicit identity coverage. */
export function createRecordExplorer(db: TenantDatabase): RecordExplorer {
  return {
    async list(
      context: TenantContext,
      query: {
        q: string;
        kind?: RecordKind | undefined;
        connectionId?: string | undefined;
      },
    ) {
      requireTenant(context, context.tenantId);

      return db.transaction(
        context.tenantId,
        async (tx) => {
          const rows = await rowsFor(
            tx,
            context.tenantId,
            query.kind,
            undefined,
            query.q,
            query.connectionId,
          );
          const groups = new Map<string, Row[]>();
          for (const row of rows) {
            const key = `${row.kind}:${row.id}`;
            groups.set(key, [...(groups.get(key) ?? []), row]);
          }
          const items = [...groups.values()]
            .map(summary)
            .sort(
              (left, right) =>
                (right.observedAt ?? '').localeCompare(left.observedAt ?? '') ||
                left.label.localeCompare(right.label),
            )
            .slice(0, 50);

          return {
            items,
            coverage: {
              customer: 'unavailable' as const,
              return: 'unavailable' as const,
            },
          };
        },
        { readOnlySnapshot: true },
      );
    },
    async get(
      context: TenantContext,
      kind: RecordKind,
      id: string,
    ): Promise<RecordDetail | null> {
      requireTenant(context, context.tenantId);

      return db.transaction(
        context.tenantId,
        async (tx) => {
          const rows = await rowsFor(tx, context.tenantId, kind, id);
          if (!rows.length) return null;
          const links: RecordDetail['links'] = [];
          const add = (
            kind: RecordKind,
            id: unknown,
            label: string,
            relationship: string,
          ) => {
            if (
              typeof id === 'string' &&
              /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id) &&
              id !== rows[0]!.id
            )
              links.push({ kind, id, label, relationship });
          };
          for (const row of rows) {
            const data = object(row.document?.data);
            if (kind === 'fulfillment')
              add('order', data.orderId, 'Order', 'Fulfills');
            if (kind === 'position') add('sku', data.skuId, 'SKU', 'Stock for');
            if (kind === 'order' && Array.isArray(data.lines))
              for (const line of data.lines)
                add('sku', object(line).skuId, 'SKU', 'Ordered item');
          }
          if (kind === 'order') {
            const found = await tx.query<{ id: string }>(
              `SELECT DISTINCT e.id FROM orders_relationships r JOIN orders_entities e
             ON e.tenant_id=r.tenant_id AND e.id=r.child_id AND e.kind='fulfillment'
             WHERE r.tenant_id=$1 AND r.order_id=$2`,
              [context.tenantId, id],
            );
            for (const row of found.rows)
              add('fulfillment', row.id, 'Fulfillment', 'Fulfills order');
          }
          if (kind === 'sku') {
            const found = await tx.query<{ id: string }>(
              `SELECT DISTINCT entity_id AS id FROM inventory_snapshots WHERE tenant_id=$1 AND sku_id=$2`,
              [context.tenantId, id],
            );
            for (const row of found.rows)
              add('position', row.id, 'Stock position', 'Stock at location');
          }
          if (kind === 'issue') {
            const subject = object(rows[0]?.document?.subject);
            const subjectKind = string(subject.subjectKind);
            const subjectId = string(subject.subjectId);
            if (
              subjectKind &&
              subjectId &&
              ['order', 'fulfillment', 'sku', 'product'].includes(subjectKind)
            ) {
              const scope = Array.isArray(subject.scope)
                ? subject.scope[0]
                : null;
              const found = await tx.query<{ id: string }>(
                `SELECT canonical_id AS id FROM connector_source_mappings
               WHERE tenant_id=$1 AND resource=$2 AND external_id=$3 AND connection_id::text=$4
               UNION SELECT id FROM orders_entities WHERE tenant_id=$1 AND kind=$2 AND id::text=$3
               UNION SELECT id FROM inventory_entities WHERE tenant_id=$1 AND kind=$2 AND id::text=$3`,
                [context.tenantId, subjectKind, subjectId, scope ?? ''],
              );
              for (const row of found.rows)
                add(
                  subjectKind as RecordKind,
                  row.id,
                  subjectKind,
                  'Affected record',
                );
            }
          } else {
            const found = await tx.query<{ id: string }>(
              `SELECT DISTINCT e.id FROM exceptions e LEFT JOIN connector_source_mappings m
             ON m.tenant_id=e.tenant_id AND m.resource=$2 AND m.canonical_id=$3
             AND m.external_id=e.document->'subject'->>'subjectId'
             AND m.connection_id::text=e.document->'subject'->'scope'->>0
             WHERE e.tenant_id=$1 AND e.document->'subject'->>'subjectKind'=$2
             AND (e.document->'subject'->>'subjectId'=$3::text OR m.id IS NOT NULL)`,
              [context.tenantId, kind, id],
            );
            for (const row of found.rows)
              add('issue', row.id, 'Issue', 'Investigates');
          }
          const unique = [
            ...new Map(
              links.map((link) => [`${link.kind}:${link.id}`, link]),
            ).values(),
          ];

          return {
            record: summary(rows),
            links: unique,
            snapshots: rows.flatMap((row) =>
              row.connectionId && row.document?.data
                ? [
                    {
                      connectionId: row.connectionId,
                      observedAt: string(row.document.observedAt)!,
                      sourceUpdatedAt: string(row.document.sourceUpdatedAt),
                      data: object(row.document.data),
                    },
                  ]
                : [],
            ),
          };
        },
        { readOnlySnapshot: true },
      );
    },
  };
}
