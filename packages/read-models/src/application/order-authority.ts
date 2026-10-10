import type { AuthoritySnapshot } from '@luma/connections';

import type { OrderDetail, OrderSourceFacts } from './orders.js';

/** Resolves each order fact from its workspace authority, preserving unknown and missing source facts. */
export function resolveOrderFacts(
  authority: AuthoritySnapshot,
  sources: OrderSourceFacts[],
  fulfillments: OrderDetail['fulfillments'] | null,
): OrderDetail['authority'] {
  const groups = authority.groups.filter((group) =>
    group.group.startsWith('order_'),
  );
  const source = (group: string) =>
    sources.find(
      (item) =>
        !item.deleted &&
        item.connectionId ===
          groups.find((rule) => rule.group === group)?.connectionId,
    );
  const lines = source('order_lines');
  const lifecycle = source('order_lifecycle');
  const fulfillment = source('order_fulfillment');
  const tracking = source('order_tracking');

  return {
    revision: authority.revision,
    groups,
    lines: lines
      ? {
          connectionId: lines.connectionId,
          lines: lines.lines.map((line) => ({
            id: line.id,
            skuId: line.skuId,
            comparisonKey: line.comparisonKey,
            skuCode: line.skuCode,
            title: line.title,
            quantity: line.quantity,
            currentQuantity: line.currentQuantity,
            unit: line.unit,
          })),
        }
      : null,
    lifecycle: lifecycle
      ? {
          connectionId: lifecycle.connectionId,
          status: lifecycle.status,
          cancelledQuantities: lifecycle.lines.map((line) => ({
            lineId: line.id,
            quantity: line.cancelledQuantity,
            unit: line.unit,
          })),
        }
      : null,
    fulfillments:
      fulfillment && fulfillments
        ? fulfillments.filter(
            (item) =>
              !item.deleted && item.connectionId === fulfillment.connectionId,
          )
        : null,
    tracking:
      tracking && fulfillments
        ? fulfillments
            .filter(
              (item) =>
                !item.deleted && item.connectionId === tracking.connectionId,
            )
            .map((item) => ({
              fulfillmentId: item.id,
              connectionId: item.connectionId,
              tracking: item.tracking,
            }))
        : null,
  };
}
