import {
  json,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderTarget,
  type RateLimit,
  type RecordQuery,
  type StoredRecord,
} from '@luma/simulator-core';

import { customerJson } from './customers.js';
import {
  changeShippingMethod,
  noteJson,
  noteLinesJson,
  orderLinesJson,
  salesOrderDetailJson,
  salesOrderJson,
} from './orders.js';
import { revisePurchaseOrder } from './purchase-order-changes.js';
import {
  assignmentJson,
  isDate,
  purchaseOrderJson,
  purchaseOrderRowJson,
  submitPurchaseOrder,
  supplierJson,
  supplierRowJson,
} from './purchasing.js';
import {
  ACTIVE,
  type AssignmentRecord,
  configId,
  type CustomerRecord,
  type ItemRecord,
  type JtlContext,
  JtlError,
  kinds,
  type NoteRecord,
  type OrderRecord,
  type PurchaseOrderRecord,
  recordId,
  type ReturnRecord,
  type SupplierRecord,
} from './records.js';
import {
  createReturn,
  returnJson,
  returnLinesJson,
  returnReasonsJson,
} from './returns.js';
import { itemJson, loadItems, saveStock } from './stock.js';

const roots = new Set([
  'sales-orders',
  'items',
  'warehouses',
  'delivery-notes',
  'shipping-methods',
  'suppliers',
  'customers',
  'purchase-orders',
  'returns',
  'return-reasons',
  'stocks',
]);

const MAX_PAGE_SIZE = 1000;

const DEFAULT_PAGE_SIZE = 100;

/** Splits the resource path after the API root, such as `["sales-orders", "4", "line-items"]`. */
function resourcePath(url: string) {
  const segments = new URL(url).pathname.split('/').filter(Boolean);
  const start = segments.findIndex((segment) => roots.has(segment));

  return start < 0 ? undefined : segments.slice(start);
}

/** Builds an RFC 9457 problem response like the ERP API's error answers. */
function problem(status: number, title: string): ProviderResponse {
  return {
    status,
    headers: { 'content-type': 'application/problem+json' },
    body: { type: `https://httpstatuses.io/${status}`, title, status },
  };
}

/**
 * Names a JTL request for fault targeting and the journal. Products and inventory share
 * `items.read`; the resource is the numeric record the path addresses, the item for warehouse
 * stock.
 */
export function identify(request: ProviderRequest): ProviderTarget {
  const write = request.method !== 'GET' && request.method !== 'HEAD';
  const path = resourcePath(request.url) ?? [];
  const [root, id, child, nested] = path;
  const resource = root === 'warehouses' ? nested : id;
  const operation =
    root === 'stocks'
      ? write
        ? 'returns.restock'
        : id === 'reservations'
          ? 'returns.exchange.reservation.read'
          : 'returns.settlement.proof.read'
      : root === 'sales-orders'
        ? request.method === 'PATCH'
          ? 'orders.shipping-method.write'
          : id && !child
            ? 'orders.shipping-method.read'
            : 'orders.read'
        : root === 'delivery-notes'
          ? 'fulfillment.read'
          : root === 'items' || root === 'warehouses'
            ? 'items.read'
            : root === 'shipping-methods'
              ? 'orders.read'
              : root === 'suppliers'
                ? 'suppliers.read'
                : root === 'customers'
                  ? 'customers.read'
                  : root === 'purchase-orders'
                    ? write
                      ? id
                        ? 'purchase-orders.revise'
                        : 'purchase-orders.submit'
                      : 'purchase-orders.read'
                    : root === 'returns'
                      ? write
                        ? 'returns.create'
                        : 'returns.created.read'
                      : root === 'return-reasons'
                        ? 'returns.options.read'
                        : 'unknown';

  return { operation, resource, write };
}

/** The ERP API's answer to a request with missing or rejected credentials. */
export function unauthorized(): ProviderResponse {
  const response = problem(401, 'Unauthorized');

  return {
    ...response,
    headers: { ...response.headers, 'www-authenticate': 'Wawi' },
  };
}

const pascal = (value: unknown) =>
  typeof value === 'object' && value !== null
    ? Object.fromEntries(
        Object.entries(value).map(([key, field]) => [
          key.charAt(0).toUpperCase() + key.slice(1),
          field,
        ]),
      )
    : value;

/**
 * Answers in the PascalCase field names of an older ERP API version, wrapping plain arrays in an
 * `Items` envelope. No successful JTL response then satisfies the adapter's schemas.
 */
