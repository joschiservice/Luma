import type { AuthorityReader } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import { hasPermission, isAppPermission, isPermission } from '@luma/identity';
import {
  orderChangeCapabilities,
  type OrderChangeRequest,
  OrderChangeRequestError,
  planOrderChanges,
  type PlanSource,
} from '@luma/orders';
import type { SqlTransaction } from '@luma/platform';
import { invalid } from '@luma/platform';

import type { OrderChangePlans } from '../../application/orders.js';
import { readFulfillments } from './detail.js';
import { readSourceFacts } from './detail-facts.js';
import { resolveOrderEntity } from './identity-references.js';
import type { OrderReadQueries } from './list-query.js';

const orderGroups = [
  'order_lines',
  'order_lifecycle',
  'order_fulfillment',
  'order_tracking',
] as const;

const isOrderGroup = (group: string): group is (typeof orderGroups)[number] =>
  (orderGroups as readonly string[]).includes(group);

/** The permission a person needs to request a provider write capability through an app. */
export type ActionPermission = (
  appId: string,
  capability: string,
) => string | null;

/**
 * Connections whose latest order or fulfilment collection read since `since` failed, was
 * partial or left pagination unfinished, as source comparisons treat them.
 */
export async function incompleteReads(
  tx: SqlTransaction,
  tenantId: string,
  asOf: string,
  connectionIds: string[],
  since: string,
) {
  const result = await tx.query<{ connectionId: string }>(
    `SELECT DISTINCT source.id::text AS "connectionId"
     FROM unnest($3::uuid[]) source(id)
     CROSS JOIN (VALUES ('orders.read'),('fulfillment.read')) capability(name)
     JOIN LATERAL (SELECT observed_at,succeeded,document FROM connector_read_checks
       WHERE tenant_id=$1 AND connection_id=source.id AND capability=capability.name AND observed_at<=$2
       ORDER BY observed_at DESC,id DESC LIMIT 1) latest ON true
     WHERE latest.observed_at>=$4
       AND (NOT latest.succeeded OR latest.document->'value'->>'completeness' IS DISTINCT FROM 'complete'
        OR latest.document->'value'->>'nextCursor' IS NOT NULL)`,
    [tenantId, asOf, connectionIds, since],
  );

  return new Set(result.rows.map((row) => row.connectionId));
}

/** Source line IDs per connection and canonical line, only where exactly one mapping exists. */
export async function lineReferences(
  tx: SqlTransaction,
  tenantId: string,
  lineIds: string[],
) {
  const result = await tx.query<{
    connectionId: string;
    lineId: string;
    externalId: string;
  }>(
    `SELECT connection_id::text AS "connectionId",canonical_id::text AS "lineId",min(external_id) AS "externalId"
     FROM connector_source_mappings WHERE tenant_id=$1 AND resource='order_line' AND canonical_id=ANY($2::uuid[])
     GROUP BY connection_id,canonical_id HAVING count(*)=1`,
    [tenantId, lineIds],
  );
  const refs = new Map<string, Record<string, string>>();
  for (const row of result.rows)
    refs.set(row.connectionId, {
      ...refs.get(row.connectionId),
      [row.lineId]: row.externalId,
    });

  return refs;
}

/**
 * Whether each connection observes only, because the workspace or the connection says so. A
 * workspace or connection the reader cannot see counts as observe-only.
 */
async function writeModes(
  tx: SqlTransaction,
  tenantId: string,
  connectionIds: string[],
) {
  const result = await tx.query<{ id: string; observeOnly: boolean }>(
    `SELECT c.id::text,(COALESCE(o.write_mode,'observe_only')='observe_only'
       OR c.document->>'writeMode' IS NOT DISTINCT FROM 'observe_only') AS "observeOnly"
     FROM connector_installations c LEFT JOIN organizations o ON o.id=c.tenant_id
     WHERE c.tenant_id=$1 AND c.id=ANY($2::uuid[])`,
    [tenantId, connectionIds],
  );

  return new Map(result.rows.map((row) => [row.id, row.observeOnly]));
}

/**
 * Plans a proposed or detected change of one order from the detail read's source facts,
 * fulfilments and comparison, the workspace authority, each connection's granted capabilities
 * and write mode, and the reader's app permissions. Returns null when the order has no current
 * source; rejects a line that is not on the order with 422.
 */
