import { SEED_VAT_RATE } from './catalog.js';
import { customerFor } from './customers.js';
import {
  allocate,
  cents,
  configId,
  iso,
  type JtlContext,
  kinds,
  next,
  type NoteRecord,
  OPEN,
  type OrderRecord,
  recordId,
  refuse,
  warehouseOf,
} from './records.js';
import { loadItems, saveStock } from './stock.js';
import type { JtlCommand } from './types.js';

type OrderCommand = Extract<JtlCommand, { kind: 'order' }>;

type ShipCommand = Extract<JtlCommand, { kind: 'ship' }>;

/** JTL delivery status: 1 open, 3 partially shipped, 5 shipped. */
export function deliveryStatus(order: OrderRecord) {
  const shipped = order.lines.reduce((sum, line) => sum + line.shipped, 0);
  if (!shipped) return 1;

  return order.lines.every((line) => line.shipped >= line.quantity) ? 5 : 3;
}

const isOpen = (order: OrderRecord) =>
  !order.cancelled && order.lines.some((line) => line.shipped < line.quantity);

async function loadOrder(context: JtlContext, id: string) {
  const record = await context.store.get<OrderRecord>(kinds.order, id);
  if (!record) refuse('Sales order not found', 404);

  return record.data;
}

async function saveOrder(
  context: JtlContext,
  order: OrderRecord,
  topic: 'sales-orders/create' | 'sales-orders/update',
) {
  await context.store.put(kinds.order, order.id, order, {
    key: isOpen(order) ? OPEN : null,
    updatedAt: context.now,
    ...(topic === 'sales-orders/create' ? { createdAt: context.now } : {}),
  });
  context.notify({
    topic,
    resource: order.id,
    payload: {
      salesOrderId: order.id,
      deliveryStatus: deliveryStatus(order),
      isCancelled: order.cancelled,
    },
  });
}

/**
 * Records a sales order from the order integration and reserves its quantities on the items.
 * Reservations do not require available stock; JTL lets orders oversell. Order numbers are
 * `AU-` and the zero-padded order ID, including for fixtures with explicit IDs.
 */
export async function placeOrder(context: JtlContext, command: OrderCommand) {
  const explicit = command.id === undefined ? undefined : recordId(command.id);
  if (command.id !== undefined && !explicit) refuse('Invalid sales order ID');
  if (
    !command.lines.length ||
    command.lines.length > 500 ||
    command.lines.some(
      (line) =>
        !Number.isSafeInteger(line.quantity) ||
        line.quantity < 1 ||
        !Number.isFinite(line.price) ||
        line.price < 0,
    ) ||
    !/^[A-Z]{3}$/.test(command.currency) ||
    (command.externalNumber !== undefined &&
      (!command.externalNumber.trim() || command.externalNumber.length > 255))
  )
    refuse('Invalid sales order');
  if (
    !context.config.shippingMethods.some(
      (m) => m.id === command.shippingMethodId,
    )
  )
    refuse('Shipping method not found');
  const warehouse =
    command.warehouse === undefined
      ? null
      : warehouseOf(context, command.warehouse);
  if (explicit && (await context.store.get(kinds.order, explicit)))
    refuse('Sales order already exists', 409);
  const items = await loadItems(
    context,
    command.lines.map((line) => line.itemId),
  );

  const customerId = command.customer
    ? await customerFor(context, command.customer)
    : null;
  const id = explicit ?? (await allocate(context, kinds.order));
  const lines: OrderRecord['lines'] = [];
  for (const line of command.lines) {
    const item = items.get(line.itemId)!;
    item.reserved += line.quantity;
    lines.push({
      id: await next(context, 'sales-order-line'),
      itemId: item.id,
      sku: item.sku,
      name: item.name,
      unit: item.unit,
      quantity: line.quantity,
      shipped: 0,
      price: line.price,
    });
  }
  const order: OrderRecord = {
    id,
    number: `AU-${id.padStart(6, '0')}`,
    externalNumber: command.externalNumber ?? null,
    customerId,
    cancelled: false,
    paid: command.paid,
    shippingMethodId: command.shippingMethodId,
    currency: command.currency,
    total: cents(
      lines.reduce((sum, line) => sum + line.price * line.quantity, 0),
    ),
    date: iso(context.now),
    warehouse,
    shippedAt: null,
    lines,
  };
  await saveOrder(context, order, 'sales-orders/create');
  await saveStock(context, items.values());

  return {
    id,
    lines: lines.map((line) => ({
      id: line.id,
      itemId: line.itemId,
      quantity: line.quantity,
    })),
  };
}

