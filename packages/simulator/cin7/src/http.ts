import {
  json,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderTarget,
  type RateLimit,
  type RecordQuery,
  type StoredRecord,
} from '@luma/simulator-core';

import {
  allocation,
  type Cin7Context,
  cin7Time,
  type ErpCustomer as CustomerRecord,
  type ErpItem as ItemRecord,
  type ErpModel,
  type ErpNote as NoteRecord,
  type ErpOrder as OrderRecord,
  type ErpPurchaseOrder as PurchaseOrderRecord,
  type ErpSupplier as SupplierRecord,
  guid,
  type GuidKind,
  recordOf,
  shipped,
} from './model.js';

type Kinds = ErpModel<unknown, unknown>['kinds'];

const MAX_LIMIT = 1000;

const operations: Record<string, string> = {
  me: 'account.read',
  salelist: 'sales.read',
  sale: 'sales.read',
  salecreditnotelist: 'returns.read',
  product: 'products.read',
  'ref/productavailability': 'inventory.read',
  'ref/location': 'inventory.read',
  customer: 'customers.read',
  supplier: 'suppliers.read',
  purchaselist: 'purchase-orders.read',
  'advanced-purchase': 'purchase-orders.read',
};

/** The endpoint after the API root, lowercased; Cin7 matches endpoint names case-insensitively. */
const endpoint = (url: URL) =>
  url.pathname
    .replace(/^\/externalapi\/v2\//i, '')
    .replace(/\/$/, '')
    .toLowerCase();

const error = (status: number, message: string): ProviderResponse =>
  json([{ ErrorCode: status, Exception: message }], status);

/** Names a Cin7 request for fault targeting and the journal; the resource is the record ID. */
export function identify(request: ProviderRequest): ProviderTarget {
  const url = new URL(request.url);
  const operation = operations[endpoint(url)] ?? 'unknown';
  const id = url.searchParams.get('ID') ?? undefined;

  return {
    operation,
    resource: id,
    write: request.method !== 'GET' && request.method !== 'HEAD',
  };
}

/** Cin7's answer to a request with a missing or rejected account ID or application key. */
export function unauthorized(): ProviderResponse {
  return error(403, 'Incorrect credentials!');
}

/** Renames every list key, as an incompatible API change would; no list then parses. */
export function drift(response: ProviderResponse): ProviderResponse {
  if (
    response.status < 200 ||
    response.status > 299 ||
    typeof response.body !== 'object' ||
    response.body === null ||
    Array.isArray(response.body)
  )
    return response;

  return {
    ...response,
    body: Object.fromEntries(
      Object.entries(response.body).map(([key, value]) => [
        Array.isArray(value) ? `${key}Items` : key,
        value,
      ]),
    ),
  };
}

/** Cin7 allows 60 calls per minute per API application and answers 429 without Retry-After. */
export const rateLimit: RateLimit = {
  capacity: 60,
  restorePerSecond: 1,
  cost: () => 1,
  reject: () => error(429, 'You reached 60 calls per minute API limit'),
};

class Cin7Error extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface PageRequest {
  page: number;
  limit: number;
}

function pageRequest(url: URL): PageRequest {
  const read = (name: string, fallback: number) => {
    const raw = url.searchParams.get(name);
    if (raw === null) return fallback;
    if (!/^[1-9]\d{0,8}$/.test(raw))
      throw new Cin7Error(400, `Invalid ${name}`);

    return Number(raw);
  };
  const limit = read('Limit', 100);
  if (limit > MAX_LIMIT) throw new Cin7Error(400, 'Limit must not exceed 1000');

  return { page: read('Page', 1), limit };
}

/** Reads an `UpdatedSince` or `ModifiedSince` filter; Cin7 returns records changed after it. */
function since(url: URL, name: string): Partial<RecordQuery> {
  const raw = url.searchParams.get(name);
  if (raw === null) return {};
  const time = Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(raw) ? raw : `${raw}Z`);
  if (Number.isNaN(time)) throw new Cin7Error(400, `Invalid ${name}`);

  return { updatedFrom: time + 1 };
}

