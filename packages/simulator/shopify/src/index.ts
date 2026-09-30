import type { ProviderRequest } from '@luma/simulator-core';
import { json } from '@luma/simulator-core';

interface Node {
  id: string;
  [key: string]: unknown;
}

export interface ShopifyState {
  nodes: Record<string, Node>;
  roots: { orders: string[]; products: string[]; inventoryItems: string[] };
  children: Record<string, Record<string, string[]>>;
  /** Durable provider idempotency receipts, retained when the simulator run is restored. */
  inventoryCorrections?: Record<string, { input: string; receipt: unknown }>;
}

/** Restores total quantities in saved simulator graphs created before this field was stored. */
export function restoreTotalQuantities(state: ShopifyState): boolean {
  let changed = false;
  for (const node of Object.values(state.nodes)) {
    if (
      !node.id.startsWith('gid://shopify/FulfillmentOrderLineItem/') ||
      node.totalQuantity !== undefined
    )
      continue;
    // The simulator creates one fulfillment order per order, with the same line quantity.
    const line = node.lineItem as { id: string };
    const quantity = state.nodes[line.id]?.quantity;
    if (typeof quantity !== 'number' || quantity <= 0)
      throw new Error(
        'Saved fulfillment order has no valid order line quantity',
      );
    node.totalQuantity = quantity;
    changed = true;
  }

  return changed;
}

export type ShopifyCommand =
  | { kind: 'order'; id: string; quantity: number }
  | { kind: 'stock'; quantity: number; id?: string | undefined }
  | { kind: 'ship'; id: string }
  | ReturnCommand;

/**
 * Merchant and customer return steps for a shipped order. Each order has at most one
 * return; every refund is a new Shopify refund with one payment attempt.
 */
type ReturnCommand =
  | { kind: 'return'; id: string; quantity: number }
  | {
      kind:
        | 'return-approve'
        | 'return-decline'
        | 'return-receive'
        | 'return-close'
        | 'refund-settle';
      id: string;
    }
  | { kind: 'refund'; id: string; outcome: 'success' | 'pending' | 'failure' };

const returnKinds = new Set<string>([
  'return',
  'return-approve',
  'return-decline',
  'return-receive',
  'return-close',
  'refund',
  'refund-settle',
]);

/** Whether a command changes a return or refund rather than orders or stock. */
const isReturnCommand = (value: ShopifyCommand): value is ReturnCommand =>
  returnKinds.has(value.kind);
const gid = (type: string, id = '1') => `gid://shopify/${type}/${id}`;

// Simulated orders sell the seeded tote at a fixed shop-currency price.
const unitPrice = 24;

/** Reads the seeded stock pool's on-hand, reserved, and available quantities. */
export function stock(state: ShopifyState, id = '1') {
  const values = state.nodes[gid('InventoryLevel', id)]!.quantities as {
    name: string;
    quantity: number;
  }[];

  return {
    onHand: values.find((value) => value.name === 'on_hand')!.quantity,
    reserved: values.find((value) => value.name === 'committed')!.quantity,
    available: values.find((value) => value.name === 'available')!.quantity,
  };
}

/** Seeds Shopify's own resource graph, independently of normalized observations. */
export function seed(time: number): ShopifyState {
  const updatedAt = new Date(time).toISOString();
  const nodes: Node[] = [
    {
      id: gid('Product'),
      updatedAt,
      title: 'Canvas tote',
      status: 'ACTIVE',
      vendor: 'Luma Goods',
      publishedAt: updatedAt,
      priceRangeV2: {
        minVariantPrice: { amount: '24.0', currencyCode: 'EUR' },
      },
    },
    {
      id: gid('ProductVariant'),
      sku: 'LUMA-001',
      title: 'Default Title',
      price: '24.00',
      barcode: '4006381333931',
      inventoryItem: { id: gid('InventoryItem') },
    },
    { id: gid('InventoryItem'), tracked: true },
    {
      id: gid('InventoryLevel'),
      updatedAt,
      location: { id: gid('Location') },
      quantities: [
        { name: 'on_hand', quantity: 100 },
        { name: 'committed', quantity: 0 },
        { name: 'available', quantity: 100 },
      ],
    },
  ];

  return {
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    roots: {
      orders: [],
      products: [gid('Product')],
      inventoryItems: [gid('InventoryItem')],
    },
    children: {
      [gid('Product')]: { variants: [gid('ProductVariant')] },
      [gid('InventoryItem')]: { inventoryLevels: [gid('InventoryLevel')] },
    },
  };
}

