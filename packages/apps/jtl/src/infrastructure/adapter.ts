import { createHash, randomUUID } from 'node:crypto';

import {
  type CapabilityHandler,
  type CapabilityInput,
  type CapabilityOutput,
  type ConnectorConnection,
  ConnectorError,
  type CustomerSnapshot,
  type ExternalId,
  type MessageReadCapability,
  type Observation,
  type ProductSnapshot,
  type ReadCapability,
  type SourceIdentity,
} from '@luma/connections';
import type { JtlTransportOptions } from '@luma/connector-jtl';
import { API_VERSION, createClient, fail, parse } from '@luma/connector-jtl';
import { z } from 'zod';

import { createExchangeReservation } from './exchange-reservation.js';
import { adapterVersion, outputs } from './outputs.js';
import { createJtlPurchaseOrderCapabilities } from './purchase-orders.js';
import { createJtlSettlementCapabilities } from './return-settlement.js';
import { createJtlReturnCapabilities } from './returns.js';
import * as s from './schemas.js';
import { createJtlShippingMethodCapabilities } from './shipping-method.js';

// Blank or oversized source text is treated as not provided rather than truncated.
const text = (value: string | null | undefined) => {
  const trimmed = value?.trim();

  return trimmed && trimmed.length <= 512 ? trimmed : null;
};

// Only absolute web links are kept; anything else is treated as not provided.
const trackingLink = (value: string | null | undefined) => {
  const url = value?.trim();
  if (!url || url.length > 2048) return null;
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol) ? url : null;
  } catch {
    return null;
  }
};

const ref = (id: number | string, scopeKey = ''): ExternalId => ({
  externalId: String(id),
  scopeKey,
});

interface JtlEvidence {
  tenantId: string;
  connectionId: string;
  apiVersion: typeof API_VERSION;
  capability: ReadCapability;
  observations: Observation<unknown>[];
  /** Allowlisted fields only. Storage must enforce encryption, tenant access and expiry. */
  raw?: { payloads: unknown[]; expiresAt: string };
}

export interface JtlConnectorOptions extends JtlTransportOptions {
  tenantId: string;
  connectionId: string;
  /** Persist the validated batch before resolving. */
  recordObservations(evidence: JtlEvidence): Promise<void>;
  rawRetentionMs?: number;
  /** Adds bounded supplier reads only for the released purchasing feature. */
  purchasingTerms?: boolean;
  /** Enable only after confirming sales-order read/write grants and endpoint support. */
  shippingMethodActions?: boolean;
  /** Enable only after confirming purchase-order write and item read grants and endpoint support. */
  purchaseOrderActions?: boolean;
  /** Releases one-operation purchase-order revisions after grant verification. */
  purchaseOrderRevisions?: boolean;
  /** Enable only after confirming return write, return read and sales-order read grants. */
  returnActions?: boolean;
  /** Writes are currently verified only in the installed simulator. */
  settlementActions?: boolean;
  /**
   * Reads customers and reports which customer placed each order. Set only when the connection
   * grants `customers.read`.
   */
  customers?: boolean;
  /** Map configured JTL unit labels to canonical units without converting quantities. */
  units?: Record<string, string>;
  now?: () => Date;
  id?: () => string;
}