/** One list page in Cin7's envelope. */
const envelope = (
  key: string,
  rows: unknown[],
  page: PageRequest,
  total: number,
) => json({ Total: total, Page: page.page, [key]: rows });

/** Pages stored records by offset in creation order; `Total` is the current count. */
async function storedPage<T>(
  context: Cin7Context,
  key: string,
  page: PageRequest,
  query: Omit<RecordQuery, 'after' | 'offset' | 'limit'>,
  rows: (records: StoredRecord<T>[]) => Promise<unknown[]> | unknown[],
) {
  const records = await context.store.page<T>({
    ...query,
    offset: (page.page - 1) * page.limit,
    limit: page.limit,
  });

  return envelope(
    key,
    await rows(records.items),
    page,
    await context.store.count(query),
  );
}

/** The record an `ID` parameter names, or undefined when it names none of this kind. */
function idParam(url: URL, kind: GuidKind) {
  const raw = url.searchParams.get('ID');
  if (raw === null) return null;

  return recordOf(kind, raw);
}

const locationName = (context: Cin7Context, id: string) =>
  context.config.warehouses.find((w) => w.id === id)?.name ?? null;

/**
 * Customer-currency units per base-currency unit, as Cin7 reports `CurrencyRate`; 1 for sales
 * in the base currency.
 */
function currencyRate(context: Cin7Context, currency: string) {
  if (currency === context.config.baseCurrency) return 1;
  const base = context.config.currencyRates?.[currency];

  return base ? Math.round((1 / base) * 1_000_000) / 1_000_000 : 1;
}

const taxRule = (rate: number) =>
  rate ? `Tax on Sales ${rate}%` : 'Tax Exempt';

const round = (value: number, places = 2) =>
  Math.round(value * 10 ** places) / 10 ** places;

/** Splits a gross line price into Cin7's net price, tax and net total. */
function taxedLine(line: OrderRecord['lines'][number], taxRate: number) {
  const net = line.price / (1 + taxRate / 100);
  const total = round(net * line.quantity);

  return {
    price: round(net, 4),
    tax: round(line.price * line.quantity - total),
    total,
  };
}

function saleRow(context: Cin7Context, record: StoredRecord<OrderRecord>) {
  const order = record.data;
  const status = shipped(order);

  return {
    SaleID: guid('sale', order.id),
    OrderNumber: orderNumber(order),
    Status: saleStatus(order),
    OrderDate: cin7Time(order.date),
    CustomerID: order.customerId ? guid('customer', order.customerId) : null,
    CustomerReference: order.externalNumber ?? '',
    SourceChannel: order.externalNumber ? 'Shopify' : '',
    CustomerCurrency: order.currency,
    BaseCurrency: context.config.baseCurrency,
    CurrencyRate: currencyRate(context, order.currency),
    Updated: new Date(record.updatedAt).toISOString(),
    OrderStatus: orderStatus(order),
    FulFilmentStatus:
      status === 'none'
        ? 'NOT AVAILABLE'
        : status === 'all'
          ? 'FULFILLED'
          : 'PARTIALLY FULFILLED',
    CombinedPaymentStatus: order.paid ? 'PAID' : 'UNPAID',
    Type: 'Advanced Sale',
  };
}

const orderNumber = (order: OrderRecord) => `SO-${order.id.padStart(5, '0')}`;

function orderStatus(order: OrderRecord) {
  if (order.cancelled) return 'VOIDED';

  return shipped(order) === 'all' ? 'FULFILLED' : 'AUTHORISED';
}

function saleStatus(order: OrderRecord) {
  if (order.cancelled) return 'VOIDED';
  if (shipped(order) !== 'all') return 'ORDERED';

  return order.paid ? 'COMPLETED' : 'INVOICED';
}

