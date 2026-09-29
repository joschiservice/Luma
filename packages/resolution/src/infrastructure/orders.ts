import { createHash } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import { IdentityError, requireTenant } from '@luma/identity';
import type { AttentionOrder } from '@luma/orders';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import type { ActivityStore } from '../application/activity.js';
import type {
  OrderDetail,
  OrderList,
  OrderListItem,
  OrderListQuery,
  OrderSort,
  OrderSource,
  OrderSourceFacts,
  OrderView,
  OrderWorkspace,
} from '../application/orders.js';
import {
  fulfillmentState,
  lineProgress,
  orderDifferences,
  orderOpen,
  orderOverdue,
  sumQuantities,
} from '../domain/orders.js';

interface Readers {
  attention: (
    db: TenantDatabase,
  ) => (tenantId: string, asOf: string) => Promise<AttentionOrder[]>;
  activity: (db: TenantDatabase) => ActivityStore;
}

// Sort keys are compared as text in byte order. Missing values always sort last.
const sortKeys: Record<OrderSort, string> = {
  updated: `to_char(COALESCE(o.source_updated_at,o.observed_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')`,
  placed: `to_char(o.placed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')`,
  // Length first keeps "#999" before "#1001" for numbering schemes with a shared prefix. The
  // key is capped so cursors stay small; the order ID still breaks ties deterministically.
  number: `lpad(length(o.display_number)::text,6,'0')||left(lower(o.display_number),120)`,
  due: `to_char(o.due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')`,
};

const viewFilters: Record<OrderView, string> = {
  all: 'true',
  outstanding: 'o.open IS TRUE',
  overdue: 'o.overdue IS TRUE',
  needs_you:
    'NOT o.deleted AND o.entity_id IN (SELECT order_id FROM attention)',
  differs: 'o.entity_id IN (SELECT entity_id FROM differs WHERE differs)',
};

// $1 tenant, $2 asOf. Current order snapshots, one per source.
const current = `current AS MATERIALIZED (
 SELECT p.entity_id,p.connection_id,s.document->'data' AS data,s.status,s.payment_status,s.display_number,
 s.observed_at,s.source_updated_at,(s.document->>'deleted')::boolean AS deleted
 FROM orders_projections p JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
 WHERE p.tenant_id=$1 AND s.kind='order'
)`;

// Same-source fulfilled quantities per order line, as in the order metrics.
const fulfilledOver = (set: string) => `fulfilled AS MATERIALIZED (
 SELECT r.order_id,p.connection_id,l->>'orderLineId' AS line_id,sum((l->>'quantity')::numeric) AS quantity
 FROM ${set} o
 JOIN orders_relationships r ON r.tenant_id=$1 AND r.order_id=o.entity_id
 JOIN orders_projections p ON p.tenant_id=r.tenant_id AND p.entity_id=r.child_id AND p.connection_id=o.connection_id
 JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
 CROSS JOIN LATERAL jsonb_array_elements(s.document->'data'->'lines') l
 WHERE s.kind='fulfillment' AND s.status IN ('completed','shipped','delivered')
 AND NOT (s.document->>'deleted')::boolean AND s.observed_at <= $2
 GROUP BY r.order_id,p.connection_id,l->>'orderLineId'
)`;

// Mirrors lineProgress, fulfillmentState, orderOpen and orderOverdue in the domain layer.
const classifiedOver = (set: string) => `classified AS MATERIALIZED (
 SELECT o.*,g.line_count,open,CASE WHEN g.line_count=0 THEN 'no_lines'
  WHEN g.any_remaining OR g.any_unknown THEN CASE WHEN g.any_fulfilled THEN 'partial' ELSE 'unfulfilled' END
  WHEN g.any_fulfilled THEN 'fulfilled' ELSE 'not_required' END AS fulfillment,
 CASE WHEN open=false THEN false WHEN open IS NULL OR o.due_at IS NULL THEN NULL ELSE o.due_at < $2 END AS overdue
 FROM ${set} o CROSS JOIN LATERAL (
  SELECT count(*)::int AS line_count,COALESCE(bool_or(remaining>0),false) AS any_remaining,
  COALESCE(bool_or(remaining IS NULL),false) AS any_unknown,COALESCE(bool_or(done>0),false) AS any_fulfilled
  FROM (SELECT COALESCE(f.quantity,0) AS done,
   CASE WHEN COALESCE(f.quantity,0) >= (l->>'quantity')::numeric THEN 0
   ELSE (l->>'quantity')::numeric-(l->>'cancelledQuantity')::numeric-COALESCE(f.quantity,0) END AS remaining
   FROM jsonb_array_elements(o.data->'lines') l
   LEFT JOIN fulfilled f ON f.order_id=o.entity_id AND f.connection_id=o.connection_id AND f.line_id=l->>'id') q
 ) g CROSS JOIN LATERAL (SELECT CASE WHEN o.observed_at > $2 THEN NULL
  WHEN o.deleted OR o.status IN ('completed','cancelled') THEN false
  WHEN o.status<>'open' OR g.line_count=0 THEN NULL
  WHEN g.any_remaining THEN true WHEN g.any_unknown THEN NULL ELSE false END AS open) state
)`;

