import type { ProviderResponse } from '@luma/simulator-core';
import { json } from '@luma/simulator-core';

/** How a simulated supplier answers new purchase orders. */
export type SupplierProfile =
  'full' | 'partial' | 'delayed' | 'silent' | 'short';

export const supplierProfiles = [
  'full',
  'partial',
  'delayed',
  'silent',
  'short',
] as const satisfies readonly SupplierProfile[];

export interface JtlSupplier {
  id: string;
  companyName: string;
  supplierNumber: string;
  isActive: boolean;
  email: string;
  city: string;
  countryIso: string;
}

export interface JtlItemSupplier {
  id: string;
  itemId: string;
  supplierId: string;
  netPurchasePrice: number;
  vatRate: number;
  isDefaultSupplier: boolean;
}

export interface JtlPurchaseOrderLine {
  lineItemId: string;
  lineItemType: 1;
  itemId: string;
  itemNumber: string;
  name: string;
  quantity: number;
  deliveredQuantity: number;
  openQuantity: number;
  netPurchasePriceAmount: number;
  vatRatePercentage: number;
  sortOrder: number;
  deliveryDate: string;
  confirmedQuantity: number | null;
  confirmedDeliveryDate: string | null;
  isLineItemConfirmed: boolean | null;
}

export interface JtlPurchaseOrder {
  purchaseOrderId: string;
  supplierId: string;
  orderNumber: string;
  externalOrderNumber: string | null;
  internalComment: string | null;
  /** 0 Open, 5 Released, 20 InProgress, 30 PartiallyDelivered, 50 Overdue, 500 Completed. */
  status: 0 | 5 | 20 | 30 | 50 | 500;
  isConfirmed: boolean;
  createdAt: string;
  requestedDeliveryDate: string;
  lineItems: JtlPurchaseOrderLine[];
}

export interface JtlPurchasing {
  suppliers: JtlSupplier[];
  itemSuppliers: JtlItemSupplier[];
  purchaseOrders: JtlPurchaseOrder[];
  /** Recorded results of keyed POST requests, replayed for a repeated key. */
  purchaseOrderKeys: { key: string; purchaseOrderId: string }[];
  /** Per-supplier behavior for new orders; absent suppliers use `full`. */
  supplierProfiles: Record<string, SupplierProfile>;
}

export type PurchasingCommand =
  | {
      kind: 'purchase-order-confirm';
      orderId: string;
      lines?:
        | { lineItemId: string; quantity: number; deliveryDate: string }[]
        | undefined;
    }
  | {
      kind: 'purchase-order-receive';
      orderId: string;
      lines: { lineItemId: string; quantity: number }[];
    }
  | { kind: 'supplier-profile'; supplierId: string; profile: SupplierProfile };

/** A supplier response to a new order, due after `delay` simulation milliseconds. */
export interface SupplierEvent {
  delay: number;
  command: Extract<
    PurchasingCommand,
    { kind: 'purchase-order-confirm' | 'purchase-order-receive' }
  >;
}

interface StockItem {
  id: string;
  sKU: string;
  name: string;
  stockTotal: string;
  stockReservedTotal: string;
  stockAvailable: string;
  modifiedTimestamp?: string;
}

/** Seeds two synthetic suppliers and supplier assignments for the seeded items. */
export function seedPurchasing(): JtlPurchasing {
  return {
    suppliers: [
      {
        id: '1',
        companyName: 'Nordwind Textil GmbH',
        supplierNumber: 'L-1001',
        isActive: true,
        email: 'orders@nordwind-textil.example',
        city: 'Hamburg',
        countryIso: 'DE',
      },
      {
        id: '2',
        companyName: 'Baltic Packaging AB',
        supplierNumber: 'L-1002',
        isActive: true,
        email: 'purchasing@baltic-packaging.example',
        city: 'Malmö',
        countryIso: 'SE',
      },
    ],
    itemSuppliers: [
      {
        id: '1',
        itemId: '1',
        supplierId: '1',
        netPurchasePrice: 9.5,
        vatRate: 19,
        isDefaultSupplier: true,
      },
      {
        id: '2',
        itemId: '1',
        supplierId: '2',
        netPurchasePrice: 10.2,
        vatRate: 19,
        isDefaultSupplier: false,
      },
      {
        id: '3',
        itemId: '2',
        supplierId: '1',
        netPurchasePrice: 9.5,
        vatRate: 19,
        isDefaultSupplier: true,
      },
    ],
    purchaseOrders: [],
    purchaseOrderKeys: [],
    supplierProfiles: {},
  };
}