async function sale(
  context: Cin7Context,
  kinds: Kinds,
  record: StoredRecord<OrderRecord>,
) {
  const order = record.data;
  const notes = await context.store.page<NoteRecord>({
    kind: kinds.note,
    parent: order.id,
    limit: 1000,
  });
  const method =
    context.config.shippingMethods.find((m) => m.id === order.shippingMethodId)
      ?.name ?? null;
  const product = (lineId: string) => {
    const line = order.lines.find((value) => value.id === lineId);

    return {
      ProductID: line ? guid('product', line.itemId) : null,
      SKU: line?.sku ?? null,
      Name: line?.name ?? null,
    };
  };

  const summary = saleRow(context, record);
  const taxRate = order.taxRate ?? 0;
  const lines = order.lines.map((line) => ({
    line,
    ...taxedLine(line, taxRate),
  }));
  const beforeTax = round(lines.reduce((sum, line) => sum + line.total, 0));

  return {
    ID: summary.SaleID,
    Status: summary.Status,
    CustomerID: summary.CustomerID,
    CustomerReference: summary.CustomerReference,
    SourceChannel: summary.SourceChannel,
    CustomerCurrency: summary.CustomerCurrency,
    BaseCurrency: summary.BaseCurrency,
    CurrencyRate: summary.CurrencyRate,
    TaxRule: taxRule(taxRate),
    TaxInclusive: false,
    FulFilmentStatus: summary.FulFilmentStatus,
    CombinedPaymentStatus: summary.CombinedPaymentStatus,
    Type: summary.Type,
    SaleOrderDate: cin7Time(order.date),
    ShipBy: null,
    LastModifiedOn: summary.Updated,
    Carrier: method,
    Order: {
      SaleOrderNumber: orderNumber(order),
      Memo: '',
      Status: orderStatus(order),
      Lines: lines.map(({ line, price, tax, total }) => ({
        ProductID: guid('product', line.itemId),
        SKU: line.sku,
        Name: line.name,
        Quantity: line.quantity,
        Price: price,
        Discount: 0,
        Tax: tax,
        TaxRule: taxRule(taxRate),
        Total: total,
      })),
      AdditionalCharges: [],
      BeforeTax: beforeTax,
      Tax: round(order.total - beforeTax),
      Total: order.total,
    },
    Fulfilments: notes.items.map(({ data: note }, index) => {
      const lines = note.lines.map((line) => ({
        ...product(line.orderLineId),
        Location: locationName(context, note.warehouse),
        LocationID: guid('location', note.warehouse),
        Quantity: line.quantity,
      }));

      return {
        TaskID: guid('fulfilment', note.id),
        FulfillmentNumber: index + 1,
        FulFilmentStatus: 'FULFILLED',
        Pick: { Status: 'AUTHORISED', Lines: lines },
        Pack: {
          Status: 'AUTHORISED',
          Lines: lines.map((line) => ({ ...line, Box: 'Box 1' })),
        },
        Ship: {
          Status: 'AUTHORISED',
          RequireBy: null,
          Lines: note.packages.map((value) => ({
            ID: guid('shipment', value.id),
            ShipmentDate: `${value.shippingDate.slice(0, 10)}T00:00:00`,
            Carrier: method,
            Boxes: 'Box 1',
            TrackingNumber: value.trackingNumber,
            TrackingURL: value.trackingUrl,
            IsShipped: true,
          })),
        },
      };
    }),
    Invoices: [],
    CreditNotes: [],
  };
}

async function sales(
  context: Cin7Context,
  kinds: Kinds,
  url: URL,
  page: PageRequest,
) {
  return storedPage<OrderRecord>(
    context,
    'SaleList',
    page,
    { kind: kinds.order, ...since(url, 'UpdatedSince') },
    (rows) => rows.map((row) => saleRow(context, row)),
  );
}

