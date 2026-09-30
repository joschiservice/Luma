import type { ProviderRequest } from '@luma/simulator-core';
import { json } from '@luma/simulator-core';

export interface JtlState {
  orders: {
    id: string;
    salesOrderNumber: string;
    isCancelled: boolean;
    deliveryStatus: number;
    paymentStatus: number;
    shippingMethodId: string;
    /** Absent in simulator states saved before order dates and totals were recorded. */
    salesOrderDate?: string;
    totalGrossAmount?: number;
    currencyIso?: string;
  }[];
  lines: {
    id: string;
    salesOrderId: string;
    itemId: string;
    quantity: string;
    salesUnit: string;
    name?: string;
    sKU?: string;
  }[];
  items: {
    id: string;
    sKU: string;
    name: string;
    unit: string;
    isActive: boolean;
    isInventoryManagementActive: boolean;
    stockTotal: string;
    stockReservedTotal: string;
    stockAvailable: string;
    modifiedTimestamp?: string;
    salesPriceGross?: string;
    gTIN?: string;
    manufacturerName?: string;
    isShopActive?: boolean;
  }[];
  notes: {
    id: string;
    salesOrderId: string;
    deliveryNoteDate: string;
    packages: {
      id: string;
      deliveryNoteId: string;
      shippingDate: string;
      trackingNumber?: string;
      trackingUrl?: string;
    }[];
  }[];
  noteLines: {
    id: string;
    deliveryNoteId: string;
    salesOrderLineItemId: string;
    quantity: string;
  }[];
  shippingMethods: { id: string; name: string }[];
}

export type JtlCommand =
  | { kind: 'order'; id: string; quantity: number }
  | { kind: 'stock'; quantity: number; id?: string | undefined }
  | { kind: 'ship'; id: string }
  | { kind: 'shipping-method'; id: string; shippingMethodId: string };

// Simulated orders sell the seeded tote at a fixed gross price.
const unitPrice = 24;

/** Seeds independent JTL records using provider field names. */
export function seed(): JtlState {
  return {
    orders: [],
    lines: [],
    items: [
      {
        id: '1',
        sKU: 'LUMA-001',
        name: 'Canvas tote',
        unit: 'each',
        isActive: true,
        isInventoryManagementActive: true,
        stockTotal: '100',
        stockReservedTotal: '0',
        stockAvailable: '100',
        salesPriceGross: '24.00',
        gTIN: '4006381333931',
        manufacturerName: 'Luma Goods',
        isShopActive: true,
      },
    ],
    notes: [],
    noteLines: [],
    shippingMethods: [
      { id: '7', name: 'Standard' },
      { id: '8', name: 'Express' },
      { id: '9', name: 'Pickup' },
    ],
  };
}

/** Adds a dedicated stock pool for operational scenarios without changing merchant inventory. */
export function provisionScenarioStock(state: JtlState, time: number) {
  if (state.items.some((item) => item.id === '2')) return;
  state.items.push({
    id: '2',
    sKU: 'LUMA-SCENARIO-001',
    name: 'Canvas tote · scenario',
    unit: 'each',
    salesPriceGross: '24.00',
    manufacturerName: 'Luma Goods',
    isShopActive: false,
    isActive: true,
    isInventoryManagementActive: true,
    stockTotal: '100',
    stockReservedTotal: '0',
    stockAvailable: '100',
    modifiedTimestamp: new Date(time).toISOString(),
  });
}

/** Applies an external merchant action; writes do not promise compare-and-swap or idempotency. */
export function command(state: JtlState, command: JtlCommand, time: number) {
  const item =
    command.kind === 'stock' && command.id
      ? state.items.find((item) => item.id === command.id)
      : state.items[0];
  if (!item) throw new Error('Item not found');
  if (command.kind === 'order') {
    if (
      !/^[1-9]\d*$/.test(command.id) ||
      !Number.isSafeInteger(command.quantity) ||
      command.quantity < 1 ||
      state.orders.some((o) => o.id === command.id)
    )
      throw new Error('Invalid or duplicate order');
    state.orders.push({
      id: command.id,
      salesOrderNumber: `SIM-${command.id}`,
      isCancelled: false,
      deliveryStatus: 1,
      paymentStatus: 2,
      shippingMethodId: '7',
      salesOrderDate: new Date(time).toISOString(),
      totalGrossAmount: command.quantity * unitPrice,
      currencyIso: 'EUR',
    });
    state.lines.push({
      id: command.id,
      salesOrderId: command.id,
      itemId: item.id,
      quantity: String(command.quantity),
      salesUnit: 'each',
      name: item.name,
      sKU: item.sKU,
    });
    item.stockReservedTotal = String(
      Number(item.stockReservedTotal) + command.quantity,
    );
  } else if (command.kind === 'stock') {
    if (
      !Number.isSafeInteger(command.quantity) ||
      command.quantity < 0 ||
      command.quantity > 2147483647
    )
      throw new Error('Invalid stock');
    item.stockTotal = String(command.quantity);
  } else {
    const order = state.orders.find((o) => o.id === command.id);
    if (!order) throw new Error('Order not found');
    if (command.kind === 'shipping-method') {
      if (
        !state.shippingMethods.some((m) => m.id === command.shippingMethodId) ||
        order.isCancelled
      )
        throw new Error('Invalid shipping method');
      order.shippingMethodId = command.shippingMethodId;
    } else {
      if (state.notes.some((n) => n.salesOrderId === order.id))
        throw new Error('Order already shipped');
      const line = state.lines.find((l) => l.salesOrderId === order.id)!;
      const at = new Date(time).toISOString();
      state.notes.push({
        id: order.id,
        salesOrderId: order.id,
        deliveryNoteDate: at,
        packages: [
          {
            id: order.id,
            deliveryNoteId: order.id,
            shippingDate: at,
            trackingNumber: `JJD${order.id.padStart(12, '0')}`,
            trackingUrl: `https://tracking.example.test/JJD${order.id.padStart(12, '0')}`,
          },
        ],
      });
      state.noteLines.push({
        id: order.id,
        deliveryNoteId: order.id,
        salesOrderLineItemId: line.id,
        quantity: line.quantity,
      });
      order.deliveryStatus = 5;
      item.stockTotal = String(Number(item.stockTotal) - Number(line.quantity));
      item.stockReservedTotal = String(
        Number(item.stockReservedTotal) - Number(line.quantity),
      );
    }
  }
  item.stockAvailable = String(
    Number(item.stockTotal) - Number(item.stockReservedTotal),
  );
  if (command.kind !== 'shipping-method') {
    const previous = item.modifiedTimestamp
      ? Date.parse(item.modifiedTimestamp) + 1
      : time;
    item.modifiedTimestamp = new Date(Math.max(time, previous)).toISOString();
  }
}