// Mirrors orderDifferences: unknown values never count, and numbers and dates are not compared.
const differsOver = (set: string) => `differs AS MATERIALIZED (
 SELECT p.entity_id,count(*)>1 AND (count(DISTINCT NULLIF(s.status,'unknown'))>1
 OR count(DISTINCT NULLIF(s.payment_status,'unknown'))>1
 OR count(DISTINCT CASE WHEN jsonb_typeof(s.document->'data'->'total')='object'
  THEN trim_scale((s.document->'data'->'total'->>'amount')::numeric)::text||' '||(s.document->'data'->'total'->>'currency') END)>1
 OR count(DISTINCT (SELECT COALESCE(string_agg(k||':'||trim_scale(q)::text,',' ORDER BY (k||':'||trim_scale(q)::text) COLLATE "C"),'')
  FROM (SELECT COALESCE(l->>'skuId','unmapped') AS k,sum((l->>'quantity')::numeric) AS q
  FROM jsonb_array_elements(s.document->'data'->'lines') l GROUP BY 1) lines))>1) AS differs
 FROM orders_projections p JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
 WHERE p.tenant_id=$1 AND s.kind='order' AND NOT (s.document->>'deleted')::boolean
 AND p.entity_id IN (SELECT entity_id FROM ${set})
 GROUP BY p.entity_id
)`;