function productJson(record: StoredRecord<ItemRecord>) {
  const item = record.data;

  return {
    ID: guid('product', item.id),
    SKU: item.sku,
    Name: item.name,
    Category: 'General',
    Brand: item.manufacturer,
    Type: 'Stock',
    CostingMethod: 'FIFO',
    UOM: 'Item',
    Barcode: item.gtin ?? '',
    Status: item.active ? 'Active' : 'Deprecated',
    PriceTier1: item.price,
    LastModifiedOn: item.modified,
  };
}

/**
 * The stock report: one row per product and location, ordered by product. Every product has a
 * row at every location, so a page offset maps to products without reading them all.
 */
async function availability(
  context: Cin7Context,
  kinds: Kinds,
  url: URL,
  page: PageRequest,
) {
  const all = context.config.warehouses.map((w) => w.id);
  const name = url.searchParams.get('Location');
  const locations =
    name === null
      ? all
      : context.config.warehouses
          .filter((w) => w.name === name)
          .map((w) => w.id);
  const rowsOf = (item: ItemRecord) => {
    const allocated = allocation(item.stock, item.reserved, all);

    return locations.map((location) => {
      const onHand = item.stock[location] ?? 0;

      return {
        ID: guid('product', item.id),
        SKU: item.sku,
        Name: item.name,
        Barcode: item.gtin,
        Location: locationName(context, location),
        Bin: null,
        Batch: null,
        ExpiryDate: null,
        OnHand: onHand,
        Allocated: allocated[location] ?? 0,
        Available: onHand - (allocated[location] ?? 0),
        OnOrder: 0,
        StockOnHand: onHand,
        InTransit: 0,
        NextDeliveryDate: null,
      };
    });
  };
  const id = idParam(url, 'product');
  if (id !== null) {
    const record = id
      ? await context.store.get<ItemRecord>(kinds.item, id)
      : undefined;
    const rows = record ? rowsOf(record.data) : [];

    return envelope(
      'ProductAvailabilityList',
      rows.slice((page.page - 1) * page.limit, page.page * page.limit),
      page,
      rows.length,
    );
  }
  const width = locations.length;
  const start = (page.page - 1) * page.limit;
  const total = width * (await context.store.count({ kind: kinds.item }));
  if (!width || start >= total)
    return envelope('ProductAvailabilityList', [], page, total);
  const first = Math.floor(start / width);
  const items = await context.store.page<ItemRecord>({
    kind: kinds.item,
    offset: first,
    limit: Math.ceil(page.limit / width) + 1,
  });
  const rows = items.items.flatMap((record) => rowsOf(record.data));
  const skip = start - first * width;

  return envelope(
    'ProductAvailabilityList',
    rows.slice(skip, skip + page.limit),
    page,
    total,
  );
}

function customerJson(
  context: Cin7Context,
  record: StoredRecord<CustomerRecord>,
) {
  const customer = record.data;
  const person = `${customer.firstName} ${customer.lastName}`;

  return {
    ID: guid('customer', customer.id),
    Name: customer.company
      ? `${customer.company} (${customer.number})`
      : `${person} (${customer.number})`,
    DisplayName: person,
    Status: 'Active',
    Currency: context.config.baseCurrency,
    Tags: '',
    LastModifiedOn: customer.modified,
    Addresses: [
      {
        Line1: customer.street,
        Line2: null,
        City: customer.city,
        State: null,
        Postcode: customer.postalCode,
        Country: customer.countryIso,
        Type: 'Shipping',
        DefaultForType: true,
      },
    ],
    Contacts: [
      {
        Name: person,
        Phone: customer.phone,
        MobilePhone: null,
        Email: customer.email,
        Default: true,
      },
    ],
  };
}