/** Adds a dedicated stock pool for operational scenarios without changing merchant inventory. */
export function provisionScenarioStock(state: ShopifyState, time: number) {
  const item = gid('InventoryItem', '2');
  if (state.nodes[item]) return;
  const updatedAt = new Date(time).toISOString();
  state.nodes[gid('Product', '2')] = {
    id: gid('Product', '2'),
    updatedAt,
    title: 'Canvas tote · scenario',
    status: 'ACTIVE',
    vendor: 'Luma Goods',
    publishedAt: null,
    priceRangeV2: { minVariantPrice: { amount: '24.0', currencyCode: 'EUR' } },
  };
  state.nodes[gid('ProductVariant', '2')] = {
    id: gid('ProductVariant', '2'),
    sku: 'LUMA-SCENARIO-001',
    title: 'Default Title',
    price: '24.00',
    barcode: null,
    inventoryItem: { id: item },
  };
  state.nodes[item] = { id: item, tracked: true };
  state.nodes[gid('InventoryLevel', '2')] = {
    id: gid('InventoryLevel', '2'),
    updatedAt,
    location: { id: gid('Location', '2') },
    quantities: [
      { name: 'on_hand', quantity: 100 },
      { name: 'committed', quantity: 0 },
      { name: 'available', quantity: 100 },
    ],
  };
  const product = gid('Product', '2');
  state.roots.products.push(product);
  state.roots.inventoryItems.push(item);
  state.children[product] = { variants: [gid('ProductVariant', '2')] };
  state.children[item] = { inventoryLevels: [gid('InventoryLevel', '2')] };
}

/** Applies merchant changes using Shopify lifecycle and quantity fields. */
export function command(
  state: ShopifyState,
  command: ShopifyCommand,
  time: number,
) {
  if (isReturnCommand(command)) {
    returnCommand(state, command, time);

    return;
  }
  const updatedAt = new Date(time).toISOString();
  const level =
    state.nodes[
      gid('InventoryLevel', command.kind === 'stock' ? command.id : undefined)
    ];
  if (!level) throw new Error('Inventory level not found');
  const quantities = level.quantities as { name: string; quantity: number }[];
  const onHand = quantities.find((q) => q.name === 'on_hand')!;
  const committed = quantities.find((q) => q.name === 'committed')!;
  if (command.kind === 'stock') {
    if (
      !Number.isSafeInteger(command.quantity) ||
      command.quantity < 0 ||
      command.quantity > 2147483647
    )
      throw new Error('Invalid stock');
    onHand.quantity = command.quantity;
  } else {
    const id = gid('Order', command.id);
    const lineId = gid('LineItem', command.id);
    const workId = gid('FulfillmentOrder', command.id);
    if (command.kind === 'order') {
      if (
        !/^[1-9]\d*$/.test(command.id) ||
        state.nodes[id] ||
        !Number.isSafeInteger(command.quantity) ||
        command.quantity < 1
      )
        throw new Error('Invalid or duplicate order');
      state.nodes[id] = {
        id,
        updatedAt,
        createdAt: updatedAt,
        name: `#SIM-${command.id}`,
        cancelledAt: null,
        closed: false,
        displayFinancialStatus: 'PAID',
        currentTotalPriceSet: {
          shopMoney: {
            amount: (command.quantity * unitPrice).toFixed(2),
            currencyCode: 'EUR',
          },
        },
        fulfillments: [],
      };
      state.nodes[lineId] = {
        id: lineId,
        quantity: command.quantity,
        name: 'Canvas tote',
        sku: 'LUMA-001',
        variant: { inventoryItem: { id: gid('InventoryItem') } },
      };
      state.nodes[workId] = { id: workId, updatedAt, status: 'OPEN' };
      const workLine = gid('FulfillmentOrderLineItem', command.id);
      state.nodes[workLine] = {
        id: workLine,
        remainingQuantity: command.quantity,
        totalQuantity: command.quantity,
        lineItem: { id: lineId },
      };
      state.children[id] = { lineItems: [lineId], fulfillmentOrders: [workId] };
      state.children[workId] = { lineItems: [workLine] };
      state.roots.orders.push(id);
      committed.quantity += command.quantity;
    } else {
      const order = state.nodes[id];
      if (!order || order.closed)
        throw new Error('Order missing or already shipped');
      order.closed = true;
      order.updatedAt = updatedAt;
      state.nodes[workId]!.status = 'CLOSED';
      state.nodes[workId]!.updatedAt = updatedAt;
      state.nodes[
        gid('FulfillmentOrderLineItem', command.id)
      ]!.remainingQuantity = 0;
      const shipmentId = gid('Fulfillment', command.id);
      const shipment = {
        id: shipmentId,
        updatedAt,
        status: 'SUCCESS',
        deliveredAt: null,
        inTransitAt: updatedAt,
      };
      state.nodes[shipmentId] = shipment;
      order.fulfillments = [shipment];
      const shipmentLine = gid('FulfillmentLineItem', command.id);
      const quantity = state.nodes[lineId]!.quantity as number;
      state.nodes[shipmentLine] = {
        id: shipmentLine,
        quantity,
        lineItem: { id: lineId },
      };
      state.children[shipmentId] = { fulfillmentLineItems: [shipmentLine] };
      onHand.quantity -= quantity;
      committed.quantity -= quantity;
    }
  }
  quantities.find((q) => q.name === 'available')!.quantity =
    onHand.quantity - committed.quantity;
  level.updatedAt = updatedAt;
}