/** Resolve only for a currently active connection owned by the requesting tenant. */
export function createJtlConnector(
  options: JtlConnectorOptions,
): ConnectorConnection {
  if (!options.tenantId || !options.connectionId) fail('invalid_input');
  if (
    options.rawRetentionMs !== undefined &&
    (!Number.isSafeInteger(options.rawRetentionMs) ||
      options.rawRetentionMs <= 0 ||
      options.rawRetentionMs > 365 * 86400000)
  )
    fail('invalid_input');
  const units = { stk: 'each', Stück: 'each', each: 'each', ...options.units };
  if (Object.values(units).some((value) => !value.trim()))
    fail('invalid_input');
  const unit = (value: string | undefined) =>
    !value?.trim()
      ? 'unknown'
      : Object.hasOwn(units, value)
        ? (units[value as keyof typeof units] ?? value)
        : value;
  const client = createClient(options);
  const now = options.now ?? (() => new Date());
  const nextId = options.id ?? randomUUID;

  function handler<
    K extends Exclude<
      ReadCapability,
      | 'orders.shipping-method.read'
      | 'returns.read'
      | 'suppliers.read'
      | 'purchase-orders.read'
      | MessageReadCapability
      | 'returns.options.read'
      | 'returns.created.read'
      | 'returns.exchange.options.read'
      | 'returns.exchange.quote.read'
      | 'returns.exchange.proof.read'
      | 'returns.exchange.price.read'
      | 'returns.exchange.reservation.read'
      | 'returns.settlement.quote.read'
      | 'returns.settlement.proof.read'
      | 'inventory.transfers.read'
      | 'inventory.shipments.read'
    >,
  >(capability: K): CapabilityHandler<K> {
    return {
      descriptor: {
        version: '0',
        minimumRisk: 'low',
        idempotency: 'none',
        retry: { maxAttempts: 3, initialDelayMs: 1000 },
        ...(capability === 'customers.read'
          ? { filters: ['updatedSince' as const] }
          : capability === 'orders.read'
            ? { filters: ['order' as const] }
            : {}),
      },
      parseInput: (value) =>
        s.inputs[capability].parse(value) as CapabilityInput<K>,
      parseOutput: (value) =>
        outputs[capability].parse(value) as CapabilityOutput<K>,
      async run(context, input) {
        if (
          context.tenant.tenantId !== options.tenantId ||
          context.connectionId !== options.connectionId ||
          context.provider !== 'jtl'
        )
          fail('unavailable');
        const filters = input as CapabilityInput<'inventory.read'> &
          CapabilityInput<'fulfillment.read'>;
        const updatedSince =
          'updatedSince' in input ? (input.updatedSince ?? null) : null;
        const binding = createHash('sha256')
          .update(
            JSON.stringify([
              options.tenantId,
              options.connectionId,
              client.binding,
              API_VERSION,
              capability,
              input.limit,
              filters.sku ?? null,
              filters.location ?? null,
              filters.order ?? null,
              updatedSince,
              units,
            ]),
          )
          .digest('hex');
        let pageNumber = 1;
        if (input.cursor) {
          try {
            pageNumber = z
              .object({
                binding: z.literal(binding),
                page: z.number().int().min(2).max(2147483647),
              })
              .strict()
              .parse(
                JSON.parse(
                  Buffer.from(input.cursor, 'base64url').toString('utf8'),
                ),
              ).page;
          } catch {
            fail('invalid_input');
          }
        }
        const payloads: unknown[] = [];

        function capture<T>(schema: z.ZodType<T>, value: unknown): T {
          const result = parse(schema, value);
          if (options.rawRetentionMs !== undefined) payloads.push(result);

          return result;
        }

        async function page<T extends z.ZodTypeAny>(
          path: string,
          schema: T,
          number: number,
          size: number,
          query: Record<string, string> = {},
        ) {
          const result = capture(
            s.page(schema),
            await client.request(path, {
              ...query,
              pageNumber: String(number),
              pageSize: String(size),
            }),
          );
          const remaining = Math.max(
            0,
            result.totalItems - (number - 1) * size,
          );
          const hasNext = number * size < result.totalItems;
          if (
            result.pageNumber !== number ||
            result.pageSize !== size ||
            result.items.length !== Math.min(size, remaining) ||
            (result.hasNextPage !== undefined &&
              result.hasNextPage !== hasNext) ||
            (hasNext &&
              result.nextPageNumber !== undefined &&
              result.nextPageNumber !== number + 1)
          )
            fail('invalid_response');

          return {
            items: result.items as z.infer<T>[],
            hasNext,
            total: result.totalItems,
          };
        }

        async function children<T extends z.ZodTypeAny>(
          path: string,
          schema: T,
        ) {
          const result: z.infer<T>[] = [];
          const seen = new Set<string>();
          for (let number = 1; number <= 1000; number++) {
            const current = await page(path, schema, number, 100);
            for (const row of current.items) {
              const id = parse(z.object({ id: s.id }), row).id;
              if (seen.has(id)) fail('invalid_response');
              seen.add(id);
              result.push(row);
            }
            if (!current.hasNext) return result;
          }
          fail('invalid_response');
        }

        const observedAt = now().toISOString();
        const observations: Observation<unknown>[] = [];

        function emit(
          resource: SourceIdentity['resource'],
          external: ExternalId,
          sourceUpdatedAt: string | null,
          data: unknown,
        ) {
          observations.push({
            id: nextId(),
            source: {
              ...external,
              tenantId: options.tenantId,
              connectionId: options.connectionId,
              provider: 'jtl',
              resource,
            },
            kind: 'snapshot',
            observedAt,
            sourceUpdatedAt,
            sourceRevision: null,
            adapterVersion,
            schemaVersion: 1,
            data,
          });
        }

        const location = filters.location?.externalId ?? 'all-warehouses';

        // Reads one item's stock for the requested warehouse; all warehouses use item totals.
        async function readStock(item: z.infer<typeof s.item>) {
          return location === 'all-warehouses'
            ? null
            : capture(
                s.warehouseStock,
                await client.request(
                  `warehouses/${location}/items/${item.id}/stocks`,
                ),
              );
        }

        // Emits one item's stock for the requested warehouse, or across all warehouses.
        function emitStock(
          item: z.infer<typeof s.item>,
          stock: Awaited<ReturnType<typeof readStock>>,
        ) {
          const known = (value: string | null | undefined) =>
            item.isInventoryManagementActive ? (value ?? null) : null;
          const available =
            location === 'all-warehouses' ? known(item.stockAvailable) : null;
          emit('sku', ref(item.id, location), item.modifiedTimestamp ?? null, {
            sku: ref(item.id),
            location: ref(location),
            unit: unit(item.unit),
            onHand: known(stock ? stock.totalQuantity : item.stockTotal),
            reserved: stock ? null : known(item.stockReservedTotal),
            available,
            availabilityBasis:
              available === null ? 'unknown' : 'provider_reported',
          });
        }

        const linesByOrder = new Map<
          string,
          Promise<z.infer<typeof s.orderLine>[]>
        >();

        // Several delivery notes of one order share its line read within a page.
        function orderLines(orderId: string) {
          let lines = linesByOrder.get(orderId);
          if (!lines) {
            lines = client
              .request(`sales-orders/${orderId}/line-items`)
              .then((value) => {
                const parsed = capture(z.array(s.orderLine), value);
                if (
                  new Set(parsed.map((line) => line.id)).size !==
                    parsed.length ||
                  parsed.some((line) => line.salesOrderId !== orderId)
                )
                  fail('invalid_response');

                return parsed;
              });
            linesByOrder.set(orderId, lines);
          }

          return lines;
        }

        // Emits one sales order with its lines, the same for paged and point reads.
        function emitOrder(
          order: z.infer<typeof s.order>,
          lines: z.infer<typeof s.orderLine>[],
        ) {
          // ERP 2.2 sales orders and delivery notes have no modification time, so these
          // snapshots are ordered by observation time. Creation dates are not update times.
          emit('order', ref(order.id), null, {
            displayNumber: order.salesOrderNumber,
            externalOrderNumber: order.externalSalesOrderNumber ?? null,
            placedAt: order.salesOrderDate ?? null,
            total:
              order.totalGrossAmount != null &&
              /^[A-Z]{3}$/.test(order.currencyIso ?? '')
                ? {
                    amount: order.totalGrossAmount,
                    currency: order.currencyIso!,
                  }
                : null,
            ...(options.customers && order.customerId !== undefined
              ? {
                  customer:
                    order.customerId === 0 || order.customerId === null
                      ? null
                      : ref(order.customerId),
                }
              : {}),
            status:
              order.isCancelled || order.deliveryStatus === 0
                ? 'cancelled'
                : [5, 7].includes(order.deliveryStatus)
                  ? 'completed'
                  : [1, 2, 3, 4].includes(order.deliveryStatus)
                    ? 'open'
                    : 'unknown',
            paymentStatus:
              order.paymentStatus === 2
                ? 'paid'
                : order.paymentStatus === 0
                  ? 'pending'
                  : 'unknown',
            lines: lines.map((line) => ({
              id: ref(line.id, String(order.id)),
              sku:
                line.itemId === 0 ||
                line.itemId === null ||
                line.itemId === '00000000-0000-0000-0000-000000000000'
                  ? null
                  : ref(line.itemId),
              quantity: { amount: line.quantity, unit: unit(line.salesUnit) },
              // ERP 2.2 exposes delivered/returned units, but no cancelled line quantity.
              cancelledQuantity: null,
              ...(line.salesPriceNet != null &&
              order.currencyIso &&
              /^[A-Z]{3}$/.test(order.currencyIso)
                ? {
                    unitPrice: {
                      amount: line.salesPriceNet,
                      currency: order.currencyIso,
                    },
                    // JTL reports net line prices.
                    taxIncluded: false,
                  }
                : { unitPrice: null, taxIncluded: null }),
              taxRate:
                line.taxRate != null &&
                Number(line.taxRate) >= 0 &&
                Number(line.taxRate) <= 100
                  ? String(Number(line.taxRate) / 100)
                  : null,
              skuCode: text(line.sKU),
              title: text(line.name),
            })),
          });
        }

        async function readPurchasingTerms(itemId: string | number) {
          const assignments: ReturnType<typeof s.itemSupplier.parse>[] = [];
          let complete = false;
          for (let n = 1; n <= 10; n++) {
            const result = await page(
              `items/${encodeURIComponent(String(itemId))}/suppliers`,
              s.itemSupplier,
              n,
              100,
            );
            assignments.push(...result.items);
            if (!result.hasNext) {
              complete = true;
              break;
            }
          }

          return assignments.slice(0, 100).map((a) => ({
            supplier: ref(a.supplierId),
            sourceRecordId: String(a.id),
            complete: complete && assignments.length <= 100,
            supplierArticleNumber: text(a.supplierItemNumber),
            unitPrice:
              a.netPurchasePrice != null
                ? {
                    amount: a.netPurchasePrice,
                    currency:
                      a.supplierCurrency &&
                      /^[A-Z]{3}$/.test(a.supplierCurrency)
                        ? a.supplierCurrency
                        : null,
                    validFrom: null,
                  }
                : null,
            packSize:
              a.packageUnitQuantity != null && Number(a.packageUnitQuantity) > 0
                ? Number(a.packageUnitQuantity)
                : null,
            lineMinimumQuantity: a.minimumPurchaseQuantity ?? null,
            orderMinimumValue: null,
            leadTimeDays:
              (a.useSupplierDeliveryTime
                ? a.supplierDeliveryTimeInDays
                : a.deliveryTimeInDays) ?? null,
            preferred: a.isDefaultSupplier ?? null,
          }));
        }

        let hasNext: boolean;
        // Sales orders and items map one-to-one to observations, so their count estimates progress.
        let total: number | undefined;
        if (capability === 'orders.read' && 'order' in input && input.order) {
          // A point read of one order; an unknown order reads as an empty page.
          hasNext = false;
          const requested = input.order.externalId;
          let order: z.infer<typeof s.order> | null = null;
          try {
            order = capture(
              s.orderDetail,
              await client.request(
                `sales-orders/${encodeURIComponent(requested)}`,
              ),
            );
          } catch (error) {
            if (
              !(error instanceof ConnectorError) ||
              error.failure.code !== 'not_found'
            )
              throw error;
          }
          if (order) {
            if (order.id !== requested) fail('invalid_response');
            emitOrder(order, await orderLines(order.id));
          }
        } else if (capability === 'orders.read') {
          const result = await page(
            'sales-orders',
            s.order,
            pageNumber,
            input.limit,
          );
          hasNext = result.hasNext;
          total = result.total;
          const linesOf = await mapConcurrent(
            result.items,
            childReadConcurrency,
            (order) => orderLines(order.id),
          );
          for (const [index, order] of result.items.entries())
            emitOrder(order, linesOf[index]!);
        } else if (capability === 'customers.read') {
          // JTL filters strictly after the given time; sync overlaps its windows.
          const result = await page(
            'customers',
            s.customer,
            pageNumber,
            input.limit,
            updatedSince ? { lastChangedAfter: updatedSince } : {},
          );
          hasNext = result.hasNext;
          total = result.total;
          for (const customer of result.items)
            emit(
              'customer',
              ref(customer.id),
              customer.lastChanged ?? null,
              customerSnapshot(customer),
            );
        } else if (capability === 'inventory.read' && filters.sku) {
          // A stock check for one SKU reads that item instead of paging the whole catalog.
          hasNext = false;
          const sku = filters.sku.externalId;
          let item: z.infer<typeof s.item> | null = null;
          try {
            item = capture(
              s.item,
              await client.request(`items/${encodeURIComponent(sku)}`),
            );
          } catch (error) {
            // An unknown item has no stock to report, as in a paged read.
            if (
              !(error instanceof ConnectorError) ||
              error.failure.code !== 'not_found'
            )
              throw error;
          }
          if (item && String(item.id) === sku)
            emitStock(item, await readStock(item));
        } else if (
          capability === 'products.read' ||
          capability === 'inventory.read'
        ) {
          const result = await page('items', s.item, pageNumber, input.limit);
          hasNext = result.hasNext;
          if (capability === 'products.read') total = result.total;
          const stocks =
            capability === 'inventory.read'
              ? await mapConcurrent(
                  result.items,
                  childReadConcurrency,
                  readStock,
                )
              : [];
          for (const [index, item] of result.items.entries()) {
            if (capability === 'products.read') {
              emit('product', ref(item.id), item.modifiedTimestamp ?? null, {
                title: item.name ?? null,
                status: item.isActive ? 'active' : 'archived',
                vendor: text(item.manufacturerName),
                published: item.isShopActive ?? null,
                skus: [
                  {
                    id: ref(item.id),
                    code: item.sKU,
                    unit: unit(item.unit),
                    title: null,
                    // Item prices carry no currency; the company currency is not readable here.
                    price:
                      item.salesPriceGross == null
                        ? null
                        : { amount: item.salesPriceGross, currency: null },
                    barcode: text(item.gTIN),
                    ...(options.purchasingTerms
                      ? { purchasingTerms: await readPurchasingTerms(item.id) }
                      : {}),
                  },
                ],
              } satisfies ProductSnapshot);
            } else emitStock(item, stocks[index]!);
          }
        } else {
          const result = await page(
            'delivery-notes',
            z.object({ id: s.id }),
            pageNumber,
            input.limit,
            filters.order
              ? { salesOrderNumberId: filters.order.externalId }
              : {},
          );
          hasNext = result.hasNext;
          const notes = await mapConcurrent(
            result.items,
            childReadConcurrency,
            async (root) => {
              const note = capture(
                s.note,
                await client.request(`delivery-notes/${root.id}`),
              );
              if (note.id !== root.id) fail('invalid_response');

              return {
                note,
                lines: await children(
                  `delivery-notes/${note.id}/line-items`,
                  s.noteLine,
                ),
                sourceLines: await orderLines(note.salesOrderId),
              };
            },
          );
          for (const { note, lines, sourceLines } of notes) {
            if (
              (filters.order &&
                String(note.salesOrderId) !== filters.order.externalId) ||
              note.packages.some((value) => value.deliveryNoteId !== note.id)
            )
              fail('invalid_response');
            const mapped = lines.map((line) => {
              const source = sourceLines.find(
                (value) => value.id === line.salesOrderLineItemId,
              );
              if (!source || line.deliveryNoteId !== note.id)
                fail('invalid_response');

              return {
                orderLine: ref(source.id, String(note.salesOrderId)),
                quantity: {
                  amount: line.quantity,
                  unit: unit(source.salesUnit),
                },
              };
            });
            // Canonical fulfillment lines are unique per order line; ambiguous duplicates cannot overwrite evidence.
            if (
              new Set(mapped.map((line) => line.orderLine.externalId)).size !==
              mapped.length
            )
              fail('invalid_response');
            const dates = note.packages.flatMap((value) =>
              value.shippingDate ? [value.shippingDate] : [],
            );
            const shipped =
              note.packages.length > 0 && dates.length === note.packages.length;
            const progress = dates.length
              ? dates.reduce((a, b) => (Date.parse(a) > Date.parse(b) ? a : b))
              : note.deliveryNoteDate;
            emit('fulfillment', ref(note.id), null, {
              order: ref(note.salesOrderId),
              status: shipped ? 'shipped' : 'processing',
              lines: mapped,
              lastProgressAt: progress,
              progressBasis: 'note_created_or_package_shipped',
              failureCode: null,
              kind: 'shipment',
              // Packages name a shipping method key, not a carrier.
              tracking: note.packages
                .map((value) => ({
                  carrier: null,
                  number: text(value.trackingNumber ?? value.trackingID),
                  url: trackingLink(value.trackingUrl),
                }))
                .filter((value) => value.number || value.url),
            });
          }
        }
        const sourceKeys = observations.map((value) =>
          JSON.stringify([
            value.source.resource,
            value.source.externalId,
            value.source.scopeKey,
          ]),
        );
        if (new Set(sourceKeys).size !== sourceKeys.length)
          fail('invalid_response');
        const result = parse<unknown>(outputs[capability], {
          items: observations,
          nextCursor: hasNext
            ? Buffer.from(
                JSON.stringify({ binding, page: pageNumber + 1 }),
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
          observations: result.items,
          ...(options.rawRetentionMs === undefined
            ? {}
            : {
                raw: {
                  payloads,
                  expiresAt: new Date(
                    now().getTime() + options.rawRetentionMs,
                  ).toISOString(),
                },
              }),
        });

        return result;
      },
    };
  }

  return {
    tenantId: options.tenantId,
    id: options.connectionId,
    provider: 'jtl',
    status: 'active',
    adapterVersion,
    mechanism: 'api',
    executor: { kind: 'connector', id: adapterVersion },
    capabilities: {
      ...(options.shippingMethodActions
        ? createJtlShippingMethodCapabilities(options)
        : {}),
      ...createJtlPurchaseOrderCapabilities(options),
      ...createJtlReturnCapabilities(options),
      ...createJtlSettlementCapabilities(options),
      'returns.exchange.reservation.read': createExchangeReservation(options),
      'orders.read': handler('orders.read'),
      'products.read': handler('products.read'),
      'inventory.read': handler('inventory.read'),
      'fulfillment.read': handler('fulfillment.read'),
      ...(options.customers
        ? { 'customers.read': handler('customers.read') }
        : {}),
    },
  };
}

// Blank or oversized contact text is treated as not provided rather than truncated.
const bounded = (value: string | null | undefined, max: number) => {
  const trimmed = value?.trim();

  return trimmed && trimmed.length <= max ? trimmed : null;
};

/**
 * Maps a JTL customer to Luma's profile. JTL has no separate consent for contact and address
 * data, so the connection's customer grant shares both. Order count and spend are not reported.
 */
function customerSnapshot(
  customer: z.infer<typeof s.customer>,
): CustomerSnapshot {
  const person = bounded(
    [customer.firstName?.trim(), customer.lastName?.trim()]
      .filter(Boolean)
      .join(' '),
    512,
  );
  const company = bounded(customer.companyName, 512);
  const address = {
    line1: bounded(customer.street, 512),
    line2: bounded(customer.additionalAddressLine, 512),
    city: bounded(customer.city, 256),
    region: bounded(customer.state, 256),
    postalCode: bounded(customer.postalCode, 64),
    country:
      bounded(customer.countryIso, 128) ?? bounded(customer.countryName, 128),
  };

  return {
    displayName:
      person && company
        ? bounded(`${person} (${company})`, 512)
        : (person ?? company),
    email: bounded(customer.emailAddress, 320),
    phone:
      bounded(customer.phoneNumber, 100) ??
      bounded(customer.mobilePhoneNumber, 100),
    address: Object.values(address).some(Boolean) ? address : null,
    state: customer.isLocked ? 'disabled' : 'enabled',
    createdAt: customer.createdDate ?? null,
    orderCount: null,
    amountSpent: null,
    tags: [
      ...new Set(
        (customer.labels ?? '')
          .split(',')
          .map((label) => label.trim())
          .filter((label) => label.length > 0 && label.length <= 255),
      ),
    ].slice(0, 250),
    shared: { contact: true, address: true },
  };
}

/**
 * Child reads (order lines, delivery notes, warehouse stock) in flight per page. ERP 2.2
 * publishes no request quota, so the bound stays small; transports still honor `Retry-After`.
 */
const childReadConcurrency = 4;

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