export function drift(response: ProviderResponse): ProviderResponse {
  if (response.status < 200 || response.status > 299) return response;
  const body = Array.isArray(response.body)
    ? { Items: response.body.map(pascal) }
    : pascal(response.body);

  return { ...response, body };
}

/** JTL's per-client request budget: 60 requests, restored at 20 per second. */
export const rateLimit: RateLimit = {
  capacity: 60,
  restorePerSecond: 20,
  cost: () => 1,
  reject(cost, available) {
    const response = problem(429, 'Too Many Requests');
    const seconds = Math.max(1, Math.ceil((cost - available) / 20));

    return {
      ...response,
      headers: { ...response.headers, 'retry-after': String(seconds) },
    };
  },
};

/** Accepts on-premise `Wawi` keys with registered app headers and cloud bearer tokens. */
function authenticated(headers: Record<string, string>) {
  const authorization = headers.authorization ?? '';
  if (/^Wawi \S+/.test(authorization))
    return Boolean(headers['x-appid'] && headers['x-appversion']);

  return /^Bearer \S+/.test(authorization) && Boolean(headers['x-tenant-id']);
}

interface PageRequest {
  number: number;
  size: number;
}

function pageRequest(url: URL): PageRequest | undefined {
  const read = (name: string, fallback: number) => {
    const raw = url.searchParams.get(name);
    if (raw === null) return fallback;

    return /^[1-9]\d{0,9}$/.test(raw) && Number(raw) <= 2147483647
      ? Number(raw)
      : Number.NaN;
  };
  const number = read('pageNumber', 1);
  const size = read('pageSize', DEFAULT_PAGE_SIZE);

  return Number.isNaN(number) || Number.isNaN(size) || size > MAX_PAGE_SIZE
    ? undefined
    : { number, size };
}

/** Wraps one page of rows in the ERP API's page envelope. */
function envelope(items: unknown[], page: PageRequest, total: number) {
  const hasNextPage = page.number * page.size < total;

  return json({
    items,
    pageNumber: page.number,
    pageSize: page.size,
    totalItems: total,
    totalPages: Math.ceil(total / page.size),
    hasPreviousPage: page.number > 1,
    hasNextPage,
    nextPageNumber: hasNextPage ? page.number + 1 : page.number,
    previousPageNumber: Math.max(1, page.number - 1),
  });
}

/** Pages stored records by offset in creation order; `totalItems` is the current count. */
async function storedPage<T>(
  context: JtlContext,
  page: PageRequest,
  query: Omit<RecordQuery, 'after' | 'offset' | 'limit'>,
  rows: (records: StoredRecord<T>[]) => Promise<unknown[]> | unknown[],
) {
  const records = await context.store.page<T>({
    ...query,
    offset: (page.number - 1) * page.size,
    limit: page.size,
  });
  const total = await context.store.count(query);

  return envelope(await rows(records.items), page, total);
}

/** Pages rows held in memory, such as configuration or a record's nested lines. */
const memoryPage = (rows: unknown[], page: PageRequest) =>
  envelope(
    rows.slice((page.number - 1) * page.size, page.number * page.size),
    page,
    rows.length,
  );

async function supplierNames(context: JtlContext, ids: readonly string[]) {
  const records = await context.store.getMany<SupplierRecord>(kinds.supplier, [
    ...new Set(ids),
  ]);

  return new Map(records.map((record) => [record.id, record.data.companyName]));
}

async function detail<T>(context: JtlContext, kind: string, raw: string) {
  const id = recordId(raw);
  const record = id ? await context.store.get<T>(kind, id) : undefined;
  if (!record) throw new JtlError(404, 'Not Found');

  return record.data;
}

function body(request: ProviderRequest): unknown {
  try {
    return JSON.parse(request.body ?? '');
  } catch {
    throw new JtlError(400, 'Invalid request body');
  }
}

async function salesOrders(
  context: JtlContext,
  request: ProviderRequest,
  page: PageRequest,
  [id, child, ...rest]: string[],
) {
  if (request.method === 'PATCH' && id && !child) {
    const input = body(request);
    const method = recordId(
      typeof input === 'object' && input !== null && 'shippingMethodId' in input
        ? input.shippingMethodId
        : undefined,
    );
    await detail(context, kinds.order, id);
    if (!method) throw new JtlError(400, 'Invalid shipping method');
    await changeShippingMethod(context, id, method);

    return { ...json({ salesOrderId: Number(id) }), committed: true };
  }
  if (request.method !== 'GET' || rest.length) return undefined;
  if (!id)
    return storedPage<OrderRecord>(
      context,
      page,
      { kind: kinds.order },
      (rows) => rows.map((row) => salesOrderJson(row.data)),
    );
  const order = await detail<OrderRecord>(context, kinds.order, id);
  if (!child) return json(salesOrderDetailJson(order));

  return child === 'line-items' ? json(orderLinesJson(order)) : undefined;
}

