import type { StoredRecord } from '@luma/simulator-core';

import { adjustLevel, available } from './inventory.js';
import {
  all,
  type FulfillmentOrderData,
  type FulfillmentOrderLineItemData,
  type FulfillmentOrderStatus,
  gid,
  insert,
  type InventoryLevelData,
  iso,
  levelId,
  type LineItemData,
  nextId,
  notify,
  type OrderData,
  RuleError,
  save,
  type ShopifyContext,
} from './records.js';
import type { ShopifyHoldReason } from './types.js';

type WorkOrder = StoredRecord<FulfillmentOrderData>;

/** Fulfillment order states in which work remains to be done. */
export const openStatuses: readonly FulfillmentOrderStatus[] = [
  'OPEN',
  'IN_PROGRESS',
  'SCHEDULED',
  'ON_HOLD',
];

/** Reads every fulfillment order of an order. */
export const orderWork = (context: ShopifyContext, order: string) =>
  all<FulfillmentOrderData>(context, {
    kind: 'FulfillmentOrder',
    parent: order,
  });

/** Reads every line of a fulfillment order. */
export const workLines = (context: ShopifyContext, work: string) =>
  all<FulfillmentOrderLineItemData>(context, {
    kind: 'FulfillmentOrderLineItem',
    parent: work,
  });

/**
 * Units of each order line still remaining in open fulfillment work (`openStatuses`), by line
 * item ID; Shopify reports them as the line's unfulfilled quantity. Units in closed, cancelled
 * or incomplete work do not count.
 */
export async function unfulfilledUnits(context: ShopifyContext, order: string) {
  const units = new Map<string, number>();
  for (const work of await orderWork(context, order))
    if (openStatuses.includes(work.data.status))
      for (const line of await workLines(context, work.id))
        units.set(
          line.data.lineItem,
          (units.get(line.data.lineItem) ?? 0) + line.data.remainingQuantity,
        );

  return units;
}

/** Stores an order change and sends `orders/updated`, as Shopify does for any related change. */
export async function touchOrder(
  context: ShopifyContext,
  order: StoredRecord<OrderData> | string,
  data?: OrderData,
) {
  const record =
    typeof order === 'string'
      ? await context.store.get<OrderData>('Order', order)
      : order;
  if (!record) throw new Error(`Order ${String(order)} not found`);
  await save(context, 'Order', record.id, data ?? record.data);
  notify(context, 'orders/updated', 'Order', record.id, {
    name: record.data.name,
  });
}

/** Actions Shopify offers for a merchant-managed fulfillment order in its current state. */
export function supportedActions(
  context: ShopifyContext,
  work: FulfillmentOrderData,
) {
  const movable = context.config.locations.length > 1;
  switch (work.status) {
    case 'OPEN':
    case 'IN_PROGRESS':
      return [
        'CREATE_FULFILLMENT',
        'REPORT_PROGRESS',
        ...(movable ? ['MOVE'] : []),
        'HOLD',
        'SPLIT',
      ];
    case 'SCHEDULED':
      return ['MARK_AS_OPEN', ...(movable ? ['MOVE'] : []), 'HOLD'];
    case 'ON_HOLD':
      return ['RELEASE_HOLD', 'HOLD'];
    default:
      return [];
  }
}

/** Places a merchant hold on open work; Shopify keeps the prior status for the release. */
export async function placeHold(
  context: ShopifyContext,
  work: WorkOrder,
  reason: ShopifyHoldReason,
) {
  if (!openStatuses.includes(work.data.status))
    throw new RuleError('Only open fulfillment work can be held');
  const id = await nextId(context);
  const data: FulfillmentOrderData = {
    ...work.data,
    status: 'ON_HOLD',
    heldStatus:
      work.data.status === 'ON_HOLD' ? work.data.heldStatus : work.data.status,
    holds: [...work.data.holds, { id, reason, heldByRequestingApp: false }],
  };
  await save(context, 'FulfillmentOrder', work.id, data);
  notify(
    context,
    'fulfillment_orders/placed_on_hold',
    'FulfillmentOrder',
    work.id,
    {
      status: 'ON_HOLD',
    },
  );
  notify(context, 'fulfillment_holds/added', 'FulfillmentHold', id, {
    reason,
    fulfillment_order_id: gid('FulfillmentOrder', work.id),
  });

  return { ...work, data };
}

/**
 * Releases the given holds, or all holds when none are named. The prior status returns once
 * no hold remains. Fails when the work is not held or a hold is unknown.
 */
export async function releaseHolds(
  context: ShopifyContext,
  work: WorkOrder,
  holdIds?: readonly string[],
) {
  if (work.data.status !== 'ON_HOLD' || !work.data.holds.length)
    throw new RuleError('The fulfillment order is not on hold');
  const released = holdIds?.length
    ? work.data.holds.filter((hold) => holdIds.includes(hold.id))
    : work.data.holds;
  if (holdIds?.length && released.length !== new Set(holdIds).size)
    throw new RuleError('Fulfillment hold not found');
  const holds = work.data.holds.filter((hold) => !released.includes(hold));
  const data: FulfillmentOrderData = {
    ...work.data,
    holds,
    status: holds.length ? 'ON_HOLD' : (work.data.heldStatus ?? 'OPEN'),
    heldStatus: holds.length ? work.data.heldStatus : null,
  };
  await save(context, 'FulfillmentOrder', work.id, data);
  for (const hold of released)
    notify(context, 'fulfillment_holds/released', 'FulfillmentHold', hold.id, {
      reason: hold.reason,
      fulfillment_order_id: gid('FulfillmentOrder', work.id),
    });
  if (!holds.length)
    notify(
      context,
      'fulfillment_orders/hold_released',
      'FulfillmentOrder',
      work.id,
      {
        status: data.status,
      },
    );

  return { ...work, data };
}

