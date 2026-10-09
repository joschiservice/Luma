import type { TenantContext } from '@luma/identity';
import type { SqlTransaction } from '@luma/platform';

import { hiddenSections } from '../../application/access.js';
import type {
  FulfillmentDetail,
  FulfillmentDetailSection,
} from '../../application/fulfillment.js';
import type { OrderActivityReader } from '../../application/orders.js';
import { resolveOrderEntity } from '../orders/identity-references.js';
import {
  readDirectRunIds,
  readIssues,
  readWorkflowRuns,
} from '../orders/links.js';
import type { OrderReadQueries } from '../orders/list-query.js';
import { iso, object, text } from '../orders/values.js';
import {
  classified,
  itemJson,
  readItem,
  readSources,
  stalledAfterHours,
} from './rules.js';

const activityWindow = 365 * 86_400_000;

// Workflow definitions that correct how an order ships without fulfilling it.
const methodCorrections = new Set(['shipping-method-correction']);

// Reads at most 50 fulfillments matching `where`, most recent progress first.
async function readItems(
  tx: SqlTransaction,
  tenantId: string,
  asOf: string,
  where: string,
  values: unknown[],
) {
  const result = await tx.query<{ item: Record<string, unknown> }>(
    `WITH ${classified(where)}, page AS (
      SELECT * FROM classified c ORDER BY c.progress_at DESC,c.entity_id,c.connection_id LIMIT 50
     )
     SELECT ${itemJson} AS item FROM page c
     JOIN orders_snapshots s ON s.tenant_id=c.tenant_id AND s.id=c.snapshot_id
     ORDER BY c.progress_at DESC,c.entity_id,c.connection_id`,
    [tenantId, asOf, stalledAfterHours, ...values],
  );

  return result.rows.map((row) => readItem(row.item));
}

async function readLines(
  tx: SqlTransaction,
  tenantId: string,
  fulfillmentId: string,
  connectionId: string,
): Promise<FulfillmentDetail['lines']> {
  const result = await tx.query<{
    line: Record<string, unknown>;
    ordered: Record<string, unknown> | null;
  }>(
    `SELECT l AS line,o AS ordered FROM orders_projections p
     JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
     CROSS JOIN LATERAL jsonb_array_elements(s.document->'data'->'lines') WITH ORDINALITY AS fl(l,position)
     LEFT JOIN orders_projections op ON op.tenant_id=p.tenant_id AND op.entity_id=s.order_id AND op.connection_id=p.connection_id
     LEFT JOIN orders_snapshots os ON os.tenant_id=op.tenant_id AND os.id=op.snapshot_id
     LEFT JOIN LATERAL (SELECT ol FROM jsonb_array_elements(os.document->'data'->'lines') ol
      WHERE ol->>'id'=l->>'orderLineId' LIMIT 1) x(o) ON true
     WHERE p.tenant_id=$1 AND p.entity_id=$2 AND p.connection_id=$3
     ORDER BY fl.position`,
    [tenantId, fulfillmentId, connectionId],
  );

  return result.rows.map(({ line, ordered }) => {
    const source = object(ordered);

    return {
      orderLineId: String(line.orderLineId),
      quantity: String(line.quantity),
      unit: String(line.unit),
      skuId: text(source.skuId),
      skuCode: text(source.skuCode),
      title: text(source.title),
      ordered: text(source.quantity),
    };
  });
}

async function readOrder(
  tx: SqlTransaction,
  tenantId: string,
  orderId: string,
  connectionId: string,
): Promise<FulfillmentDetail['order']> {
  const result = await tx.query<{
    document: Record<string, unknown> | null;
    externalId: string | null;
    fulfillment: string | null;
  }>(
    `SELECT s.document,
     (SELECT m.external_id FROM connector_source_mappings m WHERE m.tenant_id=$1 AND m.connection_id=$3
      AND m.resource='order' AND m.canonical_id=$2 ORDER BY m.created_at,m.id LIMIT 1) AS "externalId",
     (SELECT l.fulfillment FROM orders_list l WHERE l.tenant_id=$1 AND l.entity_id=$2 AND l.connection_id=$3) AS fulfillment
     FROM (SELECT 1) one
     LEFT JOIN orders_projections p ON p.tenant_id=$1 AND p.entity_id=$2 AND p.connection_id=$3
     LEFT JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id`,
    [tenantId, orderId, connectionId],
  );
  const row = result.rows[0];
  const data = object(object(row?.document).data);

  return {
    id: orderId,
    number: text(data.displayNumber),
    status: text(data.status),
    paymentStatus: text(data.paymentStatus),
    placedAt: iso(data.placedAt),
    externalId: row?.externalId ?? null,
    fulfillment: row?.fulfillment ?? null,
  };
}