export async function readChangePlan(
  tx: SqlTransaction,
  queries: OrderReadQueries,
  authority: AuthorityReader,
  actionPermission: ActionPermission,
  context: TenantContext,
  orderId: string,
  request: OrderChangeRequest | null,
  asOf: string,
): Promise<OrderChangePlans | null> {
  const tenantId = context.tenantId;
  orderId = await resolveOrderEntity(tx, tenantId, orderId);
  const facts = await readSourceFacts(tx, queries, tenantId, orderId, asOf);
  if (!facts) return null;
  const visible = hasPermission(context, 'fulfillment.read');
  const connectionIds = facts.sources.map((source) => source.connectionId);
  // Hidden sources are left out of the facts, so their fulfilments are too.
  const fulfillments = visible
    ? (await readFulfillments(tx, tenantId, orderId)).filter((work) =>
        connectionIds.includes(work.connectionId),
      )
    : [];
  const reads = facts.sources.flatMap((source) =>
    source.deleted ? [] : [source.observedAt],
  );
  for (const work of fulfillments) reads.push(work.observedAt);
  const oldest = reads.reduce(
    (a, b) => (Date.parse(a) < Date.parse(b) ? a : b),
    asOf,
  );
  const incomplete = await incompleteReads(
    tx,
    tenantId,
    asOf,
    connectionIds,
    oldest,
  );
  const refs = await lineReferences(
    tx,
    tenantId,
    facts.sources.flatMap((source) => source.lines.map((line) => line.id)),
  );
  const modes = await writeModes(tx, tenantId, connectionIds);
  const snapshot = await authority.read(context);
  const sources: PlanSource[] = facts.sources.map((source) => {
    const connection = snapshot.connections.find(
      (item) => item.id === source.connectionId,
    );
    const access: PlanSource['connection']['access'] = {};
    for (const { capability } of orderChangeCapabilities) {
      const permission = source.appId
        ? actionPermission(source.appId, capability)
        : null;
      if (permission)
        access[capability] = {
          permission,
          viewerHas:
            (isPermission(permission) || isAppPermission(permission)) &&
            hasPermission(context, permission),
        };
    }

    return {
      connectionId: source.connectionId,
      ...(source.lineCoverage ? { lineCoverage: source.lineCoverage } : {}),
      deleted: source.deleted,
      observedAt: source.observedAt,
      status: source.status,
      lines: source.lines.map((line) => ({
        id: line.id,
        skuId: line.skuId,
        skuCode: line.skuCode,
        title: line.title,
        quantity: line.quantity,
        currentQuantity: line.currentQuantity,
        cancelledQuantity: line.cancelledQuantity,
        unit: line.unit,
      })),
      fulfillments: fulfillments
        .filter((work) => work.connectionId === source.connectionId)
        .map((work) => ({
          deleted: work.deleted,
          status: work.status,
          kind: work.kind ?? null,
          observedAt: work.observedAt,
          location: work.location
            ? { locationId: work.location.locationId }
            : null,
          lines: work.lines.map((line) => ({
            orderLineId: line.orderLineId,
            quantity: line.quantity,
            remainingQuantity: line.remainingQuantity,
          })),
        })),
      incompleteRead: incomplete.has(source.connectionId),
      externalId: source.externalId,
      lineRefs: refs.get(source.connectionId) ?? {},
      connection: {
        category: connection?.category ?? null,
        available: connection?.available ?? false,
        capabilities: connection?.capabilities ?? [],
        writeMode:
          modes.get(source.connectionId) === false
            ? 'writes_enabled'
            : 'observe_only',
        access,
      },
    };
  });
  try {
    return {
      orderId,
      comparisonState: facts.comparisonState,
      plans: planOrderChanges({
        sources,
        fulfillmentsVisible: visible,
        authority: snapshot.groups.flatMap((rule) =>
          isOrderGroup(rule.group)
            ? [
                {
                  group: rule.group,
                  state: rule.state,
                  connectionId: rule.connectionId,
                },
              ]
            : [],
        ),
        differences: facts.differences,
        comparisonState: facts.comparisonState,
        asOf,
        request,
      }).slice(0, 20),
      hidden: visible ? [] : ['fulfillments'],
      asOf,
    };
  } catch (error) {
    if (error instanceof OrderChangeRequestError)
      throw invalid(
        error.code === 'unknown_line'
          ? 'Choose a line on this order.'
          : 'Enter a nonnegative quantity with at most six decimal places.',
      );
    throw error;
  }
}