async function items(
  context: JtlContext,
  page: PageRequest,
  [id, child, ...rest]: string[],
) {
  if (rest.length) return undefined;
  if (!id)
    return storedPage<ItemRecord>(context, page, { kind: kinds.item }, (rows) =>
      rows.map((row) => itemJson(row.data)),
    );
  const item = await detail<ItemRecord>(context, kinds.item, id);
  if (!child) return json(itemJson(item));
  if (child !== 'suppliers') return undefined;

  return storedPage<AssignmentRecord>(
    context,
    page,
    { kind: kinds.assignment, parent: item.id },
    async (rows) => {
      const names = await supplierNames(
        context,
        rows.map((row) => row.data.supplierId),
      );

      return rows.map((row) =>
        assignmentJson(row.data, names.get(row.data.supplierId) ?? null),
      );
    },
  );
}

async function warehouses(
  context: JtlContext,
  page: PageRequest,
  [id, child, itemId, leaf, ...rest]: string[],
) {
  if (!id)
    return memoryPage(
      context.config.warehouses.map((w) => ({
        id: configId(w.id),
        name: w.name,
        active: true,
      })),
      page,
    );
  if (!child) {
    const w = context.config.warehouses.find((w) => w.id === id);
    if (!w) throw new JtlError(404, 'Not Found');

    return json({ id: configId(w.id), name: w.name, active: true });
  }
  if (child !== 'items' || !itemId || leaf !== 'stocks' || rest.length)
    return undefined;
  if (!context.config.warehouses.some((w) => w.id === id))
    throw new JtlError(404, 'Not Found');
  const item = await detail<ItemRecord>(context, kinds.item, itemId);

  return json({
    itemId: Number(item.id),
    warehouseId: configId(id),
    totalQuantity: item.stock[id] ?? 0,
    lockedQuantity: 0,
  });
}

async function deliveryNotes(
  context: JtlContext,
  url: URL,
  page: PageRequest,
  [id, child, ...rest]: string[],
) {
  if (rest.length) return undefined;
  if (!id) {
    const filter = url.searchParams.get('salesOrderNumberId');
    const orderId = filter === null ? undefined : recordId(filter);
    if (filter !== null && !orderId)
      throw new JtlError(400, 'Invalid salesOrderNumberId');

    return storedPage<NoteRecord>(
      context,
      page,
      { kind: kinds.note, ...(orderId ? { parent: orderId } : {}) },
      (rows) => rows.map((row) => noteJson(row.data)),
    );
  }
  const note = await detail<NoteRecord>(context, kinds.note, id);
  if (!child) return json(noteJson(note));

  return child === 'line-items'
    ? memoryPage(noteLinesJson(note), page)
    : undefined;
}

async function suppliers(
  context: JtlContext,
  page: PageRequest,
  [id, ...rest]: string[],
) {
  if (rest.length) return undefined;
  if (!id)
    return storedPage<SupplierRecord>(
      context,
      page,
      { kind: kinds.supplier, key: ACTIVE },
      (rows) => rows.map((row) => supplierRowJson(row.data)),
    );

  return json(
    supplierJson(await detail<SupplierRecord>(context, kinds.supplier, id)),
  );
}

async function customers(
  context: JtlContext,
  url: URL,
  page: PageRequest,
  path: string[],
) {
  if (path.length) return undefined;
  const after = url.searchParams.get('lastChangedAfter');
  if (after !== null && !isDate(after))
    throw new JtlError(400, 'Invalid date filter');

  return storedPage<CustomerRecord>(
    context,
    page,
    {
      kind: kinds.customer,
      // `lastChangedAfter` is exclusive; modification times are whole milliseconds.
      ...(after === null ? {} : { updatedFrom: Date.parse(after) + 1 }),
    },
    (rows) => rows.map((row) => customerJson(row.data)),
  );
}