async function readTimeline(
  tx: SqlTransaction,
  tenantId: string,
  fulfillmentId: string,
  connectionId: string,
): Promise<FulfillmentDetail['timeline']> {
  const result = await tx.query<{
    snapshotId: string;
    current: boolean;
    document: Record<string, unknown>;
    observedAt: Date;
    sourceUpdatedAt: Date | null;
  }>(
    `SELECT s.id AS "snapshotId",s.document,s.observed_at AS "observedAt",s.source_updated_at AS "sourceUpdatedAt",
     EXISTS (SELECT 1 FROM orders_projections p WHERE p.tenant_id=s.tenant_id AND p.entity_id=s.entity_id
      AND p.connection_id=s.connection_id AND p.snapshot_id=s.id) AS current
     FROM orders_snapshots s WHERE s.tenant_id=$1 AND s.entity_id=$2 AND s.connection_id=$3
     ORDER BY s.observed_at DESC,s.created_at DESC,s.id DESC LIMIT 51`,
    [tenantId, fulfillmentId, connectionId],
  );

  return {
    entries: result.rows.slice(0, 50).map((row) => {
      const data = object(row.document.data);

      return {
        snapshotId: row.snapshotId,
        current: row.current,
        deleted: row.document.deleted === true,
        observedAt: row.observedAt.toISOString(),
        sourceUpdatedAt: iso(row.sourceUpdatedAt),
        status: text(data.status) ?? 'unknown',
        holds: Array.isArray(data.holds)
          ? data.holds.map((hold) => String(object(hold).reason))
          : null,
        delivery: text(data.delivery),
        lastProgressAt: iso(data.lastProgressAt),
        locationName: text(object(data.location).name),
        fulfillBy: iso(data.fulfillBy),
      };
    }),
    truncated: result.rows.length > 50,
  };
}

/**
 * Reads one fulfillment with its lines, order, the order's other fulfillments, observed states,
 * issues, workflow runs and recent activity. Returns null when the tenant has no current
 * projection of it.
 */
export async function readFulfillment(
  tx: SqlTransaction,
  queries: OrderReadQueries,
  activity: OrderActivityReader,
  context: TenantContext,
  fulfillmentId: string,
  asOf: string,
): Promise<FulfillmentDetail | null> {
  fulfillmentId = await resolveOrderEntity(tx, context.tenantId, fulfillmentId);
  const tenantId = context.tenantId;
  const [item] = await readItems(tx, tenantId, asOf, 'f.entity_id=$4', [
    fulfillmentId,
  ]);
  if (!item) return null;
  const [source] = await readSources(tx, tenantId, [item.connectionId]);
  const order = await readOrder(tx, tenantId, item.order.id, item.connectionId);
  const refs = {
    orderId: item.order.id,
    orderRefs: [item.order.id, ...(order.externalId ? [order.externalId] : [])],
    fulfillmentIds: [fulfillmentId],
    skuIds: [],
  };
  const needsYou = new Set(
    (
      await tx.query<{ id: string }>(
        `SELECT issue_id::text AS id FROM (${queries.attention}) a WHERE order_id=$3::uuid`,
        [tenantId, asOf, item.order.id],
      )
    ).rows.map((row) => row.id),
  );
  const issues = await readIssues(
    tx,
    tenantId,
    refs,
    await readDirectRunIds(tx, tenantId, refs),
    needsYou,
  );
  const issueIds = issues.map((issue) => issue.id);
  const runs = await readWorkflowRuns(tx, tenantId, refs, issueIds);
  const progress = new Map(
    (
      await tx.query<{ id: string; at: Date | null }>(
        `SELECT r.id,(SELECT min(s.observed_at) FROM orders_snapshots s WHERE s.tenant_id=$1 AND s.order_id=$2
          AND s.kind='fulfillment' AND s.status IN ('completed','shipped','delivered')
          AND NOT (s.document->>'deleted')::boolean AND s.observed_at>r.created) AS at
         FROM unnest($3::text[],$4::timestamptz[]) r(id,created) WHERE r.created IS NOT NULL`,
        [
          tenantId,
          item.order.id,
          runs.map((run) => run.id),
          runs.map((run) => run.createdAt),
        ],
      )
    ).rows.map((row) => [row.id, iso(row.at)]),
  );
  const hidden = hiddenSections<FulfillmentDetailSection>(context, [
    ['issues', 'issues.read'],
    ['workflows', 'workflows.read'],
    ['activity', 'activity.read'],
  ]);
  const shown = (section: FulfillmentDetailSection) =>
    !hidden.includes(section);
  const events = shown('activity')
    ? await activity.list(context, {
        from: new Date(Date.parse(asOf) - activityWindow).toISOString(),
        to: new Date(Date.parse(asOf) + 1).toISOString(),
        limit: 25,
        subjects: {
          issueIds,
          runIds: [...new Set(runs.map((run) => run.id))],
          orderRefs: refs.orderRefs,
        },
      })
    : { items: [], nextCursor: null };

  return {
    item,
    source: source ?? {
      connectionId: item.connectionId,
      label: 'Connected source',
      system: null,
      status: 'unknown',
      appId: null,
    },
    lines: await readLines(tx, tenantId, fulfillmentId, item.connectionId),
    order,
    related: await readItems(
      tx,
      tenantId,
      asOf,
      'f.order_id=$4 AND NOT (f.entity_id=$5 AND f.connection_id=$6)',
      [item.order.id, fulfillmentId, item.connectionId],
    ),
    timeline: await readTimeline(
      tx,
      tenantId,
      fulfillmentId,
      item.connectionId,
    ),
    issues: shown('issues') ? issues : [],
    workflows: (shown('workflows') ? runs : []).map((run) => ({
      ...run,
      purpose: methodCorrections.has(run.definitionId)
        ? 'method_correction'
        : 'other',
      progressObservedAt: progress.get(run.id) ?? null,
    })),
    activity: {
      entries: events.items.map((event) => ({
        id: event.id,
        recordedAt: event.recordedAt,
        action: event.action,
        type: event.type,
        outcome: event.outcome,
        actor: event.actor,
        exceptionId: event.exceptionId,
        summary: event.summary,
      })),
      truncated: events.nextCursor !== null,
    },
    hidden,
    stalledAfterHours,
    asOf,
  };
}
