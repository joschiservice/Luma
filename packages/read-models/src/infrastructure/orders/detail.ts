import type { AuthorityReader } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import type { SqlTransaction } from '@luma/platform';

import { hiddenSections } from '../../application/access.js';
import { resolveOrderFacts } from '../../application/order-authority.js';
import type {
  OrderActivityReader,
  OrderDetail,
  OrderDetailSection,
} from '../../application/orders.js';
import type { ReturnListItem } from '../../application/returns.js';
import { itemColumns } from '../returns/list.js';
import { readSourceFacts } from './detail-facts.js';
import {
  orderEntityAliases,
  resolveOrderEntity,
} from './identity-references.js';
import {
  readDirectRunIds,
  readHistory,
  readIssues,
  readWorkflowRuns,
} from './links.js';
import type { OrderReadQueries } from './list-query.js';
import { iso, object, text } from './values.js';

const activityWindow = 365 * 86_400_000;

// $1 tenant, $2 as-of time, $3 order ID.
function attentionSql(queries: OrderReadQueries) {
  return `SELECT issue_id::text AS id FROM (${queries.attention}) a WHERE order_id=$3::uuid ORDER BY issue_id`;
}

async function readFulfillments(
  tx: SqlTransaction,
  tenantId: string,
  orderId: string,
): Promise<OrderDetail['fulfillments']> {
  const result = await tx.query<{
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

  return result.rows.map((row) => {
    const data = object(row.document.data);

    return {
      id: row.id,
      connectionId: row.connectionId,
      externalId: row.externalId,
      status: text(data.status) ?? 'unknown',
      kind: text(data.kind),
      lastProgressAt: iso(data.lastProgressAt),
      failureCode: text(data.failureCode),
      deleted: row.document.deleted === true,
      observedAt: iso(row.document.observedAt)!,
      sourceUpdatedAt: iso(row.document.sourceUpdatedAt),
      location: data.location
        ? {
            locationId: text(object(data.location).locationId),
            name: text(object(data.location).name),
          }
        : null,
      tracking: Array.isArray(data.tracking)
        ? data.tracking.map((value) => {
            const tracking = object(value);

            return {
              carrier: text(tracking.carrier),
              number: text(tracking.number),
              url: text(tracking.url),
            };
          })
        : null,
      lines: (Array.isArray(data.lines) ? data.lines : []).map((value) => {
        const line = object(value);

        return {
          orderLineId: String(line.orderLineId),
          remainingQuantity: text(line.remainingQuantity),
          quantity: String(line.quantity),
          unit: String(line.unit),
        };
      }),
    };
  });
}

/**
 * Reads one order with every source's facts, differences, fulfillments, history, linked issues,
 * workflow runs and recent activity. Sections of areas the reader can't read are empty and
 * listed in `hidden`. Returns null when the order has no current source.
 */
export async function readDetail(
  tx: SqlTransaction,
  queries: OrderReadQueries,
  activity: OrderActivityReader,
  authority: AuthorityReader,
  context: TenantContext,
  orderId: string,
  asOf: string,
): Promise<OrderDetail | null> {
  const tenantId = context.tenantId;
  const requestedId = orderId;
  orderId = await resolveOrderEntity(tx, tenantId, orderId);
  const orderIds = await orderEntityAliases(tx, tenantId, [orderId]);
  const facts = await readSourceFacts(tx, queries, tenantId, orderId, asOf);
  if (!facts) return null;
  const { sources, overdue, comparisonState } = facts;
  const selected = sources.find((source) => source.selected)!;
  const fulfillments = await readFulfillments(tx, tenantId, orderId);
  const refs = {
    orderId,
    orderIds,
    orderRefs: [
      ...orderIds,
      ...sources.flatMap((item) => (item.externalId ? [item.externalId] : [])),
    ],
    fulfillmentIds: await orderEntityAliases(tx, tenantId, [
      ...new Set(fulfillments.map((item) => item.id)),
    ]),
    skuIds: [
      ...new Set(
        sources.flatMap((item) =>
          item.lines.flatMap((line) => (line.skuId ? [line.skuId] : [])),
        ),
      ),
    ],
  };
  const needsYou = new Set(
    (
      await tx.query<{ id: string }>(attentionSql(queries), [
        tenantId,
        asOf,
        orderId,
      ])
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
  const workflows = await readWorkflowRuns(tx, tenantId, refs, issueIds);
  const history = await readHistory(tx, tenantId, orderIds);
  const returns = await tx.query<ReturnListItem>(
    `SELECT ${itemColumns} FROM orders_returns r WHERE r.tenant_id=$1 AND r.order_id=$2
     ORDER BY r.requested_key DESC,r.entity_id LIMIT 50`,
    [tenantId, orderId],
  );
  const hidden = hiddenSections<OrderDetailSection>(context, [
    ['fulfillments', 'fulfillment.read'],
    ['returns', 'returns.read'],
    ['issues', 'issues.read'],
    ['workflows', 'workflows.read'],
    ['activity', 'activity.read'],
  ]);
  const shown = (section: OrderDetailSection) => !hidden.includes(section);
  const events = shown('activity')
    ? await activity.list(context, {
        from: new Date(Date.parse(asOf) - activityWindow).toISOString(),
        to: new Date(Date.parse(asOf) + 1).toISOString(),
        limit: 25,
        subjects: {
          issueIds,
          runIds: [...new Set(workflows.map((run) => run.id))],
          orderRefs: refs.orderRefs,
        },
      })
    : { items: [], nextCursor: null };

  const resolved = resolveOrderFacts(
    await authority.read(context),
    sources,
    shown('fulfillments') ? fulfillments : null,
  );
  const differences = facts.differences.map((difference) => {
    const group =
      difference.field === 'status' || difference.field === 'cancelledQuantity'
        ? 'order_lifecycle'
        : [
              'fulfilledQuantity',
              'remainingQuantity',
              'fulfillment',
              'location',
              'overfulfillment',
            ].includes(difference.field)
          ? 'order_fulfillment'
          : ['orderedQuantity', 'currentQuantity', 'unit', 'lines'].includes(
                difference.field,
              )
            ? 'order_lines'
            : null;

    return {
      ...difference,
      authority: resolved.groups.find((item) => item.group === group) ?? null,
    };
  });

  return {
    authority: resolved,
    redirectedFrom: requestedId === orderId ? null : requestedId,
    order: {
      id: orderId,
      displayNumber: selected.displayNumber,
      placedAt: selected.placedAt,
      total: selected.total,
      status: selected.status,
      paymentStatus: selected.paymentStatus,
      fulfillment: selected.fulfillment,
      lineCount: selected.lines.length,
      open: selected.open,
      overdue,
      dueAt: selected.dueAt,
      // Needs-you follows the list and metrics rule: removed orders need no attention.
      issueIds: selected.deleted || !shown('issues') ? [] : [...needsYou],
      differs: comparisonState === 'confirmed',
      comparisonState,
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
      observedAt: selected.observedAt,
      sourceUpdatedAt: selected.sourceUpdatedAt,
    },
    sources,
    differences,
    fulfillments: shown('fulfillments') ? fulfillments : [],
    returns: shown('returns') ? returns.rows : [],
    issues: shown('issues') ? issues : [],
    workflows: shown('workflows') ? workflows : [],
    history: {
      ...history,
      entries: history.entries.filter((entry) =>
        entry.entityKind === 'fulfillment'
          ? shown('fulfillments')
          : entry.entityKind === 'order' || shown('returns'),
      ),
    },
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
    asOf,
  };
}