/** Records the payment of an uncancelled order. */
export async function markPaid(context: JtlContext, id: string) {
  const order = await loadOrder(context, id);
  if (order.cancelled) refuse('Sales order is cancelled', 409);
  order.paid = true;
  await saveOrder(context, order, 'sales-orders/update');

  return { id };
}

/** Cancels an order that has not shipped and releases its reservations. */
export async function cancelOrder(context: JtlContext, id: string) {
  const order = await loadOrder(context, id);
  if (order.cancelled) refuse('Sales order is already cancelled', 409);
  if (order.lines.some((line) => line.shipped > 0))
    refuse('Sales order has shipped', 409);
  const items = await loadItems(
    context,
    order.lines.map((line) => line.itemId),
  );
  for (const line of order.lines)
    items.get(line.itemId)!.reserved -= line.quantity;
  order.cancelled = true;
  await saveOrder(context, order, 'sales-orders/update');
  await saveStock(context, items.values());

  return { id };
}

/**
 * Books a delivery note for the given line quantities, or every open unit, from one warehouse.
 * Physical stock in that warehouse and the reservations decrease. Refuses quantities above the
 * open quantity and shipments the warehouse cannot cover.
 */
export async function shipOrder(context: JtlContext, command: ShipCommand) {
  const order = await loadOrder(context, command.id);
  if (order.cancelled) refuse('Sales order is cancelled', 409);
  const warehouse = warehouseOf(context, command.warehouse);
  if (!command.trackingNumber.trim() || !command.trackingUrl.trim())
    refuse('Tracking is required');
  const requested =
    command.lines ??
    order.lines.map((line) => ({
      lineId: line.id,
      quantity: line.quantity - line.shipped,
    }));
  if (new Set(requested.map((line) => line.lineId)).size !== requested.length)
    refuse('Duplicate line');
  const shipments = requested
    .filter((value) => command.lines || value.quantity > 0)
    .map((value) => {
      const line = order.lines.find(
        (candidate) => candidate.id === value.lineId,
      );
      if (!line) refuse('Sales order line not found', 404);
      if (
        !Number.isSafeInteger(value.quantity) ||
        value.quantity < 1 ||
        value.quantity > line.quantity - line.shipped
      )
        refuse('Quantity exceeds the open quantity', 409);

      return { line, quantity: value.quantity };
    });
  if (!shipments.length) refuse('Nothing to ship', 409);
  const items = await loadItems(
    context,
    shipments.map(({ line }) => line.itemId),
  );
  const demand = new Map<string, number>();
  for (const { line, quantity } of shipments)
    demand.set(line.itemId, (demand.get(line.itemId) ?? 0) + quantity);
  for (const [itemId, quantity] of demand)
    if ((items.get(itemId)!.stock[warehouse] ?? 0) < quantity)
      refuse('Insufficient stock in warehouse', 409);

  const at = iso(context.now);
  const note: NoteRecord = {
    id: await next(context, kinds.note),
    orderId: order.id,
    warehouse,
    date: at,
    packages: [
      {
        id: await next(context, 'delivery-note-package'),
        shippingDate: at,
        trackingNumber: command.trackingNumber,
        trackingUrl: command.trackingUrl,
      },
    ],
    lines: [],
  };
  for (const { line, quantity } of shipments) {
    const item = items.get(line.itemId)!;
    item.stock[warehouse] = item.stock[warehouse]! - quantity;
    item.reserved -= quantity;
    line.shipped += quantity;
    note.lines.push({
      id: await next(context, 'delivery-note-line'),
      orderLineId: line.id,
      quantity,
    });
  }
  order.warehouse = warehouse;
  order.shippedAt ??= at;
  await context.store.put(kinds.note, note.id, note, {
    parent: order.id,
    createdAt: context.now,
    updatedAt: context.now,
  });
  context.notify({
    topic: 'delivery-notes/create',
    resource: note.id,
    payload: { deliveryNoteId: note.id, salesOrderId: order.id, warehouse },
  });
  await saveOrder(context, order, 'sales-orders/update');
  await saveStock(context, items.values());

  return {
    id: note.id,
    lines: shipments.map(({ line, quantity }) => ({
      id: line.id,
      itemId: line.itemId,
      quantity,
    })),
  };
}

/**
 * Sets an order's shipping method. Like JTL, this offers no compare-and-swap or idempotency;
 * the last write wins. Refuses cancelled orders and unknown methods.
 */