function listSql(view: OrderView, sort: OrderSort, direction: 'asc' | 'desc') {
  const byProgress = view === 'outstanding' || view === 'overdue';
  const op = direction === 'desc' ? '<' : '>';
  const order = `sort_rank,sort_key ${direction},entity_id ${direction}`;
  const filtered = (set: string) => `filtered AS MATERIALIZED (
 SELECT o.*,CASE WHEN (${sortKeys[sort]}) IS NULL THEN 1 ELSE 0 END AS sort_rank,
 COALESCE(${sortKeys[sort]},'') COLLATE "C" AS sort_key
 FROM ${set} o WHERE ${viewFilters[view]}
), page AS MATERIALIZED (
 SELECT * FROM filtered
 WHERE $14::int IS NULL OR sort_rank>$14 OR (sort_rank=$14 AND (sort_key ${op} $15 OR (sort_key=$15 AND entity_id ${op} $16::uuid)))
 ORDER BY ${order} LIMIT $13
)`;
  // Only open, current orders can have outstanding work, so the rest need no classification.
  const candidates = `candidates AS MATERIALIZED (
 SELECT * FROM matched WHERE status='open' AND NOT deleted AND observed_at <= $2${view === 'overdue' ? ' AND due_at < $2' : ''}
)`;
  const steps = byProgress
    ? [
        candidates,
        fulfilledOver('candidates'),
        classifiedOver('candidates'),
        filtered('classified'),
        differsOver('page'),
        'rows AS (SELECT * FROM page)',
      ]
    : [
        ...(view === 'differs' ? [differsOver('matched')] : []),
        filtered('matched'),
        fulfilledOver('page'),
        classifiedOver('page'),
        ...(view === 'differs' ? [] : [differsOver('page')]),
        'rows AS (SELECT * FROM classified)',
      ];

  return `WITH ${current}, selected AS MATERIALIZED (
 SELECT DISTINCT ON (entity_id) * FROM current WHERE ($3::uuid IS NULL OR connection_id=$3)
 ORDER BY entity_id,source_updated_at DESC NULLS LAST,observed_at DESC,connection_id
), sku_hits AS MATERIALIZED (
 SELECT DISTINCT canonical_id::text AS id FROM connector_source_mappings
 WHERE $6<>'' AND tenant_id=$1 AND resource='sku' AND external_id ILIKE $7
), hits AS MATERIALIZED (
 SELECT entity_id AS id FROM current WHERE $6<>'' AND (display_number ILIKE $7 OR entity_id::text=lower($6)
  OR EXISTS (SELECT 1 FROM jsonb_array_elements(data->'lines') l
   WHERE l->>'skuCode' ILIKE $7 OR l->>'skuId' IN (SELECT id FROM sku_hits)))
 UNION SELECT canonical_id FROM connector_source_mappings
 WHERE $6<>'' AND tenant_id=$1 AND resource='order' AND external_id ILIKE $7
), matched AS MATERIALIZED (
 SELECT o.*,(o.data->>'placedAt')::timestamptz AS placed_at,(o.data->>'dueAt')::timestamptz AS due_at
 FROM selected o
 WHERE ($4::text IS NULL OR o.status=$4) AND ($5::text IS NULL OR o.payment_status=$5)
 AND ($8::timestamptz IS NULL OR (o.data->>'placedAt')::timestamptz >= $8)
 AND ($9::timestamptz IS NULL OR (o.data->>'placedAt')::timestamptz < $9)
 AND ($10::timestamptz IS NULL OR o.source_updated_at >= $10)
 AND ($11::timestamptz IS NULL OR o.source_updated_at < $11)
 AND ($6='' OR o.entity_id IN (SELECT id FROM hits))
), attention AS MATERIALIZED (
 SELECT (a->>'orderId')::uuid AS order_id,array_agg(DISTINCT (a->>'issueId')::uuid ORDER BY (a->>'issueId')::uuid) AS issue_ids
 FROM jsonb_array_elements($12::jsonb) a GROUP BY 1
), ${steps.join(', ')}, items AS (
SELECT o.entity_id AS id,o.display_number AS "displayNumber",o.placed_at AS "placedAt",
 o.data->'total' AS total,o.status,o.payment_status AS "paymentStatus",o.fulfillment,
 o.line_count AS "lineCount",o.open,o.overdue,o.due_at AS "dueAt",
 CASE WHEN o.deleted THEN '{}'::uuid[] ELSE COALESCE(a.issue_ids,'{}'::uuid[]) END AS "issueIds",
 COALESCE(d.differs,false) AS differs,src.sources,o.observed_at AS "observedAt",o.source_updated_at AS "sourceUpdatedAt",
 o.sort_rank AS "sortRank",o.sort_key AS "sortKey"
FROM rows o
LEFT JOIN attention a ON a.order_id=o.entity_id
LEFT JOIN differs d ON d.entity_id=o.entity_id
CROSS JOIN LATERAL (
 SELECT jsonb_agg(jsonb_build_object('connectionId',c.connection_id,
  'label',COALESCE(ci.document->>'label',ci.document->'target'->>'kind','Connected source'),
  'system',ci.document->'target'->>'kind','connectionStatus',COALESCE(ci.document->>'status','unknown'),
  'externalId',m.external_id,'selected',c.connection_id=o.connection_id,'deleted',c.deleted,
  'observedAt',c.document->>'observedAt','sourceUpdatedAt',c.document->>'sourceUpdatedAt') ORDER BY c.connection_id) AS sources
 FROM (SELECT p.entity_id,p.connection_id,s.document,(s.document->>'deleted')::boolean AS deleted
  FROM orders_projections p JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
  WHERE p.tenant_id=$1 AND p.entity_id=o.entity_id AND s.kind='order') c
 LEFT JOIN connector_installations ci ON ci.tenant_id=$1 AND ci.id=c.connection_id
 LEFT JOIN LATERAL (SELECT external_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=c.connection_id
  AND resource='order' AND canonical_id=c.entity_id ORDER BY created_at,id LIMIT 1) m ON true
) src)
SELECT (SELECT count(*) FROM filtered)::int AS "totalCount",
 COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i."sortRank",i."sortKey" ${direction},i.id ${direction}) FROM items i),'[]'::jsonb) AS items`;
}

