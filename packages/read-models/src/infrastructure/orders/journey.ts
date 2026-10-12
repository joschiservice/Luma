import { hasPermission, type TenantContext } from '@luma/identity';
import {
  type JourneyEvent,
  journeyTiming,
  type OrderJourney,
} from '@luma/orders';
import type { SqlTransaction } from '@luma/platform';

import { iso } from './values.js';

/** Reads indexed source milestones and Inventory-owned local holds without copying either record. */
export async function readJourney(
  tx: SqlTransaction,
  context: TenantContext,
  orderIds: string[],
  asOf: string,
): Promise<OrderJourney> {
  const inventory = hasPermission(context, 'inventory.read');
  const fulfillment = hasPermission(context, 'fulfillment.read');
  const returns = hasPermission(context, 'returns.read');
  const result = await tx.query<{
    id: string;
    order_id: string;
    part_id: string;
    order_line_id: string;
    connection_id: string | null;
    stage: JourneyEvent['stage'];
    occurred_at: unknown;
    observed_at: unknown;
    quantity: string | null;
    unit: string | null;
    snapshot_id: string | null;
    observation_id: string | null;
    reservation_id: string | null;
    actor_id: string | null;
  }>(
    `
 SELECT id,order_id,part_id,order_line_id,connection_id,stage,occurred_at,observed_at,quantity::text,unit,snapshot_id,observation_id,NULL::uuid reservation_id,NULL::text actor_id
 FROM orders_journey_events WHERE tenant_id=$1 AND order_id=ANY($2::uuid[]) AND observed_at<=$3
 AND (stage IN('placed','paid') OR ($4 AND stage IN('picked','shipped','delivered')) OR ($5 AND stage='returned'))
 UNION ALL SELECT id,order_id,order_line_id,order_line_id,NULL,'reserved',created_at,created_at,NULL,unit,NULL,NULL,id,created_by
 FROM inventory_native_reservations WHERE tenant_id=$1 AND order_id=ANY($2::uuid[]) AND $6 AND created_at<=$3
 ORDER BY observed_at,id LIMIT 501`,
    [context.tenantId, orderIds, asOf, fulfillment, returns, inventory],
  );
  const events = result.rows.slice(0, 500).map((row) => ({
    id: row.id,
    orderId: row.order_id,
    partId: row.part_id,
    orderLineId: row.order_line_id,
    connectionId: row.connection_id,
    actorId: row.actor_id,
    stage: row.stage,
    provenance: row.reservation_id
      ? ('luma_action' as const)
      : ('provider_observation' as const),
    occurredAt: iso(row.occurred_at),
    observedAt: iso(row.observed_at)!,
    quantity: row.quantity,
    unit: row.unit,
    references: [
      {
        kind: 'order' as const,
        id: row.order_id,
        connectionId: row.connection_id,
      },
      {
        kind: 'order_line' as const,
        id: row.order_line_id,
        connectionId: row.connection_id,
      },
      ...(row.snapshot_id
        ? [
            {
              kind: 'snapshot' as const,
              id: row.snapshot_id,
              connectionId: row.connection_id,
            },
          ]
        : []),
      ...(row.observation_id
        ? [
            {
              kind: 'observation' as const,
              id: row.observation_id,
              connectionId: row.connection_id,
            },
          ]
        : []),
      ...(row.reservation_id
        ? [
            {
              kind: 'reservation' as const,
              id: row.reservation_id,
              connectionId: null,
            },
          ]
        : []),
      ...(['shipped', 'delivered', 'picked', 'returned'].includes(row.stage)
        ? [
            {
              kind:
                row.stage === 'returned'
                  ? ('return' as const)
                  : ('shipment' as const),
              id: row.part_id,
              connectionId: row.connection_id,
            },
          ]
        : []),
    ],
  }));
  const candidates = inventory
    ? (
        await tx.query<{
          code: 'paid_without_reservation' | 'shipped_without_reservation';
          orderLineId: string;
          connectionId: string;
          observedSince: unknown;
        }>(
          `
 SELECT DISTINCT CASE WHEN e.stage='paid' THEN 'paid_without_reservation' ELSE 'shipped_without_reservation' END code,
 e.order_line_id AS "orderLineId",e.connection_id AS "connectionId",e.observed_at AS "observedSince"
 FROM orders_journey_events e JOIN orders_list o ON o.tenant_id=e.tenant_id AND o.entity_id=e.order_id AND o.connection_id=e.connection_id
 WHERE e.tenant_id=$1 AND e.order_id=ANY($2::uuid[]) AND NOT o.deleted
 AND ((e.stage='paid' AND o.open IS TRUE AND o.payment_status='paid' AND e.observed_at<=$3::timestamptz-interval '4 hours') OR ($4 AND e.stage='shipped'))
 AND NOT EXISTS(SELECT 1 FROM inventory_native_reservations r WHERE r.tenant_id=e.tenant_id AND r.order_id=e.order_id AND r.order_line_id=e.order_line_id)
 ORDER BY "orderLineId","connectionId",code LIMIT 100`,
          [context.tenantId, orderIds, asOf, fulfillment],
        )
      ).rows.map((row) => ({ ...row, observedSince: iso(row.observedSince)! }))
    : [];
  const comparisons = (
    await tx.query<OrderJourney['comparisons'][number]>(
      `
 WITH stages("from","to") AS (VALUES ('placed','paid'),('paid','reserved'),('reserved','picked'),('picked','shipped'),('shipped','delivered'),('delivered','returned')),
 permitted AS (SELECT * FROM stages WHERE "from"='placed' OR ($3 AND "from" IN('picked','shipped')) OR ($4 AND $3 AND "from" IN('paid','reserved')) OR ($5 AND $3 AND "from"='delivered')),
 pairs AS (
 SELECT p."from",p."to",a.connection_id,a.part_id,min(extract(epoch FROM (b.occurred_at-a.occurred_at))*1000)::double precision duration
 FROM permitted p JOIN orders_journey_events a ON a.tenant_id=$1 AND a.stage=p."from"
 JOIN orders_journey_events b ON b.tenant_id=a.tenant_id AND b.connection_id=a.connection_id
 AND b.part_id=a.part_id AND b.order_line_id=a.order_line_id AND b.stage=p."to"
 WHERE a.occurred_at IS NOT NULL AND b.occurred_at>=a.occurred_at
 AND b.occurred_at>=$2::timestamptz-interval '90 days' AND b.occurred_at<=$2 AND a.observed_at<=$2 AND b.observed_at<=$2
 GROUP BY p."from",p."to",a.connection_id,a.part_id)
 SELECT p."from",p."to",count(pairs.duration)::int count,
 percentile_cont(.5) WITHIN GROUP(ORDER BY duration) AS "medianMs",percentile_cont(.9) WITHIN GROUP(ORDER BY duration) AS "p90Ms"
 FROM permitted p LEFT JOIN pairs USING("from","to") GROUP BY p."from",p."to" ORDER BY p."from",p."to"`,
      [context.tenantId, asOf, fulfillment, inventory, returns],
    )
  ).rows;

  return {
    events,
    truncated: result.rows.length > 500,
    candidates,
    timings: events.flatMap((to) => {
      const previous: Partial<
        Record<JourneyEvent['stage'], JourneyEvent['stage']>
      > = {
        paid: 'placed',
        picked: 'reserved',
        shipped: 'picked',
        delivered: 'shipped',
        returned: 'delivered',
      };
      const from = events.find(
        (event) =>
          event.stage === previous[to.stage] &&
          event.partId === to.partId &&
          event.orderLineId === to.orderLineId &&
          event.connectionId === to.connectionId,
      );

      return from
        ? [
            {
              ...journeyTiming(from, to),
              partId: to.partId,
              orderLineId: to.orderLineId,
              connectionId: to.connectionId,
            },
          ]
        : [];
    }),
    comparisons,
  };
}