async function purchaseOrders(
  context: JtlContext,
  request: ProviderRequest,
  url: URL,
  page: PageRequest,
  [id, child, lineId, ...rest]: string[],
) {
  if (
    id &&
    child === 'line-items' &&
    !rest.length &&
    ['PATCH', 'POST', 'DELETE'].includes(request.method)
  ) {
    const method = request.method;
    if (method !== 'PATCH' && method !== 'POST' && method !== 'DELETE')
      return undefined;
    const order = await revisePurchaseOrder(
      context,
      id,
      method,
      lineId,
      body(request),
    );
    const names = await supplierNames(context, [order.supplierId]);

    return {
      ...json(purchaseOrderJson(order, names.get(order.supplierId) ?? null)),
      committed: true,
    };
  }
  if (child || lineId || rest.length) return undefined;
  if (request.method === 'POST' && !id) {
    const result = await submitPurchaseOrder(
      context,
      body(request),
      request.headers['idempotency-key'],
    );

    return {
      ...json({ purchaseOrderId: Number(result.id) }, 201),
      ...(result.created ? { committed: true } : {}),
    };
  }
  if (request.method !== 'GET') return undefined;
  if (id) {
    const order = await detail<PurchaseOrderRecord>(
      context,
      kinds.purchaseOrder,
      id,
    );
    const names = await supplierNames(context, [order.supplierId]);

    return json(purchaseOrderJson(order, names.get(order.supplierId) ?? null));
  }
  const after = url.searchParams.get('createdAtAfter');
  const before = url.searchParams.get('createdAtBefore');
  if (
    (after !== null && !isDate(after)) ||
    (before !== null && !isDate(before))
  )
    throw new JtlError(400, 'Invalid date filter');

  return storedPage<PurchaseOrderRecord>(
    context,
    page,
    {
      kind: kinds.purchaseOrder,
      // `createdAtAfter` is exclusive; creation times are whole milliseconds.
      ...(after === null ? {} : { createdFrom: Date.parse(after) + 1 }),
      ...(before === null ? {} : { createdBefore: Date.parse(before) }),
    },
    async (rows) => {
      const names = await supplierNames(
        context,
        rows.map((row) => row.data.supplierId),
      );

      return rows.map((row) =>
        purchaseOrderRowJson(row.data, names.get(row.data.supplierId) ?? null),
      );
    },
  );
}

async function returns(
  context: JtlContext,
  request: ProviderRequest,
  url: URL,
  page: PageRequest,
  [id, child, ...rest]: string[],
) {
  if (rest.length) return undefined;
  if (request.method === 'POST' && !id) {
    const result = await createReturn(
      context,
      body(request),
      request.headers['idempotency-key'],
    );

    return {
      ...json(returnJson(result.record), 201),
      ...(result.created ? { committed: true } : {}),
    };
  }
  if (request.method !== 'GET') return undefined;
  if (id) {
    const record = await detail<ReturnRecord>(context, kinds.return, id);
    if (!child) return json(returnJson(record));

    return child === 'line-items' ? json(returnLinesJson(record)) : undefined;
  }
  const filter = url.searchParams.get('salesOrderId');
  const orderId = filter === null ? undefined : recordId(filter);
  if (filter !== null && !orderId)
    throw new JtlError(400, 'Invalid salesOrderId');

  return storedPage<ReturnRecord>(
    context,
    page,
    { kind: kinds.return, ...(orderId ? { parent: orderId } : {}) },
    (rows) => rows.map((row) => returnJson(row.data)),
  );
}

interface StockChange {
  itemId: string;
  warehouseId: string;
  quantity: number;
  changedDate: string;
  comment: string | null;
}