type ListRow = Omit<
  OrderListItem,
  'placedAt' | 'dueAt' | 'observedAt' | 'sourceUpdatedAt' | 'sources' | 'total'
> & {
  placedAt: string | null;
  dueAt: string | null;
  observedAt: string;
  sourceUpdatedAt: string | null;
  total: unknown;
  sources: Record<string, unknown>[];
  sortRank: number;
  sortKey: string;
};

const cursorSchema = z
  .object({
    context: z.string(),
    rank: z.number().int().min(0).max(1),
    key: z.string().max(200),
    id: z.string().uuid(),
  })
  .strict();

function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);

  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function money(value: unknown) {
  const total = object(value);

  return typeof total.amount === 'string' && typeof total.currency === 'string'
    ? { amount: total.amount, currency: total.currency }
    : null;
}

function source(value: Record<string, unknown>): OrderSource {
  return {
    connectionId: String(value.connectionId),
    label: text(value.label) ?? 'Connected source',
    system: text(value.system),
    connectionStatus: text(value.connectionStatus) ?? 'unknown',
    externalId: text(value.externalId),
    selected: value.selected === true,
    deleted: value.deleted === true,
    observedAt: iso(value.observedAt)!,
    sourceUpdatedAt: iso(value.sourceUpdatedAt),
  };
}

