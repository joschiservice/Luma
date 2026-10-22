import type { SqlTransaction } from '@luma/platform';

import type {
  FulfillmentItem,
  FulfillmentSignal,
  FulfillmentSource,
} from '../../application/fulfillment.js';
import { connectionLabel, iso, link, object, text } from '../orders/values.js';

/** Open work without reported progress for this long is stalled. */
export const stalledAfterHours = 48;

/*
 * The fulfillment rules, written once for the list, its counts and the detail. `$2` is the
 * evaluation time and `$3` the stall window in hours.
 * - held: open work with at least one source hold;
 * - overdue: open work past the source's fulfill-by date;
 * - stalled: open, unheld work that is not scheduled for later and has reported no progress
 *   within the stall window;
 * - delivery_issue: a shipment whose carrier reports an attempted, delayed or failed delivery;
 * - late_delivery: an undelivered shipment past its estimated delivery;
 * - failed: the source reports the fulfillment failed and its order is not cancelled.
 */
const held = `(f.open AND COALESCE(cardinality(f.hold_reasons),0)>0)`;

const rules = `${held} AS held,
 (f.open AND f.fulfill_by<$2::timestamptz) AS overdue,
 (f.open AND NOT ${held} AND (f.fulfill_at IS NULL OR f.fulfill_at<=$2::timestamptz)
  AND f.progress_at<$2::timestamptz-make_interval(hours=>$3::int)) AS stalled,
 (f.status='shipped' AND NOT f.deleted AND f.delivery IN ('attempted_delivery','delayed','failed')) AS delivery_issue,
 (f.status='shipped' AND NOT f.deleted AND f.delivery IS DISTINCT FROM 'delivered'
  AND f.estimated_delivery_at<$2::timestamptz) AS late_delivery,
 (f.status='failed' AND NOT f.deleted AND f.order_status IS DISTINCT FROM 'cancelled') AS failed`;

/**
 * SQL for the tenant's current fulfillment rows matching `where`, with each rule and the view
 * flags as boolean columns. `$1` is the tenant.
 */
export const classified = (where: string) => `classified AS (
 SELECT c.*,(held OR overdue OR stalled OR delivery_issue OR late_delivery OR failed) AS attention,
  (overdue OR stalled OR delivery_issue OR late_delivery) AS delayed,
  (c.status='shipped' AND NOT c.deleted) AS in_transit
 FROM (SELECT f.*,${rules} FROM orders_fulfillment_list f WHERE f.tenant_id=$1 AND ${where}) c
)`;

/** JSON for one classified row `c`, joined to its snapshot `s`, read by `readItem`. */
export const itemJson = `jsonb_build_object('id',c.entity_id,'connectionId',c.connection_id,
 'externalId',(SELECT m.external_id FROM connector_source_mappings m WHERE m.tenant_id=c.tenant_id
  AND m.connection_id=c.connection_id AND m.resource='fulfillment' AND m.canonical_id=c.entity_id
  ORDER BY m.created_at,m.id LIMIT 1),
 'kind',c.kind,'status',c.status,'deleted',c.deleted,'open',c.open,'holds',to_jsonb(c.hold_reasons),
 'signals',to_jsonb(array_remove(ARRAY[CASE WHEN c.held THEN 'held' END,CASE WHEN c.overdue THEN 'overdue' END,
  CASE WHEN c.stalled THEN 'stalled' END,CASE WHEN c.delivery_issue THEN 'delivery_issue' END,
  CASE WHEN c.late_delivery THEN 'late_delivery' END,CASE WHEN c.failed THEN 'failed' END],NULL)),
 'locationId',c.location_id,'locationName',c.location_name,'methodType',c.method_type,'methodName',c.method_name,
 'fulfillAt',c.fulfill_at,'fulfillBy',c.fulfill_by,'estimatedDeliveryAt',c.estimated_delivery_at,
 'lastProgressAt',c.last_progress_at,'progressAt',c.progress_at,'delivery',c.delivery,'failureCode',c.failure_code,
 'tracking',COALESCE(s.document->'data'->'tracking','[]'),'shipping',s.document->'data'->'shipping','units',trim_scale(c.units)::text,'unit',c.unit,
 'orderId',c.order_id,'orderNumber',c.order_number,'orderStatus',c.order_status,'orderPlacedAt',c.order_placed_at,
 'observedAt',c.observed_at,'sourceUpdatedAt',c.source_updated_at)`;