/** Adds purchasing records to state saved before purchasing was simulated. */
export function ensurePurchasing(state: Partial<JtlPurchasing>) {
  const seeded = seedPurchasing();
  state.suppliers ??= seeded.suppliers;
  state.itemSuppliers ??= seeded.itemSuppliers;
  state.purchaseOrders ??= [];
  state.purchaseOrderKeys ??= [];
  state.supplierProfiles ??= {};
}

const calendarDate = (value: string) => value.slice(0, 10);

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${calendarDate(date)}T00:00:00Z`) + days * 86400000)
    .toISOString()
    .slice(0, 10);

/** Plans a supplier's confirmation and goods receipts for a new order under its profile. */
export function supplierEvents(
  order: JtlPurchaseOrder,
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
    quantity: (line: JtlPurchaseOrderLine) => number,
  ): SupplierEvent[] => {
    const lines = order.lineItems
      .map((line) => ({
        lineItemId: line.lineItemId,
        quantity: quantity(line),
      }))
      .filter((line) => line.quantity > 0);

    return lines.length
      ? [
          {
            delay,
            command: { kind: 'purchase-order-receive', orderId, lines },
          },
        ]
      : [];
  };
  const partial = (line: JtlPurchaseOrderLine) =>
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

function touch(item: StockItem, time: number) {
  item.stockAvailable = String(
    Number(item.stockTotal) - Number(item.stockReservedTotal),
  );
  const previous = item.modifiedTimestamp
    ? Date.parse(item.modifiedTimestamp) + 1
    : time;
  item.modifiedTimestamp = new Date(Math.max(time, previous)).toISOString();
}

/** Applies a merchant's recording of supplier confirmation, goods receipt or a supplier profile. */
export function purchasingCommand(
  state: JtlPurchasing & { items: StockItem[] },
  command: PurchasingCommand,
  time: number,
) {
  if (command.kind === 'supplier-profile') {
    if (!state.suppliers.some((s) => s.id === command.supplierId))
      throw new Error('Supplier not found');
    state.supplierProfiles[command.supplierId] = command.profile;

    return;
  }
  const order = state.purchaseOrders.find(
    (o) => o.purchaseOrderId === command.orderId,
  );
  if (!order) throw new Error('Purchase order not found');
  if (order.status === 500) throw new Error('Purchase order is completed');
  const line = (id: string) => {
    const found = order.lineItems.find((l) => l.lineItemId === id);
    if (!found) throw new Error('Purchase-order line not found');

    return found;
  };
  if (command.kind === 'purchase-order-confirm') {
    const lines =
      command.lines ??
      order.lineItems.map((l) => ({
        lineItemId: l.lineItemId,
        quantity: l.quantity,
        deliveryDate: l.deliveryDate,
      }));
    if (
      new Set(lines.map((l) => l.lineItemId)).size !== lines.length ||
      lines.some((l) => !(l.quantity >= 0))
    )
      throw new Error('Invalid confirmation');
    const targets = lines.map((l) => [line(l.lineItemId), l] as const);
    for (const [target, value] of targets) {
      target.confirmedQuantity = value.quantity;
      target.confirmedDeliveryDate = `${calendarDate(value.deliveryDate)}T00:00:00Z`;
      target.isLineItemConfirmed = true;
    }
    order.isConfirmed = true;

    return;
  }
  const targets = command.lines.map((l) => [line(l.lineItemId), l] as const);
  if (
    new Set(command.lines.map((l) => l.lineItemId)).size !==
      command.lines.length ||
    targets.some(
      ([target, value]) =>
        !(value.quantity > 0) || value.quantity > target.openQuantity,
    )
  )
    throw new Error('Invalid goods receipt');
  for (const [target, value] of targets) {
    const item = state.items.find((i) => i.id === target.itemId);
    if (!item) throw new Error('Item not found');
    target.deliveredQuantity += value.quantity;
    target.openQuantity -= value.quantity;
    item.stockTotal = String(Number(item.stockTotal) + value.quantity);
    touch(item, time);
  }
  order.status = order.lineItems.every((l) => l.openQuantity === 0) ? 500 : 30;
}

interface CreateRequest {
  supplierId?: unknown;
  requestedDeliveryDate?: unknown;
  items?: unknown;
  externalOrderNumber?: unknown;
  internalComment?: unknown;
}

const isDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}/.test(value) &&
  !Number.isNaN(Date.parse(value));

const optionalText = (value: unknown, max: number) =>
  value === undefined || value === null
    ? null
    : typeof value === 'string' && value.length <= max
      ? value
      : undefined;

/**
 * Creates a purchase order like JTL: the supplier must exist and every item must be assigned to
 * it. A repeated Idempotency-Key returns the recorded result without another order.
 * `createdAt` is the provider's wall-clock creation time.
 */
export function createPurchaseOrder(
  state: JtlPurchasing & { items: StockItem[] },
  body: string | null,
  key: string | undefined,
  createdAt: number,
): ProviderResponse {
  if (key !== undefined && (key.length < 1 || key.length > 255))
    return json({ title: 'Invalid Idempotency-Key' }, 400);
  const recorded = key
    ? state.purchaseOrderKeys.find((record) => record.key === key)
    : undefined;
  if (recorded) return json({ purchaseOrderId: recorded.purchaseOrderId }, 201);
  let input: CreateRequest;
  try {
    input = JSON.parse(body ?? '') as CreateRequest;
  } catch {
    return json({ title: 'Invalid body' }, 400);
  }
  const supplier = state.suppliers.find(
    (s) => s.id === String(input.supplierId),
  );
  const externalOrderNumber = optionalText(input.externalOrderNumber, 255);
  const internalComment = optionalText(input.internalComment, 4000);
  if (
    !supplier ||
    !supplier.isActive ||
    !isDate(input.requestedDeliveryDate) ||
    !Array.isArray(input.items) ||
    !input.items.length ||
    input.items.length > 500 ||
    externalOrderNumber === undefined ||
    internalComment === undefined
  )
    return json({ title: 'Invalid purchase order' }, 400);
  const id = String(state.purchaseOrders.length + 1);
  const lines: JtlPurchaseOrderLine[] = [];
  for (const [index, value] of (input.items as unknown[]).entries()) {
    const row = value as Record<string, unknown>;
    const item = state.items.find((i) => i.id === String(row.itemId));
    const assigned = state.itemSuppliers.some(
      (a) => a.itemId === item?.id && a.supplierId === supplier.id,
    );
    const { quantity, netPurchasePriceAmount, vatRatePercentage } = row;
    if (
      !item ||
      !assigned ||
      typeof quantity !== 'number' ||
      !(quantity > 0) ||
      typeof netPurchasePriceAmount !== 'number' ||
      !(netPurchasePriceAmount >= 0) ||
      typeof vatRatePercentage !== 'number' ||
      !(vatRatePercentage >= 0 && vatRatePercentage <= 100)
    )
      return json({ title: 'Item is not assigned to the supplier' }, 400);
    lines.push({
      lineItemId: String(Number(id) * 1000 + index + 1),
      lineItemType: 1,
      itemId: item.id,
      itemNumber: item.sKU,
      name: item.name,
      quantity,
      deliveredQuantity: 0,
      openQuantity: quantity,
      netPurchasePriceAmount,
      vatRatePercentage,
      sortOrder: index + 1,
      deliveryDate: input.requestedDeliveryDate,
      confirmedQuantity: null,
      confirmedDeliveryDate: null,
      isLineItemConfirmed: null,
    });
  }
  const order: JtlPurchaseOrder = {
    purchaseOrderId: id,
    supplierId: supplier.id,
    orderNumber: `BE-${id.padStart(5, '0')}`,
    externalOrderNumber,
    internalComment,
    status: 0,
    isConfirmed: false,
    createdAt: new Date(createdAt).toISOString(),
    requestedDeliveryDate: input.requestedDeliveryDate,
    lineItems: lines,
  };
  state.purchaseOrders.push(order);
  if (key) state.purchaseOrderKeys.push({ key, purchaseOrderId: id });

  return { ...json({ purchaseOrderId: id }, 201), committed: true };
}

/** Serializes a purchase-order detail with JTL field names. */
export function purchaseOrderDetail(
  state: JtlPurchasing,
  order: JtlPurchaseOrder,
) {
  const supplier = state.suppliers.find((s) => s.id === order.supplierId);

  return {
    ...order,
    supplierName: supplier?.companyName ?? null,
    currencyIso: 'EUR',
    currencyFactor: 1,
    warehouseId: '1',
    allowancesAndCharges: [],
    deliveryAddress: {
      companyName: 'Luma Goods GmbH',
      street: 'Lagerstraße 1',
      postalCode: '20095',
      city: 'Hamburg',
      countryIso: 'DE',
    },
  };
}

/** Serves supplier, item-supplier and purchase-order reads; returns undefined for other paths. */
export function readPurchasing(
  state: JtlPurchasing,
  root: string,
  id: string | undefined,
  child: string | undefined,
  url: URL,
  page: (rows: unknown[]) => ProviderResponse,
): ProviderResponse | undefined {
  if (root === 'items' && id && child === 'suppliers')
    return page(
      state.itemSuppliers
        .filter((a) => a.itemId === id)
        .map((a) => ({
          ...a,
          supplierName:
            state.suppliers.find((s) => s.id === a.supplierId)?.companyName ??
            null,
          supplierCurrency: 'EUR',
        })),
    );
  if (root === 'suppliers') {
    if (!id)
      return page(
        state.suppliers
          .filter((s) => s.isActive)
          .map((s) => ({
            id: s.id,
            name: s.companyName,
            companyName: s.companyName,
            supplierNumber: s.supplierNumber,
            canDropship: false,
            currencyIso: 'EUR',
            city: s.city,
            countryIso: s.countryIso,
          })),
      );
    const supplier = state.suppliers.find((s) => s.id === id);
    if (!supplier || child) return json({}, 404);

    return json({
      id: supplier.id,
      supplierNumber: supplier.supplierNumber,
      companyName: supplier.companyName,
      canDropship: false,
      currencyIso: 'EUR',
      isActive: supplier.isActive,
      address: { city: supplier.city, countryIso: supplier.countryIso },
      contact: { emailAddress: supplier.email },
      isVatExempt: false,
      isExcludedFromPurchaseList: false,
      allowsDropshipCashOnDelivery: false,
      allowsDropshipFreeLineItems: false,
    });
  }
  if (root !== 'purchase-orders') return undefined;
  if (!id) {
    const after = url.searchParams.get('createdAtAfter');
    const before = url.searchParams.get('createdAtBefore');
    if ((after && !isDate(after)) || (before && !isDate(before)))
      return json({}, 400);

    return page(
      state.purchaseOrders
        .filter(
          (o) =>
            (!after || Date.parse(o.createdAt) > Date.parse(after)) &&
            (!before || Date.parse(o.createdAt) < Date.parse(before)),
        )
        .map((o) => ({
          purchaseOrderId: o.purchaseOrderId,
          supplierId: o.supplierId,
          supplierName:
            state.suppliers.find((s) => s.id === o.supplierId)?.companyName ??
            null,
          orderNumber: o.orderNumber,
          status: o.status,
          createdAt: o.createdAt,
          requestedDeliveryDate: o.requestedDeliveryDate,
          warehouseId: '1',
        })),
    );
  }
  const order = state.purchaseOrders.find((o) => o.purchaseOrderId === id);
  if (!order || child) return json({}, 404);

  return json(purchaseOrderDetail(state, order));
}