// Escape ILIKE wildcards so search text is matched literally.
function pattern(query: string) {
  return `%${query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

function cursorContext(tenantId: string, query: OrderListQuery) {
  const scope: Partial<OrderListQuery> = { ...query };
  delete scope.cursor;

  return createHash('sha256')
    .update(JSON.stringify(['orders-v1', tenantId, scope]))
    .digest('hex');
}

function readCursor(value: string, context: string) {
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error('Encoding');
    const cursor = cursorSchema.parse(JSON.parse(bytes.toString()));
    if (cursor.context !== context) throw new Error('Context');

    return cursor;
  } catch {
    throw Object.assign(
      new Error(
        'This page link no longer matches the order filters. Start from the first page.',
      ),
      { statusCode: 400 },
    );
  }
}

async function listOrders(
  tx: SqlTransaction,
  context: TenantContext,
  query: OrderListQuery,
  attention: AttentionOrder[],
  asOf: string,
): Promise<OrderList> {
  const scope = cursorContext(context.tenantId, query);
  const after = query.cursor ? readCursor(query.cursor, scope) : null;
  const result = await tx.query<{ totalCount: number; items: ListRow[] }>(
    listSql(query.view, query.sort, query.direction),
    [
      context.tenantId,
      asOf,
      query.connectionId ?? null,
      query.status ?? null,
      query.paymentStatus ?? null,
      query.q,
      pattern(query.q),
      query.placedFrom ?? null,
      query.placedBefore ?? null,
      query.updatedFrom ?? null,
      query.updatedBefore ?? null,
      JSON.stringify(attention),
      query.limit + 1,
      after?.rank ?? null,
      after?.key ?? null,
      after?.id ?? null,
    ],
  );
  const { totalCount, items } = result.rows[0]!;
  const rows = items.slice(0, query.limit);
  const last = rows.at(-1);

  return {
    items: rows.map((row) => ({
      id: row.id,
      displayNumber: row.displayNumber,
      placedAt: iso(row.placedAt),
      total: money(row.total),
      status: row.status,
      paymentStatus: row.paymentStatus,
      fulfillment: row.fulfillment,
      lineCount: row.lineCount,
      open: row.open,
      overdue: row.overdue,
      dueAt: iso(row.dueAt),
      issueIds: row.issueIds,
      differs: row.differs,
      sources: row.sources.map(source),
      observedAt: iso(row.observedAt)!,
      sourceUpdatedAt: iso(row.sourceUpdatedAt),
    })),
    totalCount,
    nextCursor:
      items.length > query.limit && last
        ? Buffer.from(
            JSON.stringify({
              context: scope,
              rank: last.sortRank,
              key: last.sortKey,
              id: last.id,
            }),
          ).toString('base64url')
        : null,
    asOf,
  };
}

type SnapshotRow = {
  connectionId: string;
  document: Record<string, unknown>;
  connection: Record<string, unknown> | null;
  externalId: string | null;
  mappingMethod: string | null;
};

async function readDetail(
  tx: SqlTransaction,
  context: TenantContext,
  orderId: string,
  attention: AttentionOrder[],
  activity: ActivityStore,
  asOf: string,
): Promise<OrderDetail | null> {
  const tenantId = context.tenantId;
  const snapshots = await tx.query<SnapshotRow>(
    `SELECT p.connection_id AS "connectionId",s.document,ci.document AS connection,
     m.external_id AS "externalId",m.method AS "mappingMethod"
     FROM orders_projections p JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
     LEFT JOIN connector_installations ci ON ci.tenant_id=p.tenant_id AND ci.id=p.connection_id
     LEFT JOIN LATERAL (SELECT external_id,method FROM connector_source_mappings WHERE tenant_id=$1
      AND connection_id=p.connection_id AND resource='order' AND canonical_id=p.entity_id
      ORDER BY created_at,id LIMIT 1) m ON true
     WHERE p.tenant_id=$1 AND p.entity_id=$2 AND s.kind='order'
     ORDER BY p.connection_id`,
    [tenantId, orderId],
  );
  if (!snapshots.rows.length) return null;
  const fulfillmentRows = await tx.query<{
    id: string;
    connectionId: string;
    document: Record<string, unknown>;
    externalId: string | null;
  }>(
    `SELECT p.entity_id AS id,p.connection_id AS "connectionId",s.document,m.external_id AS "externalId"
     FROM orders_relationships r
     JOIN orders_projections p ON p.tenant_id=r.tenant_id AND p.entity_id=r.child_id
     JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id AND s.kind='fulfillment'
     LEFT JOIN LATERAL (SELECT external_id FROM connector_source_mappings WHERE tenant_id=$1
      AND connection_id=p.connection_id AND resource='fulfillment' AND canonical_id=p.entity_id
      ORDER BY created_at,id LIMIT 1) m ON true
     WHERE r.tenant_id=$1 AND r.order_id=$2
     ORDER BY s.observed_at DESC,p.entity_id,p.connection_id`,
    [tenantId, orderId],
  );
  const fulfillments = fulfillmentRows.rows.map((row) => {
    const data = object(row.document.data);

    return {
      id: row.id,
      connectionId: row.connectionId,
      externalId: row.externalId,
      status: text(data.status) ?? 'unknown',
      lastProgressAt: iso(data.lastProgressAt),
      failureCode: text(data.failureCode),
      deleted: row.document.deleted === true,
      observedAt: iso(row.document.observedAt)!,
      sourceUpdatedAt: iso(row.document.sourceUpdatedAt),
      lines: (Array.isArray(data.lines) ? data.lines : []).map((value) => {
        const line = object(value);

        return {
          orderLineId: String(line.orderLineId),
          quantity: String(line.quantity),
          unit: String(line.unit),
        };
      }),
    };
  });
  // Fulfilled quantities come from the same source's shipped, delivered or completed work.
  const fulfilled = new Map<string, string[]>();
  for (const item of fulfillments) {
    if (
      item.deleted ||
      !['completed', 'shipped', 'delivered'].includes(item.status) ||
      Date.parse(item.observedAt) > Date.parse(asOf)
    )
      continue;
    for (const line of item.lines) {
      const key = `${item.connectionId}:${line.orderLineId}`;
      fulfilled.set(key, [...(fulfilled.get(key) ?? []), line.quantity]);
    }
  }
  const sources: OrderSourceFacts[] = snapshots.rows.map((row) => {
    const data = object(row.document.data);
    const connection = object(row.connection);
    const lines = (Array.isArray(data.lines) ? data.lines : []).map((value) => {
      const line = object(value);
      const facts = {
        id: String(line.id),
        skuId: text(line.skuId),
        quantity: String(line.quantity),
        cancelledQuantity: text(line.cancelledQuantity),
      };
      const done = fulfilled.get(`${row.connectionId}:${facts.id}`);

      return {
        ...facts,
        skuCode: text(line.skuCode),
        title: text(line.title),
        unit: String(line.unit),
        ...lineProgress(facts, done ? sumQuantities(done) : undefined),
      };
    });
    const deleted = row.document.deleted === true;
    const status = text(data.status) ?? 'unknown';

    return {
      connectionId: row.connectionId,
      label:
        text(connection.label) ??
        text(object(connection.target).kind) ??
        'Connected source',
      system: text(object(connection.target).kind),
      connectionStatus: text(connection.status) ?? 'unknown',
      appId: text(connection.appId),
      externalId: row.externalId,
      mappingMethod: row.mappingMethod,
      selected: false,
      deleted,
      observedAt: iso(row.document.observedAt)!,
      sourceUpdatedAt: iso(row.document.sourceUpdatedAt),
      displayNumber: text(data.displayNumber),
      status,
      paymentStatus: text(data.paymentStatus) ?? 'unknown',
      placedAt: iso(data.placedAt),
      total: money(data.total),
      dueAt: iso(data.dueAt),
      fulfillment: fulfillmentState(lines),
      open: orderOpen({ status, deleted }, lines),
      lines,
    };
  });
  // Select the source with the newest source update, as the order metrics do.
  const compare = (left: string, right: string) =>
    left < right ? -1 : left > right ? 1 : 0;
  const selected = [...sources].sort(
    (left, right) =>
      Number(right.sourceUpdatedAt !== null) -
        Number(left.sourceUpdatedAt !== null) ||
      compare(right.sourceUpdatedAt ?? '', left.sourceUpdatedAt ?? '') ||
      compare(right.observedAt, left.observedAt) ||
      compare(left.connectionId, right.connectionId),
  )[0]!;
  selected.selected = true;
  const differences = orderDifferences(sources);
  const skuIds = [
    ...new Set(
      sources.flatMap((item) =>
        item.lines.flatMap((line) => (line.skuId ? [line.skuId] : [])),
      ),
    ),
  ];
  const orderRefs = [
    orderId,
    ...sources.flatMap((item) => (item.externalId ? [item.externalId] : [])),
  ];
  const directRuns = await tx.query<{ id: string }>(
    `SELECT id::text FROM playbook_runs WHERE tenant_id=$1
      AND document->'action'->'target'->>'kind'='order' AND document->'action'->'target'->>'id'=ANY($2)
     UNION SELECT id::text FROM workflow_trigger_runs WHERE tenant_id=$1
      AND document->'subject'->>'kind'='order' AND document->'subject'->>'id'=ANY($2)`,
    [tenantId, orderRefs],
  );
  const issueRows = await tx.query<{
    id: string;
    class: string | null;
    state: string;
    severity: string | null;
    lastDetectedAt: string | null;
    subjectKind: string;
  }>(
    `SELECT e.id,e.document->>'exceptionClass' AS class,e.state,e.document->>'severity' AS severity,
     e.document->>'lastDetectedAt' AS "lastDetectedAt",e.document->'subject'->>'subjectKind' AS "subjectKind"
     FROM exceptions e WHERE e.tenant_id=$1 AND (
      (e.document->'subject'->>'subjectKind'='fulfillment' AND EXISTS (SELECT 1 FROM connector_source_mappings m
       WHERE m.tenant_id=$1 AND m.resource='fulfillment' AND m.scope_key=''
       AND m.connection_id::text=e.document->'subject'->'scope'->>0
       AND m.external_id=e.document->'subject'->>'subjectId' AND m.canonical_id=ANY($3::uuid[])))
      OR (e.document->'subject'->>'subjectKind'='order' AND (e.document->'subject'->>'subjectId'=$2::text
       OR EXISTS (SELECT 1 FROM connector_source_mappings m WHERE m.tenant_id=$1 AND m.resource='order'
       AND m.connection_id::text=e.document->'subject'->'scope'->>0
       AND m.external_id=e.document->'subject'->>'subjectId' AND m.canonical_id=$2::uuid)))
      OR (e.document->'subject'->>'subjectKind'='sku' AND (e.document->'subject'->>'subjectId'=ANY($4)
       OR EXISTS (SELECT 1 FROM connector_source_mappings m WHERE m.tenant_id=$1 AND m.resource='sku'
       AND m.external_id=e.document->'subject'->>'subjectId' AND m.canonical_id::text=ANY($4))))
      OR (e.document->'subject'->>'subjectKind'='workflow_run' AND e.document->'subject'->>'subjectId'=ANY($5))
     )
     ORDER BY e.state='resolved',e.document->>'lastDetectedAt' DESC,e.id LIMIT 50`,
    [
      tenantId,
      orderId,
      [...new Set(fulfillments.map((item) => item.id))],
      skuIds,
      directRuns.rows.map((row) => row.id),
    ],
  );
  const needsYou = new Set(
    attention
      .filter((item) => item.orderId === orderId)
      .map((item) => item.issueId),
  );
  const issues = issueRows.rows.map((row) => ({
    id: row.id,
    class: row.class ?? 'unknown',
    state: row.state,
    severity: row.severity,
    relationship: (row.subjectKind === 'sku'
      ? 'sku'
      : row.subjectKind === 'order'
        ? 'order'
        : 'fulfillment') as 'order' | 'fulfillment' | 'sku',
    needsYou: needsYou.has(row.id),
    lastDetectedAt: iso(row.lastDetectedAt),
  }));
  const issueIds = issues.map((issue) => issue.id);
  const runRows = await tx.query<{
    id: string;
    definitionId: string;
    name: string | null;
    version: string;
    createdAt: string | null;
    state: string;
    relationship: 'order' | 'issue';
  }>(
    `SELECT * FROM (
      SELECT r.id,r.definition_id AS "definitionId",d.document->>'name' AS name,r.version,
      r.document->>'createdAt' AS "createdAt",COALESCE(o.document->>'state','recorded') AS state,
      CASE WHEN r.document->'action'->'target'->>'kind'='order' AND r.document->'action'->'target'->>'id'=ANY($2)
       THEN 'order' ELSE 'issue' END AS relationship
      FROM playbook_runs r
      LEFT JOIN playbook_definitions d ON d.tenant_id=r.tenant_id AND d.id=r.definition_id
      LEFT JOIN LATERAL (SELECT document FROM playbook_outcomes WHERE tenant_id=r.tenant_id AND run_id=r.id
       ORDER BY sequence DESC LIMIT 1) o ON true
      WHERE r.tenant_id=$1 AND ((r.document->'action'->'target'->>'kind'='order'
       AND r.document->'action'->'target'->>'id'=ANY($2)) OR r.document->>'incidentId'=ANY($3))
      UNION ALL
      SELECT w.id,w.definition_id,d.document->>'name',w.version,
      COALESCE(w.document->>'createdAt',w.triggered_at::text),w.state,'order'
      FROM workflow_trigger_runs w
      LEFT JOIN playbook_definitions d ON d.tenant_id=w.tenant_id AND d.id=w.definition_id
      WHERE w.tenant_id=$1 AND w.document->'subject'->>'kind'='order' AND w.document->'subject'->>'id'=ANY($2)
     ) runs ORDER BY "createdAt" DESC NULLS LAST,id LIMIT 50`,
    [tenantId, orderRefs, issueIds],
  );
  const workflows = runRows.rows.map((row) => ({
    ...row,
    createdAt: iso(row.createdAt),
  }));
  const history = await tx.query<{
    snapshotId: string;
    entityKind: 'order' | 'fulfillment';
    entityId: string;
    connectionId: string;
    status: string | null;
    paymentStatus: string | null;
    deleted: boolean;
    current: boolean;
    observedAt: Date;
    sourceUpdatedAt: Date | null;
  }>(
    `SELECT s.id AS "snapshotId",s.kind AS "entityKind",s.entity_id AS "entityId",s.connection_id AS "connectionId",
     s.status,s.payment_status AS "paymentStatus",(s.document->>'deleted')::boolean AS deleted,
     EXISTS (SELECT 1 FROM orders_projections p WHERE p.tenant_id=s.tenant_id AND p.entity_id=s.entity_id
      AND p.connection_id=s.connection_id AND p.snapshot_id=s.id) AS current,
     s.observed_at AS "observedAt",s.source_updated_at AS "sourceUpdatedAt"
     FROM orders_snapshots s
     WHERE s.tenant_id=$1 AND (s.entity_id=$2 OR s.entity_id IN (
      SELECT child_id FROM orders_relationships WHERE tenant_id=$1 AND order_id=$2))
     ORDER BY s.observed_at DESC,s.created_at DESC,s.id DESC LIMIT 101`,
    [tenantId, orderId],
  );
  const events = await activity.list(context, {
    from: new Date(Date.parse(asOf) - 365 * 86_400_000).toISOString(),
    to: new Date(Date.parse(asOf) + 1).toISOString(),
    limit: 25,
    subjects: {
      issueIds,
      runIds: [...new Set([...workflows.map((run) => run.id)])],
      orderRefs,
    },
  });
  const selectedFacts = selected;
  // Needs-you issues follow the list and metrics rule: removed orders need no attention.
  const orderIssueIds = selectedFacts.deleted
    ? []
    : [...needsYou].sort((left, right) => left.localeCompare(right));

  return {
    order: {
      id: orderId,
      displayNumber: selectedFacts.displayNumber,
      placedAt: selectedFacts.placedAt,
      total: selectedFacts.total,
      status: selectedFacts.status,
      paymentStatus: selectedFacts.paymentStatus,
      fulfillment: selectedFacts.fulfillment,
      lineCount: selectedFacts.lines.length,
      open: selectedFacts.open,
      overdue: orderOverdue(selectedFacts.open, selectedFacts.dueAt, asOf),
      dueAt: selectedFacts.dueAt,
      issueIds: orderIssueIds,
      differs: differences.length > 0,
      sources: sources.map((item) => ({
        connectionId: item.connectionId,
        label: item.label,
        system: item.system,
        connectionStatus: item.connectionStatus,
        externalId: item.externalId,
        selected: item.selected,
        deleted: item.deleted,
        observedAt: item.observedAt,
        sourceUpdatedAt: item.sourceUpdatedAt,
      })),
      observedAt: selectedFacts.observedAt,
      sourceUpdatedAt: selectedFacts.sourceUpdatedAt,
    },
    sources,
    differences,
    fulfillments,
    issues,
    workflows,
    history: {
      entries: history.rows.slice(0, 100).map((row) => ({
        ...row,
        status: row.status ?? 'unknown',
        observedAt: row.observedAt.toISOString(),
        sourceUpdatedAt: iso(row.sourceUpdatedAt),
      })),
      truncated: history.rows.length > 100,
    },
    activity: {
      entries: events.items.map((event) => ({
        id: event.id,
        recordedAt: event.recordedAt,
        action: event.action,
        type: event.type,
        outcome: event.outcome,
        actorKind: event.actorKind,
        exceptionId: event.exceptionId,
        summary: event.summary,
      })),
      truncated: events.nextCursor !== null,
    },
    asOf,
  };
}

/**
 * Reads the Orders workspace from canonical projections in one repeatable-read snapshot.
 * Needs-you uses the same persisted attention rules as the inbox and order metrics.
 */
export function createOrderWorkspace(
  db: TenantDatabase,
  readers: Readers,
  refreshContext: (context: TenantContext) => Promise<TenantContext>,
  now = () => new Date(),
): OrderWorkspace {
  async function read<T>(
    context: TenantContext,
    operation: (
      tx: SqlTransaction,
      scoped: TenantDatabase,
      fresh: TenantContext,
      asOf: string,
    ) => Promise<T>,
  ) {
    const fresh = await refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Actor changed');
    const asOf = now().toISOString();

    return db.transaction(
      fresh.tenantId,
      async (tx) => {
        await tx.query("SET LOCAL statement_timeout = '4000ms'");
        const scoped: TenantDatabase = {
          transaction: async (tenantId, next) => {
            requireTenant(fresh, tenantId);

            return next(tx);
          },
        };

        return operation(tx, scoped, fresh, asOf);
      },
      { readOnlySnapshot: true },
    );
  }

  return {
    list: (context, query) =>
      read(context, async (tx, scoped, fresh, asOf) =>
        listOrders(
          tx,
          fresh,
          query,
          await readers.attention(scoped)(fresh.tenantId, asOf),
          asOf,
        ),
      ),
    get: (context, orderId) =>
      read(context, async (tx, scoped, fresh, asOf) =>
        readDetail(
          tx,
          fresh,
          orderId,
          await readers.attention(scoped)(fresh.tenantId, asOf),
          readers.activity(scoped),
          asOf,
        ),
      ),
  };
}