/**
 * Applies a return step with Shopify's return, reverse fulfillment and refund records.
 * Receiving restocks the units at the order's location.
 */
function returnCommand(
  state: ShopifyState,
  command: ReturnCommand,
  time: number,
) {
  const at = new Date(time).toISOString();
  const orderId = gid('Order', command.id);
  const order = state.nodes[orderId];
  const shipmentLine = state.nodes[gid('FulfillmentLineItem', command.id)];
  if (!order || !shipmentLine) throw new Error('Ship the order first');
  const returnId = gid('Return', command.id);
  const returned = state.nodes[returnId];
  const returnLine = state.nodes[gid('ReturnLineItem', command.id)];
  order.updatedAt = at;
  if (command.kind === 'return') {
    const shipped = shipmentLine.quantity as number;
    if (returned) throw new Error('This order already has a return');
    if (command.quantity < 1 || command.quantity > shipped)
      throw new Error('Return at most the shipped quantity');
    state.nodes[returnId] = {
      id: returnId,
      name: `${order.name as string}-R1`,
      status: 'REQUESTED',
      createdAt: at,
      requestApprovedAt: null,
      closedAt: null,
      decline: null,
    };
    state.nodes[gid('ReturnLineItem', command.id)] = {
      id: gid('ReturnLineItem', command.id),
      quantity: command.quantity,
      refundedQuantity: 0,
      returnReasonDefinition: { name: 'Size too small' },
      fulfillmentLineItem: {
        id: shipmentLine.id,
        lineItem: shipmentLine.lineItem,
      },
      withCodeDiscountedTotalPriceSet: {
        shopMoney: {
          amount: (command.quantity * unitPrice).toFixed(2),
          currencyCode: 'EUR',
        },
      },
    };
    state.children[orderId] = {
      ...state.children[orderId],
      returns: [returnId],
    };
    state.children[returnId] = {
      returnLineItems: [gid('ReturnLineItem', command.id)],
      reverseFulfillmentOrders: [],
    };

    return;
  }
  if (!returned || !returnLine) throw new Error('Request a return first');
  const quantity = returnLine.quantity as number;
  if (command.kind === 'return-approve') {
    if (returned.status !== 'REQUESTED')
      throw new Error('Only a requested return can be approved');
    returned.status = 'OPEN';
    returned.requestApprovedAt = at;
    const reverseId = gid('ReverseFulfillmentOrder', command.id);
    const reverseLine = gid('ReverseFulfillmentOrderLineItem', command.id);
    state.nodes[reverseId] = { id: reverseId, status: 'OPEN' };
    state.nodes[reverseLine] = {
      id: reverseLine,
      totalQuantity: quantity,
      fulfillmentLineItem: { id: shipmentLine.id },
      dispositions: [],
    };
    state.children[returnId]!.reverseFulfillmentOrders = [reverseId];
    state.children[reverseId] = { lineItems: [reverseLine] };
  } else if (command.kind === 'return-decline') {
    if (returned.status !== 'REQUESTED')
      throw new Error('Only a requested return can be declined');
    returned.status = 'DECLINED';
    returned.decline = { reason: 'RETURN_PERIOD_ENDED' };
    returned.closedAt = at;
  } else if (command.kind === 'return-receive') {
    const reverseLine =
      state.nodes[gid('ReverseFulfillmentOrderLineItem', command.id)];
    if (returned.status !== 'OPEN' || !reverseLine)
      throw new Error('Approve the return first');
    const dispositions = reverseLine.dispositions as unknown[];
    if (dispositions.length) throw new Error('Items were already received');
    dispositions.push({
      id: gid('ReverseFulfillmentOrderDisposition', command.id),
      type: 'RESTOCKED',
      quantity,
      createdAt: at,
    });
    state.nodes[gid('ReverseFulfillmentOrder', command.id)]!.status = 'CLOSED';
    const level = state.nodes[gid('InventoryLevel')]!;
    const values = level.quantities as { name: string; quantity: number }[];
    for (const name of ['on_hand', 'available'])
      values.find((value) => value.name === name)!.quantity += quantity;
    level.updatedAt = at;
  } else if (command.kind === 'return-close') {
    if (returned.status !== 'OPEN')
      throw new Error('Only an open return can be closed');
    returned.status = 'CLOSED';
    returned.closedAt = at;
  } else if (command.kind === 'refund') {
    if (returned.status === 'DECLINED' || returned.status === 'REQUESTED')
      throw new Error('Approve the return before refunding it');
    const refunds = (order.refunds ??= []) as Node[];
    const refundId = gid('Refund', `${command.id}0${refunds.length + 1}`);
    const amount = (quantity * unitPrice).toFixed(2);
    const status = {
      success: 'SUCCESS',
      pending: 'PENDING',
      failure: 'FAILURE',
    }[command.outcome];
    const refund = {
      id: refundId,
      createdAt: at,
      updatedAt: at,
      totalRefundedSet: {
        shopMoney: {
          amount: command.outcome === 'success' ? amount : '0.00',
          currencyCode: 'EUR',
        },
      },
      return: { id: returnId },
    };
    refunds.push(refund);
    state.nodes[refundId] = refund;
    const refundLine = gid('RefundLineItem', `${command.id}0${refunds.length}`);
    const transaction = gid(
      'OrderTransaction',
      `${command.id}0${refunds.length}`,
    );
    state.nodes[refundLine] = {
      id: refundLine,
      quantity,
      restockType: 'RETURN',
      restocked: false,
      lineItem: shipmentLine.lineItem,
    };
    state.nodes[transaction] = {
      id: transaction,
      kind: 'REFUND',
      status,
      processedAt: command.outcome === 'pending' ? null : at,
      gateway: 'shopify_payments',
      amountSet: { shopMoney: { amount, currencyCode: 'EUR' } },
    };
    state.children[refundId] = {
      refundLineItems: [refundLine],
      transactions: [transaction],
    };
    if (command.outcome !== 'failure') {
      returnLine.refundedQuantity = quantity;
      if (command.outcome === 'success')
        order.displayFinancialStatus = 'REFUNDED';
    }
  } else {
    const pending = ((order.refunds ?? []) as Node[])
      .flatMap((refund) => state.children[refund.id]?.transactions ?? [])
      .map((id) => state.nodes[id]!)
      .find((transaction) => transaction.status === 'PENDING');
    if (!pending) throw new Error('No refund payment is pending');
    pending.status = 'SUCCESS';
    pending.processedAt = at;
    order.displayFinancialStatus = 'REFUNDED';
  }
}