function supplierJson(
  context: Cin7Context,
  record: StoredRecord<SupplierRecord>,
) {
  const supplier = record.data;

  return {
    ID: guid('supplier', supplier.id),
    Name: supplier.companyName,
    Currency: context.config.baseCurrency,
    Status: supplier.active ? 'Active' : 'Deprecated',
    LastModifiedOn: new Date(record.updatedAt).toISOString(),
    Addresses: [
      {
        Line1: null,
        City: supplier.city,
        Country: supplier.countryIso,
        Type: 'Business',
        DefaultForType: true,
      },
    ],
    Contacts: [
      { Name: supplier.companyName, Email: supplier.email, Default: true },
    ],
  };
}

const purchaseStatus = (order: PurchaseOrderRecord) =>
  order.status === 500
    ? 'RECEIVED'
    : order.status === 30
      ? 'RECEIVING'
      : 'ORDERED';

const receiving = (order: PurchaseOrderRecord) =>
  order.status === 500
    ? 'FULLY RECEIVED'
    : order.status === 30
      ? 'PARTIALLY RECEIVED'
      : 'NOT RECEIVED';

function purchaseRow(record: StoredRecord<PurchaseOrderRecord>) {
  const order = record.data;

  return {
    ID: guid('purchase', order.purchaseOrderId),
    OrderNumber: order.orderNumber,
    Status: purchaseStatus(order),
    OrderDate: cin7Time(order.createdAt),
    SupplierID: guid('supplier', order.supplierId),
    RequiredBy: `${order.requestedDeliveryDate.slice(0, 10)}T00:00:00`,
    OrderStatus: 'AUTHORISED',
    CombinedReceivingStatus: receiving(order),
    LastUpdatedDate: new Date(record.updatedAt).toISOString(),
    Type: 'Advanced Purchase',
  };
}

function purchaseJson(record: StoredRecord<PurchaseOrderRecord>) {
  const order = record.data;
  const received = order.lineItems.filter((line) => line.deliveredQuantity > 0);

  return {
    ...purchaseRow(record),
    Location: null,
    Order: {
      Status: 'AUTHORISED',
      Lines: order.lineItems.map((line) => ({
        ProductID: guid('product', line.itemId),
        SKU: line.itemNumber,
        Name: line.name,
        Quantity: line.quantity,
        Price: line.netPurchasePriceAmount,
      })),
    },
    StockReceived: received.length
      ? [
          {
            TaskID: guid('purchase', order.purchaseOrderId),
            Status: 'AUTHORISED',
            Lines: received.map((line) => ({
              ProductID: guid('product', line.itemId),
              SKU: line.itemNumber,
              Name: line.name,
              Quantity: line.deliveredQuantity,
              LocationID: guid('location', order.warehouseId),
              Received: true,
            })),
          },
        ]
      : [],
  };
}

/** Lists records of one kind, or the one record an `ID` parameter names. */
async function listOrOne<T>(
  context: Cin7Context,
  url: URL,
  page: PageRequest,
  options: {
    key: string;
    kind: string;
    guid: GuidKind;
    since?: string;
    keep?: (record: StoredRecord<T>) => boolean;
    row: (record: StoredRecord<T>) => unknown;
  },
) {
  const id = idParam(url, options.guid);
  if (id !== null) {
    const record = id
      ? await context.store.get<T>(options.kind, id)
      : undefined;

    return envelope(
      options.key,
      record ? [options.row(record)] : [],
      page,
      record ? 1 : 0,
    );
  }
  if (options.keep) {
    // Filters that the store cannot express are applied to the full list.
    const all = await context.store.page<T>({
      kind: options.kind,
      ...(options.since ? since(url, options.since) : {}),
      limit: 100_000,
    });
    const rows = all.items.filter(options.keep);

    return envelope(
      options.key,
      rows
        .slice((page.page - 1) * page.limit, page.page * page.limit)
        .map(options.row),
      page,
      rows.length,
    );
  }

  return storedPage<T>(
    context,
    options.key,
    page,
    {
      kind: options.kind,
      ...(options.since ? since(url, options.since) : {}),
    },
    (rows) => rows.map(options.row),
  );
}

