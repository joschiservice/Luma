import { createHash, randomUUID } from 'node:crypto';

import {
  type CapabilityHandler,
  type CapabilityInput,
  type CapabilityOutput,
  type ConnectorConnection,
  ConnectorError,
  type Observation,
  type SourceIdentity,
} from '@luma/connections';
import {
  API_VERSION,
  type Cin7TransportOptions,
  createClient,
  fail,
  parse,
} from '@luma/connector-cin7';
import * as s from '@luma/connector-cin7/schemas';
import { z } from 'zod';

import { inputs } from './inputs.js';
import {
  customerSnapshot,
  fulfillmentSnapshots,
  isOrder,
  orderSnapshot,
  productSnapshot,
  purchaseSnapshot,
  ref,
  refundSnapshots,
  sum,
  supplierSnapshot,
} from './mapping.js';
import { adapterVersion, type Cin7ReadCapability, outputs } from './outputs.js';
import { createSaleCache, type SaleCache } from './sale-cache.js';
import { createProductUnits, type ProductUnits, unitOf } from './units.js';

interface Cin7Evidence {
  tenantId: string;
  connectionId: string;
  apiVersion: typeof API_VERSION;
  capability: Cin7ReadCapability;
  observations: Observation<unknown>[];
}

export interface Cin7ConnectorOptions extends Cin7TransportOptions {
  tenantId: string;
  connectionId: string;
  /** Persist the validated batch before resolving. */
  recordObservations(evidence: Cin7Evidence): Promise<void>;
  /** Product units shared by every adapter of the connection. */
  units?: ProductUnits;
  /** Sale details shared by the connection's order, fulfillment and return reads. */
  sales?: SaleCache;
  /**
   * Reports which customer placed each order. Set only when the connection grants
   * `customers.read`.
   */
  customers?: boolean;
  /** Exposes supplier product metadata only for authorized purchasing reads. */
  purchasingTerms?: boolean;
  now?: () => Date;
  id?: () => string;
}

/**
 * Sales per page for order, fulfillment and return reads. Each sale needs its own detail
 * request, so a page costs about 26 of the application's 60 calls per minute.
 */
const salesPerPage = 25;

/** Stock rows per inventory page; Cin7's maximum, so a full stock read stays cheap. */
const stockRowsPerPage = 1000;

/** Products per page when loading the unit catalog. */
const catalogRowsPerPage = 1000;

/** Detail reads in flight per page; the pacer still admits one request at a time. */
const detailConcurrency = 2;

/** Cin7 filters take UTC times without a zone designator. */
const cin7Time = (value: string) => new Date(value).toISOString().slice(0, 23);

const cursorSchema = z
  .object({
    binding: z.string(),
    page: z.number().int().min(2).max(1_000_000),
    // The last product an inventory page reread in full; the next page skips it.
    last: s.guid.optional(),
  })
  .strict();