/** Identifies supported read operations and optional node targets. */
export function identify(request: ProviderRequest) {
  const body = JSON.parse(request.body ?? '{}') as {
    query?: string;
    variables?: {
      id?: string;
      input?: { quantities?: { inventoryItemId?: string }[] };
    };
  };
  const query = body.query ?? '';
  const resource =
    body.variables?.id ??
    body.variables?.input?.quantities?.[0]?.inventoryItemId;

  return {
    operation: query.includes('inventorySetQuantities')
      ? 'inventory.available.reconcile'
      : /returns\(|refunds|on Return|on Refund|ReverseFulfillmentOrder/.test(
            query,
          )
        ? 'returns.read'
        : /fulfillment|Fulfillment/.test(query)
          ? 'fulfillment.read'
          : /on Product|page:\s*products/.test(query)
            ? 'products.read'
            : /on InventoryItem|page:\s*inventoryItems/.test(query)
              ? 'inventory.read'
              : 'orders.read',
    ...(resource ? { resource } : {}),
  };
}

/** Handles named reads and idempotent inventory CAS; uses the supplied simulator clock for writes. */
export function handle(
  state: ShopifyState,
  request: ProviderRequest,
  time = Date.now(),
) {
  if (
    request.method !== 'POST' ||
    !new URL(request.url).pathname.endsWith('/admin/api/2026-07/graphql.json')
  )
    return json({}, 404);
  if (!request.headers['x-shopify-access-token']) return json({}, 401);
  const { query = '', variables = {} } = JSON.parse(request.body ?? '{}') as {
    query?: string;
    variables?: {
      id?: string;
      first?: number;
      after?: string | null;
      locationId?: string;
      key?: string;
      input?: {
        name?: string;
        reason?: string;
        referenceDocumentUri?: string;
        quantities?: {
          inventoryItemId?: string;
          locationId?: string;
          changeFromQuantity?: number;
          quantity?: number;
        }[];
      };
    };
  };
  const result = (data: unknown) => ({
    ...json({ data }),
    headers: {
      'content-type': 'application/json',
      'x-shopify-api-version': '2026-07',
    },
  });
  const currentAppInstallation = {
    accessScopes: [
      'orders',
      'products',
      'inventory',
      'merchant_managed_fulfillment_orders',
      'returns',
    ]
      .map((s) => ({ handle: `read_${s}` }))
      .concat([{ handle: 'write_inventory' }]),
  };
  if (query.includes('VerifyInstallation'))
    return result({
      shop: { myshopifyDomain: new URL(request.url).hostname },
      currentAppInstallation,
    });
  // Scans start by reading granted scopes and, for counted collections, the collection size.
  if (query.includes('LumaScanStart')) {
    const counted = /count:\s*(orders|products|customers)Count\(/.exec(
      query,
    )?.[1];

    return result({
      currentAppInstallation,
      ...(counted
        ? {
            count: {
              count:
                counted === 'customers'
                  ? 0
                  : state.roots[counted as keyof ShopifyState['roots']].length,
              precision: 'EXACT',
            },
          }
        : {}),
    });
  }
  const page = (ids: string[], size: number) => {
    const offset = variables.after ? Number(variables.after) : 0;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > 250
    )
      throw new Error('Invalid cursor or page size');
    const selected = ids.slice(offset, offset + size);

    return {
      nodes: selected.map((id) => state.nodes[id]),
      pageInfo: {
        hasNextPage: offset + size < ids.length,
        endCursor: selected.length ? String(offset + selected.length) : null,
      },
    };
  };
  if (query.includes('LumaPage')) {
    const root = /page:\s*(orders|products|inventoryItems)\(/.exec(
      query,
    )?.[1] as keyof ShopifyState['roots'] | undefined;

    if (!root) return json({ errors: [{ message: 'Unsupported query' }] }, 400);
    const selected = page(state.roots[root], variables.first ?? 100);
    // Order pages for returns report whether each order has returns or refunds.
    if (root === 'orders' && query.includes('returns(first'))
      selected.nodes = selected.nodes.map((order) => ({
        ...order!,
        returns: {
          nodes: (state.children[order!.id]?.returns ?? []).map((id) => ({
            id,
          })),
        },
        refunds: (order!.refunds as Node[] | undefined) ?? [],
      }));

    return result({ page: selected });
  }
  if (query.includes('LumaInventoryCorrection')) {
    const error = (code: string) =>
      result({
        result: {
          inventoryAdjustmentGroup: null,
          userErrors: [
            {
              code,
              field: ['quantities'],
              message: 'Stock correction refused',
            },
          ],
        },
      });
    if (query.startsWith('mutation')) {
      const input = variables.input,
        quantity = input?.quantities?.[0],
        key = variables.key;
      if (
        !key ||
        input?.name !== 'available' ||
        input.reason !== 'correction' ||
        input.quantities?.length !== 1 ||
        !quantity?.inventoryItemId ||
        !quantity.locationId ||
        !Number.isInteger(quantity.changeFromQuantity) ||
        !Number.isInteger(quantity.quantity) ||
        quantity.quantity === undefined ||
        quantity.quantity < 0
      )
        return error('INVALID_QUANTITY');
      const previous = state.inventoryCorrections?.[key];
      const serialized = JSON.stringify(input);
      if (previous)
        return previous.input === serialized
          ? result(previous.receipt)
          : error('IDEMPOTENCY_KEY_CONFLICT');
      const item = state.nodes[quantity.inventoryItemId];
      const levels =
        state.children[quantity.inventoryItemId]?.inventoryLevels ?? [];
      const level = levels
        .map((id) => state.nodes[id]!)
        .find(
          (node) =>
            (node.location as { id: string }).id === quantity.locationId,
        );
      if (!item?.tracked || !level)
        return error('ITEM_NOT_STOCKED_AT_LOCATION');
      const values = level.quantities as { name: string; quantity: number }[];
      const available = values.find((value) => value.name === 'available');
      if (!available || available.quantity !== quantity.changeFromQuantity)
        return error('CHANGE_FROM_QUANTITY_STALE');
      const delta = quantity.quantity - available.quantity;
      available.quantity = quantity.quantity;
      const onHand = values.find((value) => value.name === 'on_hand');
      if (onHand) onHand.quantity += delta;
      level.updatedAt = new Date(time).toISOString();
      const receipt = {
        result: {
          inventoryAdjustmentGroup: {
            reason: 'correction',
            referenceDocumentUri: input.referenceDocumentUri ?? null,
            changes: [
              {
                name: 'available',
                delta,
                quantityAfterChange: available.quantity,
              },
            ],
          },
          userErrors: [],
        },
      };
      state.inventoryCorrections ??= {};
      state.inventoryCorrections[key] = { input: serialized, receipt };

      return { ...result(receipt), committed: true };
    }
    const item = variables.id ? state.nodes[variables.id] : undefined;
    const levels = variables.id
      ? (state.children[variables.id]?.inventoryLevels ?? [])
      : [];
    const level = levels
      .map((id) => state.nodes[id]!)
      .find(
        (node) => (node.location as { id: string }).id === variables.locationId,
      );

    return result({
      node: item
        ? {
            ...item,
            inventoryLevel: level
              ? {
                  ...level,
                  location: {
                    id: variables.locationId,
                    name: 'Simulator warehouse',
                    isActive: true,
                  },
                  quantities: (
                    level.quantities as { name: string; quantity: number }[]
                  ).filter((value) => value.name === 'available'),
                }
              : null,
          }
        : null,
    });
  }
  const node = variables.id ? state.nodes[variables.id] : undefined;
  if (!node) return result({ node: null });
  if (query.includes('LumaChildren')) {
    const field = /children:\s*(\w+)\(/.exec(query)?.[1];
    const ids = field ? state.children[node.id]?.[field] : undefined;

    return ids
      ? result({ node: { children: page(ids, 100) } })
      : json({ errors: [{ message: 'Unsupported field' }] }, 400);
  }
  if (query.includes('LumaNode'))
    return result({
      node:
        node.id.startsWith('gid://shopify/Order/') && query.includes('refunds')
          ? { ...node, refunds: node.refunds ?? [] }
          : node,
    });

  return json({ errors: [{ message: 'Unsupported query' }] }, 400);
}