/** Maps JSON built by `itemJson`. */
export function readItem(value: Record<string, unknown>): FulfillmentItem {
  const kind = text(value.kind);
  const tracking = Array.isArray(value.tracking) ? value.tracking : [];

  return {
    id: String(value.id),
    connectionId: String(value.connectionId),
    externalId: text(value.externalId),
    kind:
      kind === 'fulfillment_order' || kind === 'shipment' ? kind : 'unknown',
    status: text(value.status) ?? 'unknown',
    deleted: value.deleted === true,
    open: value.open === true,
    signals: (Array.isArray(value.signals)
      ? value.signals
      : []) as FulfillmentSignal[],
    holds: Array.isArray(value.holds) ? value.holds.map(String) : null,
    location:
      value.locationId || value.locationName
        ? { id: text(value.locationId), name: text(value.locationName) }
        : null,
    method: text(value.methodType)
      ? { type: String(value.methodType), name: text(value.methodName) }
      : null,
    fulfillAt: iso(value.fulfillAt),
    fulfillBy: iso(value.fulfillBy),
    estimatedDeliveryAt: iso(value.estimatedDeliveryAt),
    lastProgressAt: iso(value.lastProgressAt),
    progressAt: iso(value.progressAt)!,
    delivery: text(value.delivery),
    failureCode: text(value.failureCode),
    tracking: tracking.map((entry) => {
      const item = object(entry);

      return {
        carrier: text(item.carrier),
        number: text(item.number),
        url: link(item.url),
      };
    }),
    shipping: readShipping(value.shipping),
    units: text(value.units) ?? '0',
    unit: text(value.unit),
    order: {
      id: String(value.orderId),
      number: text(value.orderNumber),
      status: text(value.orderStatus),
      placedAt: iso(value.orderPlacedAt),
    },
    observedAt: iso(value.observedAt)!,
    sourceUpdatedAt: iso(value.sourceUpdatedAt),
  };
}

/** Reads optional handoff evidence from a stored snapshot; older snapshots have none. */
export function readShipping(
  value: unknown,
): Exclude<FulfillmentItem['shipping'], undefined> {
  const shipping = object(value);
  const stage = shipping.stage;

  return stage === 'merchant' ||
    stage === 'warehouse' ||
    stage === 'carrier' ||
    stage === 'delivered' ||
    stage === 'unknown'
    ? {
        stage,
        sourceUrl: link(shipping.sourceUrl),
        trackingUpdatedAt: iso(shipping.trackingUpdatedAt),
      }
    : null;
}

/** Lists the given connections, or every connection with fulfillment rows, with their app. */
export async function readSources(
  tx: SqlTransaction,
  tenantId: string,
  connectionIds?: string[],
): Promise<FulfillmentSource[]> {
  const result = await tx.query<{ id: string; document: unknown }>(
    `SELECT c.id,c.document FROM connector_installations c WHERE c.tenant_id=$1
     AND ${connectionIds ? 'c.id=ANY($2::uuid[])' : 'EXISTS (SELECT 1 FROM orders_fulfillment_list f WHERE f.tenant_id=$1 AND f.connection_id=c.id)'}
     ORDER BY c.id`,
    connectionIds ? [tenantId, connectionIds] : [tenantId],
  );

  return result.rows
    .map((row) => {
      const document = object(row.document);

      return {
        connectionId: row.id,
        label: connectionLabel(document),
        system: text(object(document.target).kind),
        status: text(document.status) ?? 'unknown',
        appId: text(document.appId),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}