async function route(
  context: Cin7Context,
  kinds: Kinds,
  request: ProviderRequest,
) {
  if (request.method !== 'GET') return undefined;
  const url = new URL(request.url);
  const page = pageRequest(url);
  const deprecated = url.searchParams.get('IncludeDeprecated') === 'true';
  switch (endpoint(url)) {
    case 'me':
      return json({
        Company: context.config.company,
        Currency: context.config.baseCurrency,
      });
    case 'salelist':
      return sales(context, kinds, url, page);
    case 'salecreditnotelist':
      // The simulated merchant handles returns in the shops; Cin7 holds no credit notes.
      return envelope('SaleList', [], page, 0);
    case 'sale': {
      const id = idParam(url, 'sale');
      const record = id
        ? await context.store.get<OrderRecord>(kinds.order, id)
        : undefined;
      if (!record) throw new Cin7Error(404, 'Sale not found');

      return json(await sale(context, kinds, record));
    }
    case 'product':
      return listOrOne<ItemRecord>(context, url, page, {
        key: 'Products',
        kind: kinds.item,
        guid: 'product',
        since: 'ModifiedSince',
        ...(deprecated ? {} : { keep: (record) => record.data.active }),
        row: productJson,
      });
    case 'ref/productavailability':
      return availability(context, kinds, url, page);
    case 'ref/location':
      return envelope(
        'LocationList',
        url.searchParams.get('Deprecated') === 'true'
          ? []
          : context.config.warehouses
              .map((w, index) => ({
                ID: guid('location', w.id),
                Name: w.name,
                IsDefault: index === 0,
                Deprecated: false,
              }))
              .slice((page.page - 1) * page.limit, page.page * page.limit),
        page,
        url.searchParams.get('Deprecated') === 'true'
          ? 0
          : context.config.warehouses.length,
      );
    case 'customer':
      return listOrOne<CustomerRecord>(context, url, page, {
        key: 'CustomerList',
        kind: kinds.customer,
        guid: 'customer',
        since: 'ModifiedSince',
        row: (record) => customerJson(context, record),
      });
    case 'supplier':
      return listOrOne<SupplierRecord>(context, url, page, {
        key: 'SupplierList',
        kind: kinds.supplier,
        guid: 'supplier',
        since: 'ModifiedSince',
        ...(deprecated ? {} : { keep: (record) => record.data.active }),
        row: (record) => supplierJson(context, record),
      });
    case 'purchaselist':
      return storedPage<PurchaseOrderRecord>(
        context,
        'PurchaseList',
        page,
        { kind: kinds.purchaseOrder, ...since(url, 'UpdatedSince') },
        (rows) => rows.map(purchaseRow),
      );
    case 'advanced-purchase': {
      const id = idParam(url, 'purchase');
      const record = id
        ? await context.store.get<PurchaseOrderRecord>(kinds.purchaseOrder, id)
        : undefined;
      if (!record) throw new Cin7Error(404, 'Purchase not found');

      return json(purchaseJson(record));
    }
    default:
      return undefined;
  }
}

/**
 * Creates the handler for the Cin7 Core API v2 reads the Luma Cin7 adapter uses, over records
 * of the given kinds. Requests need the account ID and any nonempty application key. Lists page
 * by `Page` and `Limit` (at most 1,000) in creation order, so records created while a client
 * pages shift later pages.
 */
export const createHandler =
  (kinds: Kinds) =>
  async (
    context: Cin7Context,
    request: ProviderRequest,
  ): Promise<ProviderResponse> => {
    const account = request.headers['api-auth-accountid'] ?? '';
    if (
      account.toLowerCase() !== context.config.accountId.toLowerCase() ||
      !request.headers['api-auth-applicationkey']?.trim()
    )
      return unauthorized();
    try {
      return (
        (await route(context, kinds, request)) ??
        error(404, 'Endpoint not found')
      );
    } catch (caught) {
      if (caught instanceof Cin7Error)
        return error(caught.status, caught.message);
      throw caught;
    }
  };