export async function changeShippingMethod(
  context: JtlContext,
  id: string,
  shippingMethodId: string,
) {
  const order = await loadOrder(context, id);
  if (!context.config.shippingMethods.some((m) => m.id === shippingMethodId))
    refuse('Shipping method not found');
  if (order.cancelled) refuse('Sales order is cancelled', 409);
  order.shippingMethodId = shippingMethodId;
  await saveOrder(context, order, 'sales-orders/update');

  return { id };
}

/** A sales order as the merchant engine sees it. */
export interface JtlOrderView {
  id: string;
  externalNumber: string | null;
  cancelled: boolean;
  deliveryStatus: number;
  paid: boolean;
  warehouse: string | null;
  shippingMethodId: string;
  /** Simulation time of creation. */
  createdAt: number;
  lines: { id: string; itemId: string; quantity: number; open: number }[];
}

function view(order: OrderRecord, createdAt: number): JtlOrderView {
  return {
    id: order.id,
    externalNumber: order.externalNumber,
    cancelled: order.cancelled,
    deliveryStatus: deliveryStatus(order),
    paid: order.paid,
    warehouse: order.warehouse,
    shippingMethodId: order.shippingMethodId,
    createdAt,
    lines: order.lines.map((line) => ({
      id: line.id,
      itemId: line.itemId,
      quantity: line.quantity,
      open: order.cancelled ? 0 : line.quantity - line.shipped,
    })),
  };
}

/** Reads one sales order; undefined when it does not exist. */
export async function readOrder(context: JtlContext, id: string) {
  const record = await context.store.get<OrderRecord>(kinds.order, id);

  return record ? view(record.data, record.createdAt) : undefined;
}

/**
 * Reads uncancelled orders with units left to ship, oldest first. Pass `next` as `after` to
 * continue; orders closed meanwhile drop out.
 */
export async function openOrders(
  context: JtlContext,
  options: { limit: number; after?: string | null | undefined },
) {
  const page = await context.store.page<OrderRecord>({
    kind: kinds.order,
    key: OPEN,
    after: options.after,
    limit: options.limit,
  });

  return {
    orders: page.items.map((record) => view(record.data, record.createdAt)),
    next: page.next,
  };
}

/** Serializes a sales order in ERP API 2.2 field names. */
export function salesOrderJson(order: OrderRecord) {
  return {
    id: Number(order.id),
    salesOrderNumber: order.number,
    externalSalesOrderNumber: order.externalNumber,
    customerId: order.customerId ? Number(order.customerId) : null,
    isCancelled: order.cancelled,
    deliveryStatus: deliveryStatus(order),
    paymentStatus: order.paid ? 2 : 0,
    salesOrderDate: order.date,
    totalGrossAmount: order.total,
    currencyIso: order.currency,
    shippingMethodId: configId(order.shippingMethodId),
    shippingDetails: { shippingDate: order.shippedAt },
  };
}

/**
 * Serializes the line items of a sales order. Prices are stored gross; JTL also reports the
 * net price and the line's tax rate in percent.
 */
export function orderLinesJson(order: OrderRecord) {
  return order.lines.map((line) => ({
    id: Number(line.id),
    salesOrderId: Number(order.id),
    itemId: Number(line.itemId),
    sKU: line.sku,
    name: line.name,
    quantity: line.quantity,
    salesUnit: line.unit,
    salesPriceGross: line.price,
    salesPriceNet:
      Math.round((line.price / (1 + SEED_VAT_RATE / 100)) * 10_000) / 10_000,
    taxRate: SEED_VAT_RATE,
  }));
}

/** Serializes a delivery note with its packages. */
export function noteJson(note: NoteRecord) {
  return {
    id: Number(note.id),
    salesOrderId: Number(note.orderId),
    warehouseId: configId(note.warehouse),
    deliveryNoteDate: note.date,
    packages: note.packages.map((value) => ({
      id: Number(value.id),
      deliveryNoteId: Number(note.id),
      shippingDate: value.shippingDate,
      trackingNumber: value.trackingNumber,
      trackingUrl: value.trackingUrl,
    })),
  };
}

/** Serializes the line items of a delivery note. */
export function noteLinesJson(note: NoteRecord) {
  return note.lines.map((line) => ({
    id: Number(line.id),
    deliveryNoteId: Number(note.id),
    salesOrderLineItemId: Number(line.orderLineId),
    quantity: line.quantity,
  }));
}
