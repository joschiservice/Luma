import {
  type AssignmentRecord,
  configId,
  type ItemRecord,
  type JtlContext,
  kinds,
  next,
  type PurchaseOrderLine,
  type PurchaseOrderRecord,
  recordId,
  refuse,
  type SupplierRecord,
  warehouseOf,
} from './records.js';
import { loadItems, saveStock } from './stock.js';
import type { JtlCommand, SupplierEvent, SupplierProfile } from './types.js';

type ConfirmCommand = Extract<JtlCommand, { kind: 'purchase-order-confirm' }>;

type ReceiveCommand = Extract<JtlCommand, { kind: 'purchase-order-receive' }>;

type MerchantOrderCommand = Extract<JtlCommand, { kind: 'purchase-order' }>;

const calendarDate = (value: string) => value.slice(0, 10);

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${calendarDate(date)}T00:00:00Z`) + days * 86400000)
    .toISOString()
    .slice(0, 10);

/** True for an ISO calendar date or date-time. */
export const isDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}/.test(value) &&
  !Number.isNaN(Date.parse(value));

/** Plans a supplier's confirmation and goods receipts for a new order under its profile. */
export function supplierEvents(
  order: PurchaseOrderRecord,
  profile: SupplierProfile,
): SupplierEvent[] {
  const orderId = order.purchaseOrderId;
  const confirm = (share: number, days: number, delay = 20000) => ({
    delay,
    command: {
      kind: 'purchase-order-confirm' as const,
      orderId,
      lines: order.lineItems.map((line) => ({
        lineItemId: line.lineItemId,
        quantity: Math.max(1, Math.floor(line.quantity * share)),
        deliveryDate: addDays(line.deliveryDate, days),
      })),
    },
  });
  const receive = (
    delay: number,
    quantity: (line: PurchaseOrderLine) => number,
  ): SupplierEvent[] => {
    const lines = order.lineItems
      .map((line) => ({
        lineItemId: line.lineItemId,
        quantity: quantity(line),
      }))
      .filter((line) => line.quantity > 0);

    return lines.length
      ? [{ delay, command: { kind: 'purchase-order-receive', orderId, lines } }]
      : [];
  };
  const partial = (line: PurchaseOrderLine) =>
    Math.max(1, Math.floor(line.quantity * 0.6));
  if (profile === 'silent') return [];
  if (profile === 'partial')
    return [
      confirm(0.6, 3),
      ...receive(60000, (line) => Math.ceil(partial(line) / 2)),
      ...receive(90000, (line) => partial(line) - Math.ceil(partial(line) / 2)),
    ];
  if (profile === 'delayed')
    return [confirm(1, 7), ...receive(180000, (line) => line.quantity)];
  if (profile === 'short')
    return [
      confirm(1, 0),
      ...receive(60000, (line) => Math.floor(line.quantity / 2)),
    ];

  return [confirm(1, 0), ...receive(60000, (line) => line.quantity)];
}

async function loadSupplier(context: JtlContext, id: string) {
  const record = await context.store.get<SupplierRecord>(kinds.supplier, id);

  return record?.data;
}

/** Finds the assignment of an item to a supplier. */
async function assignment(
  context: JtlContext,
  itemId: string,
  supplierId: string,
) {
  const page = await context.store.page<AssignmentRecord>({
    kind: kinds.assignment,
    parent: itemId,
    key: supplierId,
    limit: 1,
  });

  return page.items[0]?.data;
}

interface OrderInput {
  supplier: SupplierRecord;
  requestedDeliveryDate: string;
  lines: {
    item: ItemRecord;
    quantity: number;
    netPrice: number;
    vatRate: number;
  }[];
  externalOrderNumber: string | null;
  internalComment: string | null;
}

/**
 * Records a purchase order and plans its supplier's answers under the supplier's current
 * profile. Creation time is the later of simulation and wall-clock time, because Luma looks
 * orders up by its own clock; it also orders `createdAtAfter` and `createdAtBefore` filters.
 */
async function recordPurchaseOrder(context: JtlContext, input: OrderInput) {
  const created = Math.max(context.now, context.wallTime);
  const id = await next(context, kinds.purchaseOrder);
  const order: PurchaseOrderRecord = {
    purchaseOrderId: id,
    supplierId: input.supplier.id,
    orderNumber: `BE-${id.padStart(5, '0')}`,
    externalOrderNumber: input.externalOrderNumber,
    internalComment: input.internalComment,
    status: 0,
    isConfirmed: false,
    createdAt: new Date(created).toISOString(),
    requestedDeliveryDate: input.requestedDeliveryDate,
    warehouseId: warehouseOf(context),
    lineItems: input.lines.map((line, index) => ({
      lineItemId: String(Number(id) * 1000 + index + 1),
      lineItemType: 1,
      itemId: line.item.id,
      itemNumber: line.item.sku,
      name: line.item.name,
      quantity: line.quantity,
      deliveredQuantity: 0,
      openQuantity: line.quantity,
      netPurchasePriceAmount: line.netPrice,
      vatRatePercentage: line.vatRate,
      sortOrder: index + 1,
      deliveryDate: input.requestedDeliveryDate,
      confirmedQuantity: null,
      confirmedDeliveryDate: null,
      isLineItemConfirmed: null,
    })),
  };
  await context.store.put(kinds.purchaseOrder, id, order, {
    createdAt: created,
    updatedAt: context.now,
  });

  return {
    order,
    supplierEvents: supplierEvents(order, input.supplier.profile),
  };
}

const optionalText = (value: unknown, max: number) =>
  value === undefined || value === null
    ? null
    : typeof value === 'string' && value.length <= max
      ? value
      : undefined;

/**
 * Creates a purchase order from an API request body like JTL: the supplier must be active and
 * every item assigned to it. A repeated Idempotency-Key returns the recorded order without
 * creating another; `created` is false then. Invalid requests throw a 400 refusal.
 */
export async function submitPurchaseOrder(
  context: JtlContext,
  body: unknown,
  key: string | undefined,
) {
  if (key !== undefined && (key.length < 1 || key.length > 255))
    refuse('Invalid Idempotency-Key');
  if (key) {
    const recorded = await context.store.get<{ purchaseOrderId: string }>(
      kinds.purchaseOrderKey,
      key,
    );
    if (recorded) return { id: recorded.data.purchaseOrderId, created: false };
  }
  const input = (typeof body === 'object' && body ? body : {}) as Record<
    string,
    unknown
  >;
  const supplierId = recordId(input.supplierId);
  const supplier = supplierId
    ? await loadSupplier(context, supplierId)
    : undefined;
  const externalOrderNumber = optionalText(input.externalOrderNumber, 255);
  const internalComment = optionalText(input.internalComment, 4000);
  const rows = input.items;
  if (
    !supplier?.active ||
    !isDate(input.requestedDeliveryDate) ||
    !Array.isArray(rows) ||
    !rows.length ||
    rows.length > 500 ||
    externalOrderNumber === undefined ||
    internalComment === undefined
  )
    refuse('Invalid purchase order');
  const lines: OrderInput['lines'] = [];
  for (const value of rows as unknown[]) {
    const row = (typeof value === 'object' && value ? value : {}) as Record<
      string,
      unknown
    >;
    const itemId = recordId(row.itemId);
    const item = itemId
      ? (await context.store.get<ItemRecord>(kinds.item, itemId))?.data
      : undefined;
    const { quantity, netPurchasePriceAmount, vatRatePercentage } = row;
    if (
      !item ||
      !(await assignment(context, item.id, supplier.id)) ||
      typeof quantity !== 'number' ||
      !(quantity > 0 && quantity < 1e9) ||
      typeof netPurchasePriceAmount !== 'number' ||
      !(netPurchasePriceAmount >= 0) ||
      typeof vatRatePercentage !== 'number' ||
      !(vatRatePercentage >= 0 && vatRatePercentage <= 100)
    )
      refuse('Item is not assigned to the supplier');
    lines.push({
      item,
      quantity,
      netPrice: netPurchasePriceAmount,
      vatRate: vatRatePercentage,
    });
  }
  const result = await recordPurchaseOrder(context, {
    supplier,
    requestedDeliveryDate: input.requestedDeliveryDate,
    lines,
    externalOrderNumber,
    internalComment,
  });
  const id = result.order.purchaseOrderId;
  if (key)
    await context.store.put(
      kinds.purchaseOrderKey,
      key,
      { purchaseOrderId: id },
      { createdAt: context.now, updatedAt: context.now },
    );
  context.notify({
    topic: 'purchase-orders/create',
    resource: id,
    payload: { purchaseOrderId: id, supplierEvents: result.supplierEvents },
  });

  return { id, created: true };
}

/**
 * Records a purchase order the merchant places in JTL, priced from the item supplier
 * assignments. Returns the supplier answers for the host to schedule.
 */
export async function placePurchaseOrder(
  context: JtlContext,
  command: MerchantOrderCommand,
) {
  const supplier = await loadSupplier(context, command.supplierId);
  if (!supplier?.active) refuse('Supplier not found', 404);
  if (
    !isDate(command.deliveryDate) ||
    !command.lines.length ||
    command.lines.length > 500 ||
    command.lines.some((line) => !(line.quantity > 0 && line.quantity < 1e9))
  )
    refuse('Invalid purchase order');
  const items = await loadItems(
    context,
    command.lines.map((line) => line.itemId),
  );
  const lines: OrderInput['lines'] = [];
  for (const line of command.lines) {
    const assigned = await assignment(context, line.itemId, supplier.id);
    if (!assigned) refuse('Item is not assigned to the supplier');
    lines.push({
      item: items.get(line.itemId)!,
      quantity: line.quantity,
      netPrice: assigned.netPrice,
      vatRate: assigned.vatRate,
    });
  }
  const { order, supplierEvents } = await recordPurchaseOrder(context, {
    supplier,
    requestedDeliveryDate: command.deliveryDate,
    lines,
    externalOrderNumber: null,
    internalComment: null,
  });
  context.notify({
    topic: 'purchase-orders/create',
    resource: order.purchaseOrderId,
    payload: { purchaseOrderId: order.purchaseOrderId },
  });

  return {
    id: order.purchaseOrderId,
    lines: order.lineItems.map((line) => ({
      id: line.lineItemId,
      itemId: line.itemId,
      quantity: line.quantity,
    })),
    supplierEvents,
  };
}

async function openPurchaseOrder(context: JtlContext, id: string) {
  const record = await context.store.get<PurchaseOrderRecord>(
    kinds.purchaseOrder,
    id,
  );
  if (!record) refuse('Purchase order not found', 404);
  if (record.data.status === 500) refuse('Purchase order is completed', 409);

  return record.data;
}

function lineOf(order: PurchaseOrderRecord, id: string) {
  const line = order.lineItems.find((value) => value.lineItemId === id);
  if (!line) refuse('Purchase-order line not found', 404);

  return line;
}

async function savePurchaseOrder(
  context: JtlContext,
  order: PurchaseOrderRecord,
) {
  await context.store.put(kinds.purchaseOrder, order.purchaseOrderId, order, {
    updatedAt: context.now,
  });
  context.notify({
    topic: 'purchase-orders/update',
    resource: order.purchaseOrderId,
    payload: {
      purchaseOrderId: order.purchaseOrderId,
      status: order.status,
      isConfirmed: order.isConfirmed,
    },
  });
}

/** Records a supplier's confirmation; every line in full for its requested date when omitted. */
export async function confirmPurchaseOrder(
  context: JtlContext,
  command: ConfirmCommand,
) {
  const order = await openPurchaseOrder(context, command.orderId);
  const lines =
    command.lines ??
    order.lineItems.map((line) => ({
      lineItemId: line.lineItemId,
      quantity: line.quantity,
      deliveryDate: line.deliveryDate,
    }));
  if (
    new Set(lines.map((line) => line.lineItemId)).size !== lines.length ||
    lines.some((line) => !(line.quantity >= 0) || !isDate(line.deliveryDate))
  )
    refuse('Invalid confirmation');
  const targets = lines.map(
    (line) => [lineOf(order, line.lineItemId), line] as const,
  );
  for (const [target, value] of targets) {
    target.confirmedQuantity = value.quantity;
    target.confirmedDeliveryDate = `${calendarDate(value.deliveryDate)}T00:00:00Z`;
    target.isLineItemConfirmed = true;
  }
  order.isConfirmed = true;
  await savePurchaseOrder(context, order);

  return { id: order.purchaseOrderId };
}

/**
 * Books a goods receipt: delivered quantities rise, open quantities fall and the units are added
 * to the receiving warehouse, by default the order's warehouse. The order becomes partially
 * delivered (30) or completed (500).
 */
export async function receivePurchaseOrder(
  context: JtlContext,
  command: ReceiveCommand,
) {
  const order = await openPurchaseOrder(context, command.orderId);
  const warehouse = warehouseOf(
    context,
    command.warehouse ?? order.warehouseId,
  );
  const targets = command.lines.map(
    (line) => [lineOf(order, line.lineItemId), line] as const,
  );
  if (
    !targets.length ||
    new Set(command.lines.map((line) => line.lineItemId)).size !==
      command.lines.length ||
    targets.some(
      ([target, value]) =>
        !(value.quantity > 0) || value.quantity > target.openQuantity,
    )
  )
    refuse('Invalid goods receipt');
  const items = await loadItems(
    context,
    targets.map(([target]) => target.itemId),
  );
  for (const [target, value] of targets) {
    const item = items.get(target.itemId)!;
    target.deliveredQuantity += value.quantity;
    target.openQuantity -= value.quantity;
    item.stock[warehouse] = (item.stock[warehouse] ?? 0) + value.quantity;
  }
  order.status = order.lineItems.every((line) => line.openQuantity === 0)
    ? 500
    : 30;
  await savePurchaseOrder(context, order);
  await saveStock(context, items.values());

  return { id: order.purchaseOrderId };
}

/** Changes how a supplier answers purchase orders placed from now on. */
export async function setSupplierProfile(
  context: JtlContext,
  supplierId: string,
  profile: SupplierProfile,
) {
  const supplier = await loadSupplier(context, supplierId);
  if (!supplier) refuse('Supplier not found', 404);
  supplier.profile = profile;
  await context.store.put(kinds.supplier, supplier.id, supplier, {
    updatedAt: context.now,
  });

  return { id: supplier.id };
}

/** Serializes a supplier overview row. */
export function supplierRowJson(supplier: SupplierRecord) {
  return {
    id: Number(supplier.id),
    name: supplier.companyName,
    companyName: supplier.companyName,
    supplierNumber: supplier.supplierNumber,
    canDropship: false,
    currencyIso: 'EUR',
    city: supplier.city,
    countryIso: supplier.countryIso,
  };
}

/** Serializes a supplier detail. */
export function supplierJson(supplier: SupplierRecord) {
  return {
    id: Number(supplier.id),
    supplierNumber: supplier.supplierNumber,
    companyName: supplier.companyName,
    canDropship: false,
    currencyIso: 'EUR',
    isActive: supplier.active,
    address: { city: supplier.city, countryIso: supplier.countryIso },
    contact: { emailAddress: supplier.email },
    isVatExempt: false,
    isExcludedFromPurchaseList: false,
    allowsDropshipCashOnDelivery: false,
    allowsDropshipFreeLineItems: false,
  };
}

/** Serializes an item supplier assignment. */
export function assignmentJson(
  assignment: AssignmentRecord,
  supplierName: string | null,
) {
  return {
    id: Number(assignment.id),
    itemId: Number(assignment.itemId),
    supplierId: Number(assignment.supplierId),
    supplierName,
    supplierCurrency: 'EUR',
    netPurchasePrice: assignment.netPrice,
    vatRate: assignment.vatRate,
    isDefaultSupplier: assignment.isDefault,
  };
}

/** Serializes a purchase-order overview row. */
export function purchaseOrderRowJson(
  order: PurchaseOrderRecord,
  supplierName: string | null,
) {
  return {
    purchaseOrderId: Number(order.purchaseOrderId),
    supplierId: Number(order.supplierId),
    supplierName,
    orderNumber: order.orderNumber,
    status: order.status,
    createdAt: order.createdAt,
    requestedDeliveryDate: order.requestedDeliveryDate,
    warehouseId: configId(order.warehouseId),
  };
}

/** Serializes a purchase-order detail. */
export function purchaseOrderJson(
  order: PurchaseOrderRecord,
  supplierName: string | null,
) {
  return {
    ...order,
    purchaseOrderId: Number(order.purchaseOrderId),
    supplierId: Number(order.supplierId),
    supplierName,
    currencyIso: 'EUR',
    currencyFactor: 1,
    warehouseId: configId(order.warehouseId),
    allowancesAndCharges: [],
    deliveryAddress: {
      companyName: 'Luma Goods GmbH',
      street: 'Lagerstraße 1',
      postalCode: '20095',
      city: 'Hamburg',
      countryIso: 'DE',
    },
    lineItems: order.lineItems.map((line) => ({
      ...line,
      lineItemId: Number(line.lineItemId),
      itemId: Number(line.itemId),
    })),
  };
}