/** Opens scheduled work for fulfillment now; fails for work that is not scheduled. */
export async function openWork(context: ShopifyContext, work: WorkOrder) {
  if (work.data.status !== 'SCHEDULED')
    throw new RuleError('Only a scheduled fulfillment order can be opened');
  const data: FulfillmentOrderData = {
    ...work.data,
    status: 'OPEN',
    fulfillAt: iso(context.now),
  };
  await save(context, 'FulfillmentOrder', work.id, data);
  notify(
    context,
    'fulfillment_orders/scheduled_fulfillment_order_ready',
    'FulfillmentOrder',
    work.id,
    { status: 'OPEN' },
  );

  return { ...work, data };
}

/** Remaining lines of work with the inventory item each line draws from. */
async function remainingLines(context: ShopifyContext, work: string) {
  const lines = (await workLines(context, work)).filter(
    (line) => line.data.remainingQuantity > 0,
  );
  const items = new Map(
    (
      await context.store.getMany<LineItemData>(
        'LineItem',
        lines.map((line) => line.data.lineItem),
      )
    ).map((line) => [line.id, line.data.variant]),
  );

  return lines.map((line) => ({
    line,
    item: items.get(line.data.lineItem) ?? null,
  }));
}

/**
 * Lists other configured locations with the number of remaining lines each cannot cover
 * because it does not stock the item or has too few available units.
 */
export async function moveOptions(context: ShopifyContext, work: WorkOrder) {
  const lines = await remainingLines(context, work.id);

  return Promise.all(
    context.config.locations
      .filter((candidate) => candidate.id !== work.data.location)
      .map(async (candidate) => {
        const levels = new Map(
          (
            await context.store.getMany<InventoryLevelData>(
              'InventoryLevel',
              lines.flatMap(({ item }) =>
                item ? [levelId(item, candidate.id)] : [],
              ),
            )
          ).map((level) => [level.data.item, level.data]),
        );
        const unavailable = lines.filter(({ line, item }) => {
          if (!item) return false;
          const level = levels.get(item);

          return !level || available(level) < line.data.remainingQuantity;
        }).length;

        return { location: candidate.id, unavailable };
      }),
  );
}

/**
 * Moves remaining work to another location and its committed stock with it; the caller sends
 * `orders/updated`. Untouched work
 * moves in place; partly fulfilled work keeps the fulfilled units and a new fulfillment order
 * takes the rest. Returns the fulfillment order that holds the moved work.
 */
export async function moveWork(
  context: ShopifyContext,
  work: WorkOrder,
  target: string,
) {
  if (!['OPEN', 'IN_PROGRESS', 'SCHEDULED'].includes(work.data.status))
    throw new RuleError(
      `A fulfillment order in status ${work.data.status} cannot move`,
    );
  if (target === work.data.location)
    throw new RuleError(
      'The fulfillment order is already assigned to this location',
    );
  const options = await moveOptions(context, work);
  const option = options.find((candidate) => candidate.location === target);
  if (!option) throw new RuleError('Location not found');
  if (option.unavailable)
    throw new RuleError(
      'The location cannot fulfill every remaining line item',
    );
  const lines = await remainingLines(context, work.id);
  for (const { line, item } of lines)
    if (item) {
      await adjustLevel(context, item, work.data.location, {
        committed: -line.data.remainingQuantity,
      });
      await adjustLevel(context, item, target, {
        committed: line.data.remainingQuantity,
      });
    }
  const untouched = (await workLines(context, work.id)).every(
    (line) => line.data.remainingQuantity === line.data.totalQuantity,
  );
  let moved: WorkOrder;
  if (untouched) {
    const data = { ...work.data, location: target };
    await save(context, 'FulfillmentOrder', work.id, data);
    moved = { ...work, data, updatedAt: context.now };
  } else {
    const id = await nextId(context);
    const data: FulfillmentOrderData = {
      ...work.data,
      location: target,
      status: work.data.status === 'IN_PROGRESS' ? 'OPEN' : work.data.status,
    };
    const copies = [];
    for (const { line } of lines)
      copies.push(
        insert(
          context,
          'FulfillmentOrderLineItem',
          await nextId(context),
          {
            ...line.data,
            fulfillmentOrder: id,
            totalQuantity: line.data.remainingQuantity,
          } satisfies FulfillmentOrderLineItemData,
          { parent: id },
        ),
      );
    await context.store.putMany([
      insert(context, 'FulfillmentOrder', id, data, {
        parent: work.data.order,
      }),
      ...copies,
    ]);
    for (const { line } of lines)
      await save(context, 'FulfillmentOrderLineItem', line.id, {
        ...line.data,
        totalQuantity: line.data.totalQuantity - line.data.remainingQuantity,
        remainingQuantity: 0,
      });
    await save(context, 'FulfillmentOrder', work.id, {
      ...work.data,
      status: 'CLOSED',
    });
    const created = await context.store.get<FulfillmentOrderData>(
      'FulfillmentOrder',
      id,
    );
    if (!created) throw new Error('Moved fulfillment order was not stored');
    moved = created;
  }
  const order = await context.store.get<OrderData>('Order', work.data.order);
  if (order)
    await save(context, 'Order', order.id, { ...order.data, location: target });
  notify(context, 'fulfillment_orders/moved', 'FulfillmentOrder', work.id, {
    moved_fulfillment_order_id: gid('FulfillmentOrder', moved.id),
  });

  return moved;
}