/** ERP stock POST has no native idempotency; each request records one physical addition. */
async function stocks(
  context: JtlContext,
  request: ProviderRequest,
  url: URL,
  page: PageRequest,
  path: string[],
) {
  if (request.method === 'POST' && !path.length) {
    const input = body(request);
    if (
      !input ||
      typeof input !== 'object' ||
      !('itemId' in input) ||
      !('warehouseId' in input) ||
      !('quantity' in input)
    )
      throw new JtlError(400, 'Invalid stock input');
    const itemId = String(input.itemId),
      warehouseId = String(input.warehouseId),
      quantity = input.quantity;
    if (
      typeof quantity !== 'number' ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      !context.config.warehouses.some((w) => w.id === warehouseId)
    )
      throw new JtlError(400, 'Invalid stock quantity or warehouse');
    const item = (await loadItems(context, [itemId])).get(itemId)!;
    const comment =
      'comment' in input && typeof input.comment === 'string'
        ? input.comment
        : null;
    item.stock[warehouseId] = (item.stock[warehouseId] ?? 0) + quantity;
    const id = String(await context.store.sequence('stock-change', 1));
    await saveStock(context, [item]);
    await context.store.put<StockChange>(
      'stock-change',
      id,
      {
        itemId,
        warehouseId,
        quantity,
        changedDate: new Date(context.now).toISOString(),
        comment,
      },
      { parent: itemId, updatedAt: context.now },
    );

    return {
      ...json(
        {
          itemId: configId(itemId),
          warehouseId: configId(warehouseId),
          storageLocationId: null,
          storageLocationName: null,
          shelfLifeExpirationDate: null,
          batchNumber: null,
          quantityTotal: item.stock[warehouseId],
          quantityLockedForShipment: 0,
          quantityLockedForAvailability: 0,
          quantityInPickingLists: 0,
        },
        201,
      ),
      committed: true,
    };
  }
  if (
    request.method === 'GET' &&
    path.length === 1 &&
    path[0] === 'reservations'
  ) {
    const rows = [];
    const count = await context.store.count({ kind: kinds.order });
    if (count > 10_000) throw new JtlError(503, 'Reservation scan unavailable');
    for (let offset = 0; offset < count; offset += 1000)
      for (const record of (
        await context.store.page<OrderRecord>({
          kind: kinds.order,
          offset,
          limit: 1000,
        })
      ).items) {
        if (record.data.cancelled) continue;
        for (const line of record.data.lines)
          if (line.quantity > line.shipped)
            rows.push({
              itemId: configId(line.itemId),
              salesOrderId: configId(record.data.id),
              customerId: record.data.customerId
                ? configId(record.data.customerId)
                : 0,
              amount: line.quantity - line.shipped,
              createdAt: record.data.date,
              platform: 'Luma simulator',
            });
      }

    return memoryPage(rows, page);
  }
  if (request.method === 'GET' && path.length === 1 && path[0] === 'changes') {
    const itemId = url.searchParams.get('itemId');

    return storedPage<StockChange>(
      context,
      page,
      { kind: 'stock-change', ...(itemId ? { parent: itemId } : {}) },
      (rows) =>
        rows.map(({ data }) => ({
          ...data,
          itemId: configId(data.itemId),
          warehouseId: configId(data.warehouseId),
          storageLocationId: null,
          shelfLifeExpirationDate: null,
          batchNumber: null,
          username: 'simulator',
        })),
    );
  }

  return undefined;
}

async function route(context: JtlContext, request: ProviderRequest) {
  const url = new URL(request.url);
  const [root, ...path] = resourcePath(request.url) ?? [];
  const page = pageRequest(url);
  if (!page) throw new JtlError(400, 'Invalid page parameters');
  if (root === 'stocks') return stocks(context, request, url, page, path);
  if (root === 'sales-orders') return salesOrders(context, request, page, path);
  if (root === 'purchase-orders')
    return purchaseOrders(context, request, url, page, path);
  if (root === 'returns') return returns(context, request, url, page, path);
  if (request.method !== 'GET') return undefined;
  if (root === 'items') return items(context, page, path);
  if (root === 'warehouses') return warehouses(context, page, path);
  if (root === 'delivery-notes') return deliveryNotes(context, url, page, path);
  if (root === 'suppliers') return suppliers(context, page, path);
  if (root === 'customers') return customers(context, url, page, path);
  if (root === 'return-reasons' && !path.length)
    return json(returnReasonsJson(context));
  if (root === 'shipping-methods' && !path.length)
    return memoryPage(
      context.config.shippingMethods.map((m) => ({
        id: configId(m.id),
        name: m.name,
      })),
      page,
    );

  return undefined;
}

/**
 * Serves the ERP API 2.2 surface the Luma JTL adapter uses. Lists page by `pageNumber` and
 * `pageSize` (at most 1000) in creation order, so records created while a client pages shift
 * later pages. Writes report `committed` when they changed provider records.
 */
export async function handle(
  context: JtlContext,
  request: ProviderRequest,
): Promise<ProviderResponse> {
  if (!authenticated(request.headers)) return unauthorized();
  try {
    return (await route(context, request)) ?? problem(404, 'Not Found');
  } catch (error) {
    if (error instanceof JtlError) return problem(error.status, error.message);
    throw error;
  }
}
