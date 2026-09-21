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
}

export type ShopifyCommand =
  | { kind: 'order'; id: string; quantity: number }
  | { kind: 'stock'; quantity: number }
  | { kind: 'ship'; id: string };
const gid = (type: string, id = '1') => `gid://shopify/${type}/${id}`;

/** Seeds Shopify's own resource graph, independently of normalized observations. */
export function seed(time: number): ShopifyState {
  const updatedAt = new Date(time).toISOString();
  const nodes: Node[] = [
    { id: gid('Product'), updatedAt, title: 'Canvas tote', status: 'ACTIVE' },
    {
      id: gid('ProductVariant'),
      sku: 'LUMA-001',
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

/** Applies merchant changes using Shopify lifecycle and quantity fields. */
export function command(
  state: ShopifyState,
  command: ShopifyCommand,
  time: number,
) {
  const updatedAt = new Date(time).toISOString();
  const level = state.nodes[gid('InventoryLevel')]!;
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
        name: `#SIM-${command.id}`,
        cancelledAt: null,
        closed: false,
        displayFinancialStatus: 'PAID',
        fulfillments: [],
      };
      state.nodes[lineId] = {
        id: lineId,
        quantity: command.quantity,
        variant: { inventoryItem: { id: gid('InventoryItem') } },
      };
      state.nodes[workId] = { id: workId, updatedAt, status: 'OPEN' };
      const workLine = gid('FulfillmentOrderLineItem', command.id);
      state.nodes[workLine] = {
        id: workLine,
        remainingQuantity: command.quantity,
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

/** Identifies supported read operations and optional node targets. */
export function identify(request: ProviderRequest) {
  const body = JSON.parse(request.body ?? '{}') as {
    query?: string;
    variables?: { id?: string };
  };
  const query = body.query ?? '';

  return {
    operation: /fulfillment|Fulfillment/.test(query)
      ? 'fulfillment.read'
      : /on Product|page:\s*products/.test(query)
        ? 'products.read'
        : /on InventoryItem|page:\s*inventoryItems/.test(query)
          ? 'inventory.read'
          : 'orders.read',
    ...(body.variables?.id ? { resource: body.variables.id } : {}),
  };
}

/** Handles the connector's named GraphQL read queries and nested cursor pagination. */
export function handle(state: ShopifyState, request: ProviderRequest) {
  if (
    request.method !== 'POST' ||
    !new URL(request.url).pathname.endsWith('/admin/api/2026-07/graphql.json')
  )
    return json({}, 404);
  if (!request.headers['x-shopify-access-token']) return json({}, 401);
  const { query = '', variables = {} } = JSON.parse(request.body ?? '{}') as {
    query?: string;
    variables?: { id?: string; first?: number; after?: string | null };
  };
  const result = (data: unknown) => ({
    ...json({ data }),
    headers: {
      'content-type': 'application/json',
      'x-shopify-api-version': '2026-07',
    },
  });
  if (query.includes('VerifyInstallation'))
    return result({
      shop: { myshopifyDomain: new URL(request.url).hostname },
      currentAppInstallation: {
        accessScopes: [
          'orders',
          'products',
          'inventory',
          'merchant_managed_fulfillment_orders',
        ].map((s) => ({ handle: `read_${s}` })),
      },
    });
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

    return root
      ? result({ page: page(state.roots[root], variables.first ?? 100) })
      : json({ errors: [{ message: 'Unsupported query' }] }, 400);
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
  if (query.includes('LumaNode')) return result({ node });

  return json({ errors: [{ message: 'Unsupported query' }] }, 400);
}