/** Creates the Cin7 Core read adapter for one connection. */
export function createCin7Connector(
  options: Cin7ConnectorOptions,
): ConnectorConnection {
  if (!options.tenantId || !options.connectionId) fail('invalid_input');
  const client = createClient(options);
  const units = options.units ?? createProductUnits();
  const cache = options.sales ?? createSaleCache();
  const now = options.now ?? (() => new Date());
  const nextId = options.id ?? randomUUID;

  async function list<T extends z.ZodTypeAny>(
    path: string,
    key: string,
    item: T,
    query: Record<string, string>,
  ) {
    return parse(s.page(key, item), await client.request(path, query));
  }

  async function loadUnits() {
    const loaded = new Map<string, string>();
    for (let page = 1; page <= 1000; page++) {
      const result = await list('product', 'Products', s.product, {
        Page: String(page),
        Limit: String(catalogRowsPerPage),
        IncludeDeprecated: 'true',
      });
      for (const product of result.items)
        loaded.set(product.ID, unitOf(product.UOM));
      if (!result.items.length || page * catalogRowsPerPage >= result.total)
        return loaded;
    }
    fail('invalid_response');
  }

  const unitsFor = (ids: Iterable<string>) => units.resolve(ids, loadUnits);

  // A record deleted after it was listed has nothing left to report.
  async function detail<T>(read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch (error) {
      if (error instanceof ConnectorError && error.failure.code === 'not_found')
        return null;
      throw error;
    }
  }

  const sale = (id: string) =>
    detail(async () => {
      const result = parse(
        s.sale,
        await client.request('sale', {
          ID: id,
          HideInventoryMovements: 'true',
        }),
      );
      if (result.ID.toLowerCase() !== id.toLowerCase())
        fail('invalid_response');

      return result;
    });

  function handler<K extends Cin7ReadCapability>(
    capability: K,
    filters: ('updatedSince' | 'createdSince' | 'historyImport')[] = [],
  ): CapabilityHandler<K> {
    return {
      descriptor: {
        version: '0',
        minimumRisk: 'low',
        idempotency: 'none',
        retry: { maxAttempts: 3, initialDelayMs: 1000 },
        ...(filters.length ? { filters } : {}),
      },
      parseInput: (value) =>
        inputs[capability].parse(value) as CapabilityInput<K>,
      parseOutput: (value) =>
        outputs[capability].parse(value) as CapabilityOutput<K>,
      async run(context, input) {
        if (
          context.tenant.tenantId !== options.tenantId ||
          context.connectionId !== options.connectionId ||
          context.provider !== 'cin7'
        )
          fail('unavailable');
        const query = input as {
          limit: number;
          cursor?: string;
          updatedSince?: string;
          order?: { externalId: string };
          sku?: { externalId: string };
          location?: { externalId: string };
          supplier?: { externalId: string };
        };
        const binding = createHash('sha256')
          .update(
            JSON.stringify([
              options.tenantId,
              options.connectionId,
              client.binding,
              API_VERSION,
              capability,
              query.limit,
              query.updatedSince ?? null,
              query.order ?? null,
              query.sku ?? null,
              query.location ?? null,
              query.supplier ?? null,
            ]),
          )
          .digest('hex');
        let cursor: z.infer<typeof cursorSchema> = { binding, page: 1 };
        if (query.cursor) {
          try {
            cursor = cursorSchema.parse(
              JSON.parse(
                Buffer.from(query.cursor, 'base64url').toString('utf8'),
              ),
            );
          } catch {
            fail('invalid_input');
          }
          if (cursor.binding !== binding) fail('invalid_input');
        }
        const pageNumber = cursor.page;
        const since = query.updatedSince
          ? cin7Time(query.updatedSince)
          : undefined;
        const observedAt = now().toISOString();
        const observations: Observation<unknown>[] = [];

        function emit(
          resource: SourceIdentity['resource'],
          external: { externalId: string; scopeKey: string },
          sourceUpdatedAt: string | null,
          data: unknown,
          kind: 'snapshot' | 'tombstone' = 'snapshot',
        ) {
          observations.push({
            id: nextId(),
            source: {
              ...external,
              tenantId: options.tenantId,
              connectionId: options.connectionId,
              provider: 'cin7',
              resource,
            },
            kind,
            observedAt,
            sourceUpdatedAt,
            sourceRevision:
              capability === 'inventory.read'
                ? createHash('sha256')
                    .update(JSON.stringify({ external, data, kind }))
                    .digest('hex')
                : null,
            adapterVersion,
            schemaVersion: 1,
            data,
          });
        }

        // Reads the sales of one page, or the one sale an order filter names.
        async function sales(
          path: 'saleList' | 'saleCreditNoteList',
          wanted: (row: z.infer<typeof s.saleListItem>) => boolean,
        ) {
          if (query.order) {
            const found = await sale(query.order.externalId);

            return { sales: found ? [found] : [], hasNext: false, total: 0 };
          }
          const result = await list(path, 'SaleList', s.saleListItem, {
            Page: String(pageNumber),
            Limit: String(Math.min(query.limit, salesPerPage)),
            ...(since ? { UpdatedSince: since } : {}),
          });
          const rows = [
            ...new Map(
              result.items.filter(wanted).map((row) => [row.SaleID, row]),
            ).values(),
          ];
          const details = await mapConcurrent(
            rows,
            detailConcurrency,
            async (row) => {
              const cached = cache.get(row.SaleID, row.Updated);
              if (cached) return cached;
              const found = await sale(row.SaleID);
              if (found) cache.set(row.SaleID, row.Updated, found);

              return found;
            },
          );

          return {
            sales: details.filter((value) => value !== null),
            hasNext:
              result.items.length > 0 &&
              pageNumber * Math.min(query.limit, salesPerPage) < result.total,
            total: result.total,
          };
        }

        const productsOf = (
          values: {
            Order?:
              | { Lines: { ProductID?: string | null | undefined }[] }
              | null
              | undefined;
          }[],
        ) =>
          values.flatMap((value) =>
            (value.Order?.Lines ?? []).flatMap((line) =>
              line.ProductID ? [line.ProductID] : [],
            ),
          );

        let hasNext = false;
        let total: number | undefined;
        let last: string | undefined;
        if (capability === 'orders.read') {
          const read = await sales(
            'saleList',
            (row) => isOrder(row.OrderStatus) || row.Status === 'VOIDED',
          );
          ({ hasNext } = read);
          total = read.total;
          const unit = await unitsFor(productsOf(read.sales));
          for (const value of read.sales)
            if (isOrder(value.Order?.Status))
              emit(
                'order',
                ref(value.ID),
                value.LastModifiedOn ?? null,
                orderSnapshot(value, unit, !!options.customers),
              );
        } else if (capability === 'fulfillment.read') {
          // Sales without fulfilments need no detail read.
          const read = await sales(
            'saleList',
            (row) =>
              (isOrder(row.OrderStatus) || row.Status === 'VOIDED') &&
              !!row.FulFilmentStatus &&
              row.FulFilmentStatus !== 'NOT AVAILABLE',
          );
          ({ hasNext } = read);
          const unit = await unitsFor(productsOf(read.sales));
          for (const value of read.sales)
            if (isOrder(value.Order?.Status))
              for (const fulfillment of fulfillmentSnapshots(value, unit))
                emit(
                  'fulfillment',
                  ref(fulfillment.id),
                  value.LastModifiedOn ?? null,
                  fulfillment.data,
                );
        } else if (capability === 'returns.read') {
          const read = await sales('saleCreditNoteList', () => true);
          ({ hasNext } = read);
          const unit = await unitsFor(
            read.sales.flatMap((value) =>
              value.CreditNotes.flatMap((note) =>
                note.Lines.flatMap((line) =>
                  line.ProductID ? [line.ProductID] : [],
                ),
              ),
            ),
          );
          for (const value of read.sales)
            for (const refund of refundSnapshots(value, unit))
              emit(
                'refund',
                ref(refund.id),
                value.LastModifiedOn ?? null,
                refund.data,
                // A voided credit note no longer refunds anything.
                refund.voided ? 'tombstone' : 'snapshot',
              );
        } else if (capability === 'products.read') {
          const result = await list('product', 'Products', s.product, {
            Page: String(pageNumber),
            Limit: String(query.limit),
            IncludeDeprecated: 'true',
            ...(since ? { ModifiedSince: since } : {}),
          });
          hasNext =
            result.items.length > 0 && pageNumber * query.limit < result.total;
          total = result.total;
          units.remember(
            result.items.map((product) => [product.ID, unitOf(product.UOM)]),
          );
          for (const product of result.items)
            emit(
              'product',
              ref(product.ID),
              product.LastModifiedOn ?? null,
              productSnapshot(
                options.purchasingTerms
                  ? product
                  : { ...product, Suppliers: undefined },
              ),
            );
        } else if (capability === 'inventory.read') {
          ({ hasNext, last } = await readStock(
            query,
            pageNumber,
            cursor.last,
            emit,
          ));
        } else if (capability === 'customers.read') {
          const result = await list('customer', 'CustomerList', s.customer, {
            Page: String(pageNumber),
            Limit: String(query.limit),
            IncludeDeprecated: 'true',
            ...(since ? { ModifiedSince: since } : {}),
          });
          hasNext =
            result.items.length > 0 && pageNumber * query.limit < result.total;
          total = result.total;
          for (const customer of result.items)
            emit(
              'customer',
              ref(customer.ID),
              customer.LastModifiedOn ?? null,
              customerSnapshot(customer),
            );
        } else if (capability === 'suppliers.read') {
          const result = await list('supplier', 'SupplierList', s.supplier, {
            ...(query.supplier
              ? { ID: query.supplier.externalId }
              : {
                  Page: String(pageNumber),
                  Limit: String(query.limit),
                  ...(since ? { ModifiedSince: since } : {}),
                }),
            IncludeDeprecated: 'true',
          });
          hasNext =
            !query.supplier &&
            result.items.length > 0 &&
            pageNumber * query.limit < result.total;
          for (const supplier of result.items) {
            if (
              query.supplier &&
              supplier.ID.toLowerCase() !==
                query.supplier.externalId.toLowerCase()
            )
              fail('invalid_response');
            emit(
              'supplier',
              ref(supplier.ID),
              supplier.LastModifiedOn ?? null,
              supplierSnapshot(supplier),
            );
          }
        } else {
          // Purchases: one detail read each, including simple and service purchases.
          let ids: string[];
          if (query.order) ids = [query.order.externalId];
          else {
            const result = await list(
              'purchaseList',
              'PurchaseList',
              s.purchaseListItem,
              { Page: String(pageNumber), Limit: String(query.limit) },
            );
            hasNext =
              result.items.length > 0 &&
              pageNumber * query.limit < result.total;
            ids = result.items.map((row) => row.ID);
          }
          const purchases = (
            await mapConcurrent(ids, detailConcurrency, (id) =>
              detail(async () => {
                const result = parse(
                  s.purchase,
                  await client.request('advanced-purchase', { ID: id }),
                );
                if (result.ID.toLowerCase() !== id.toLowerCase())
                  fail('invalid_response');

                return result;
              }),
            )
          ).filter((value) => value !== null);
          const unit = await unitsFor(productsOf(purchases));
          for (const purchase of purchases)
            emit(
              'purchase_order',
              ref(purchase.ID),
              purchase.LastUpdatedDate ?? null,
              purchaseSnapshot(purchase, unit),
            );
        }

        const keys = observations.map((value) =>
          JSON.stringify([
            value.source.resource,
            value.source.externalId,
            value.source.scopeKey,
          ]),
        );
        if (new Set(keys).size !== keys.length) fail('invalid_response');
        const result = parse<unknown>(outputs[capability], {
          items: observations,
          nextCursor: hasNext
            ? Buffer.from(
                JSON.stringify({
                  binding,
                  page: pageNumber + 1,
                  ...(last ? { last } : {}),
                }),
              ).toString('base64url')
            : null,
          completeness: 'complete',
          ...(total === undefined ? {} : { total }),
        }) as CapabilityOutput<K>;
        await options.recordObservations({
          tenantId: options.tenantId,
          connectionId: options.connectionId,
          apiVersion: API_VERSION,
          capability,
          observations: (result as { items: Observation<unknown>[] }).items,
        });

        return result;
      },
    };
  }

  /**
   * Reads one page of stock rows and reports each product's totals per location. Cin7 splits
   * stock by bin and batch and names locations instead of identifying them. A product at a page
   * edge may continue on the neighboring page, so edge products are reread in full by ID; the
   * cursor names the last one so the next page skips it.
   */
  async function readStock(
    query: {
      limit: number;
      sku?: { externalId: string };
      location?: { externalId: string };
    },
    pageNumber: number,
    previous: string | undefined,
    emit: (
      resource: SourceIdentity['resource'],
      external: { externalId: string; scopeKey: string },
      sourceUpdatedAt: string | null,
      data: unknown,
    ) => void,
  ) {
    const locations = await readLocations();
    const locationName = query.location
      ? [...locations].find(([, id]) => id === query.location!.externalId)?.[0]
      : undefined;
    // An unknown location has no stock to report.
    if (query.location && !locationName) return { hasNext: false };
    const filter = locationName ? { Location: locationName } : {};

    async function rowsOf(productId: string) {
      const rows: z.infer<typeof s.availability>[] = [];
      for (let page = 1; page <= 100; page++) {
        const result = await list(
          'ref/productavailability',
          'ProductAvailabilityList',
          s.availability,
          {
            ID: productId,
            Page: String(page),
            Limit: String(stockRowsPerPage),
            ...filter,
          },
        );
        if (result.items.some((row) => row.ID !== productId))
          fail('invalid_response');
        rows.push(...result.items);
        if (!result.items.length || page * stockRowsPerPage >= result.total)
          return rows;
      }
      fail('invalid_response');
    }

    let hasNext = false;
    let last: string | undefined;
    const groups = new Map<string, z.infer<typeof s.availability>[]>();
    if (query.sku)
      groups.set(query.sku.externalId, await rowsOf(query.sku.externalId));
    else {
      const result = await list(
        'ref/productavailability',
        'ProductAvailabilityList',
        s.availability,
        {
          Page: String(pageNumber),
          Limit: String(stockRowsPerPage),
          ...filter,
        },
      );
      hasNext =
        result.items.length > 0 && pageNumber * stockRowsPerPage < result.total;
      for (const row of result.items) {
        if (row.ID === previous) continue;
        groups.set(row.ID, [...(groups.get(row.ID) ?? []), row]);
      }
      const ids = [...groups.keys()];
      const edges = new Set(
        [
          pageNumber > 1 ? ids[0] : undefined,
          hasNext ? ids.at(-1) : undefined,
        ].filter((id): id is string => !!id),
      );
      for (const id of edges) groups.set(id, await rowsOf(id));
      last = hasNext ? ids.at(-1) : undefined;
    }

    const unit = await unitsFor(groups.keys());
    for (const [productId, rows] of groups) {
      const byLocation = new Map<string, z.infer<typeof s.availability>[]>();
      for (const row of rows) {
        const locationId = locations.get(row.Location);
        if (!locationId) fail('invalid_response');
        byLocation.set(locationId, [
          ...(byLocation.get(locationId) ?? []),
          row,
        ]);
      }
      for (const [locationId, located] of byLocation) {
        // A missing value in any bin or batch leaves the location's total unknown.
        const total = (field: 'OnHand' | 'Allocated' | 'Available') =>
          located.every((row) => row[field] != null)
            ? sum(located.map((row) => row[field]!))
            : null;
        const available = total('Available');
        emit('sku', ref(productId, locationId), null, {
          sku: ref(productId),
          location: ref(locationId),
          unit: unit(productId),
          onHand: total('OnHand'),
          reserved: total('Allocated'),
          available,
          availabilityBasis:
            available === null ? 'unknown' : 'provider_reported',
        });
      }
    }

    return { hasNext, last };
  }

  /** Maps location names to IDs, including deprecated locations that still hold stock. */
  async function readLocations() {
    const names = new Map<string, string>();
    for (const deprecated of [false, true])
      for (let page = 1; page <= 100; page++) {
        const result = await list('ref/location', 'LocationList', s.location, {
          Page: String(page),
          Limit: '1000',
          ...(deprecated ? { Deprecated: 'true' } : {}),
        });
        for (const location of result.items) {
          const known = names.get(location.Name);
          // Two locations sharing a name cannot be told apart in stock rows.
          if (known && known !== location.ID) fail('invalid_response');
          names.set(location.Name, location.ID);
        }
        if (!result.items.length || page * 1000 >= result.total) break;
      }

    return names;
  }

  return {
    tenantId: options.tenantId,
    id: options.connectionId,
    provider: 'cin7',
    status: 'active',
    adapterVersion,
    mechanism: 'api',
    executor: { kind: 'connector', id: adapterVersion },
    capabilities: {
      'orders.read': handler('orders.read', ['updatedSince']),
      'fulfillment.read': handler('fulfillment.read', ['updatedSince']),
      'returns.read': handler('returns.read', ['updatedSince']),
      'products.read': handler('products.read', ['updatedSince']),
      'inventory.read': handler('inventory.read'),
      ...(options.customers
        ? { 'customers.read': handler('customers.read', ['updatedSince']) }
        : {}),
      'suppliers.read': handler('suppliers.read', ['updatedSince']),
      'purchase-orders.read': handler('purchase-orders.read'),
    },
  };
}

/** Maps items with at most `limit` calls in flight, in input order; stops after a failure. */
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (!failed && next < items.length) {
        const index = next++;
        try {
          results[index] = await map(items[index]!);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );

  return results;
}