/** Identifies a JTL request for fault targeting and journal links. */
export function identify(request: ProviderRequest) {
  const path = new URL(request.url).pathname;
  const order = /sales-orders\/([^/]+)(?:\/line-items)?$/.exec(path);

  const resource =
    /(?:sales-orders|delivery-notes|items)\/([^/]+)(?:\/(?:line-items|stocks))?$/.exec(
      path,
    )?.[1];

  return {
    operation:
      request.method === 'PATCH'
        ? 'orders.shipping-method.write'
        : path.includes('sales-orders')
          ? order && !path.endsWith('line-items')
            ? 'orders.shipping-method.read'
            : 'orders.read'
          : path.includes('delivery-notes')
            ? 'fulfillment.read'
            : 'items.read',
    ...(resource ? { resource } : {}),
  };
}

/** Serves the JTL surface consumed by the real connector, including nested pages. */
export function handle(
  state: JtlState,
  request: ProviderRequest,
  time: number,
) {
  const url = new URL(request.url);
  const match =
    /\/(sales-orders|items|delivery-notes|warehouses|shipping-methods)(?:\/(.*))?$/.exec(
      url.pathname,
    );
  if (!match) return json({}, 404);
  const [, root, rest] = match;
  const [id, child] = (rest ?? '').split('/');
  if (
    !request.headers.authorization?.startsWith('Wawi ') &&
    !request.headers.authorization?.startsWith('Bearer ')
  )
    return json({}, 401);
  if (request.method === 'PATCH' && root === 'sales-orders' && id && !child) {
    if (!state.orders.some((o) => o.id === id)) return json({}, 404);
    try {
      const body = JSON.parse(request.body ?? '{}') as {
        shippingMethodId: string;
      };
      command(
        state,
        {
          kind: 'shipping-method',
          id,
          shippingMethodId: String(body.shippingMethodId),
        },
        time,
      );
    } catch {
      return json({}, 400);
    }

    return { ...json({ salesOrderId: id }), committed: true };
  }
  if (request.method !== 'GET') return json({}, 405);
  const page = (rows: unknown[]) => {
    const number = Number(url.searchParams.get('pageNumber') ?? 1);
    const size = Number(url.searchParams.get('pageSize') ?? 100);
    if (
      !Number.isSafeInteger(number) ||
      number < 1 ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > 1000
    )
      return json({}, 400);

    return json({
      items: rows.slice((number - 1) * size, number * size),
      pageNumber: number,
      pageSize: size,
      totalItems: rows.length,
      hasNextPage: number * size < rows.length,
      nextPageNumber: number + 1,
    });
  };
  if (root === 'shipping-methods') return page(state.shippingMethods);
  if (root === 'warehouses')
    return id === '1' && child === 'items' && rest?.endsWith('/1/stocks')
      ? json({ totalQuantity: state.items[0]!.stockTotal, lockedQuantity: '0' })
      : json({}, 404);
  if (root === 'items') return page(state.items);
  if (root === 'sales-orders') {
    if (!id) return page(state.orders);
    const order = state.orders.find((o) => o.id === id);
    if (!order) return json({}, 404);

    return child === 'line-items'
      ? json(state.lines.filter((l) => l.salesOrderId === id))
      : json({
          ...order,
          shippingDetails: {
            shippingDate:
              state.notes
                .find((note) => note.salesOrderId === order.id)
                ?.packages.find((item) => item.shippingDate)?.shippingDate ??
              null,
          },
        });
  }
  if (!id)
    return page(
      state.notes.filter(
        (n) =>
          !url.searchParams.has('salesOrderNumberId') ||
          n.salesOrderId === url.searchParams.get('salesOrderNumberId'),
      ),
    );
  const note = state.notes.find((n) => n.id === id);
  if (!note) return json({}, 404);

  return child === 'line-items'
    ? page(state.noteLines.filter((l) => l.deliveryNoteId === id))
    : json(note);
}
