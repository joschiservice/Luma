import { createHash, randomUUID } from 'node:crypto';

import {
  type CapabilityHandler,
  type CapabilityInput,
  type CapabilityOutput,
  type ConnectorConnection,
  type CustomerSnapshot,
  type ExternalId,
  type FulfillmentSnapshot,
  type HistoryLimit,
  type Observation,
  type OrderSnapshot,
  type Page,
  type ProductSnapshot,
  type ReadCapability,
  type RefundSnapshot,
  type ReturnSnapshot,
  type SourceIdentity,
} from '@luma/connections';
import type { ShopifyTransportOptions } from '@luma/connector-shopify';
import {
  API_VERSION,
  createClient,
  fail,
  parse,
} from '@luma/connector-shopify';
import { z } from 'zod';

import { readBulkHistory } from './bulk-history.js';
import { readPageSize, readSelection } from './read-selections.js';
import * as s from './schemas.js';

const pageFields = 'pageInfo { hasNextPage endCursor }';

const ref = (externalId: string, scopeKey = ''): ExternalId => ({
  externalId,
  scopeKey,
});

const quantity = (value: number) => ({ amount: String(value), unit: 'each' });

// Blank or oversized source text is treated as not provided rather than truncated.
const text = (value: string | null | undefined, max = 512) => {
  const trimmed = value?.trim();

  return trimmed && trimmed.length <= max ? trimmed : null;
};

const record = z.record(z.unknown());

const statusFrom = <T extends string>(
  mapping: Record<string, T>,
  value: string,
): T | 'unknown' =>
  Object.hasOwn(mapping, value) ? (mapping[value] ?? 'unknown') : 'unknown';

const paymentStatuses: Record<string, OrderSnapshot['paymentStatus']> = {
  PENDING: 'pending',
  AUTHORIZED: 'authorized',
  PAID: 'paid',
  PARTIALLY_REFUNDED: 'partially_refunded',
  REFUNDED: 'refunded',
};

const workStatuses: Record<string, FulfillmentSnapshot['status']> = {
  OPEN: 'pending',
  SCHEDULED: 'pending',
  ON_HOLD: 'pending',
  IN_PROGRESS: 'processing',
  CLOSED: 'completed',
  CANCELLED: 'cancelled',
  INCOMPLETE: 'failed',
};

// Unlisted products stay unknown: they sell by direct link but are hidden from the storefront.
const productStatuses: Record<string, ProductSnapshot['status']> = {
  ACTIVE: 'active',
  DRAFT: 'draft',
  ARCHIVED: 'archived',
};

const returnStatuses: Record<string, ReturnSnapshot['status']> = {
  REQUESTED: 'requested',
  OPEN: 'open',
  CLOSED: 'closed',
  DECLINED: 'declined',
  CANCELED: 'cancelled',
};

const declineReasons: Record<
  string,
  NonNullable<ReturnSnapshot['declineReason']>
> = {
  RETURN_PERIOD_ENDED: 'return_period_ended',
  FINAL_SALE: 'final_sale',
};

const restockTypes: Record<string, RefundSnapshot['lines'][number]['restock']> =
  {
    RETURN: 'return',
    CANCEL: 'cancel',
    NO_RESTOCK: 'no_restock',
  };

// Only a successful refund transaction returned money; awaiting a response is still pending.
const transactionStatuses: Record<
  string,
  RefundSnapshot['transactions'][number]['status']
> = {
  SUCCESS: 'success',
  PENDING: 'pending',
  AWAITING_RESPONSE: 'pending',
  FAILURE: 'failed',
  ERROR: 'failed',
};

const customerStates: Record<string, CustomerSnapshot['state']> = {
  ENABLED: 'enabled',
  DISABLED: 'disabled',
  INVITED: 'invited',
  DECLINED: 'declined',
};

// Without read_all_orders, Shopify returns orders created in the last 60 days.
const recentOrderWindowMs = 60 * 24 * 60 * 60 * 1000;

const counted = {
  'orders.read': 'ordersCount',
  'products.read': 'productsCount',
  'customers.read': 'customersCount',
} as const;

const shipmentStatuses: Record<string, FulfillmentSnapshot['status']> = {
  PENDING: 'pending',
  OPEN: 'processing',
  SUCCESS: 'shipped',
  CANCELLED: 'cancelled',
  ERROR: 'failed',
  FAILURE: 'failed',
};

const holdReasons: Record<
  string,
  NonNullable<FulfillmentSnapshot['holds']>[number]['reason']
> = {
  AWAITING_PAYMENT: 'awaiting_payment',
  HIGH_RISK_OF_FRAUD: 'high_risk_of_fraud',
  INCORRECT_ADDRESS: 'incorrect_address',
  INVENTORY_OUT_OF_STOCK: 'inventory_out_of_stock',
  UNKNOWN_DELIVERY_DATE: 'unknown_delivery_date',
  AWAITING_RETURN_ITEMS: 'awaiting_return_items',
};

const methodTypes: Record<
  string,
  NonNullable<FulfillmentSnapshot['method']>['type']
> = {
  SHIPPING: 'shipping',
  PICK_UP: 'pick_up',
  PICKUP_POINT: 'pickup_point',
  LOCAL: 'local',
  RETAIL: 'retail',
  NONE: 'none',
};

// Label and confirmation states say nothing about the carrier; they stay unreported.
const deliveryStates: Record<
  string,
  NonNullable<FulfillmentSnapshot['delivery']>
> = {
  LABEL_PRINTED: 'label_created',
  LABEL_PURCHASED: 'label_created',
  CARRIER_PICKED_UP: 'in_transit',
  IN_TRANSIT: 'in_transit',
  OUT_FOR_DELIVERY: 'out_for_delivery',
  ATTEMPTED_DELIVERY: 'attempted_delivery',
  DELAYED: 'delayed',
  READY_FOR_PICKUP: 'ready_for_pickup',
  DELIVERED: 'delivered',
  PICKED_UP: 'delivered',
  FAILURE: 'failed',
  NOT_DELIVERED: 'failed',
};

// Only absolute web links are kept; anything else is treated as not provided.
const trackingUrl = (value: string | null | undefined) => {
  const url = text(value, 2048);
  if (!url) return null;
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol) ? url : null;
  } catch {
    return null;
  }
};

export interface ShopifyEvidence {
  tenantId: string;
  connectionId: string;
  apiVersion: typeof API_VERSION;
  capability: ReadCapability;
  observations: Observation<unknown>[];
  /** Allowlisted provider fields only. Storage must encrypt bytes and enforce tenant access and expiry. */
  raw?: { payloads: unknown[]; expiresAt: string };
}

export interface ShopifyConnectorOptions extends ShopifyTransportOptions {
  tenantId: string;
  connectionId: string;
  /**
   * Enables `customers.read` for deployments approved for protected customer data. Contact
   * (name, email, phone) and address fields are read only when approved separately.
   */
  customerAccess?: { contact: boolean; address: boolean };
  /** Persist the batch before it is returned. Throw if durable recording fails. */
  recordObservations(evidence: ShopifyEvidence): Promise<void>;
  rawRetentionMs?: number;
  now?: () => Date;
  id?: () => string;
}

/** Compose with a resolver that checks current ownership and connection state on each invocation. */
export function createShopifyConnector(
  options: ShopifyConnectorOptions,
): ConnectorConnection {
  if (!options.tenantId || !options.connectionId) fail('invalid_input');
  if (
    options.rawRetentionMs !== undefined &&
    (!Number.isSafeInteger(options.rawRetentionMs) ||
      options.rawRetentionMs <= 0)
  )
    fail('invalid_input');
  const request = createClient(options);
  const now = options.now ?? (() => new Date());
  const id = options.id ?? randomUUID;

  function handler<
    K extends Exclude<
      ReadCapability,
      'orders.shipping-method.read' | 'suppliers.read' | 'purchase-orders.read'
    >,
  >(capability: K): CapabilityHandler<K> {
    return {
      descriptor: {
        version: '0',
        minimumRisk: 'low',
        idempotency: 'none',
        retry: { maxAttempts: 3, initialDelayMs: 1000 },
        ...(capability === 'inventory.read'
          ? { filters: ['historyImport' as const] }
          : {
              filters: [
                'updatedSince' as const,
                ...(capability === 'orders.read' ||
                capability === 'fulfillment.read' ||
                capability === 'returns.read'
                  ? ['createdSince' as const]
                  : []),
                ...(capability === 'orders.read' ||
                capability === 'products.read' ||
                capability === 'customers.read'
                  ? ['historyImport' as const]
                  : []),
              ],
            }),
      },
      parseInput: (input) =>
        s.inputs[capability].parse(input) as CapabilityInput<K>,
      parseOutput: (output) =>
        s.outputs[capability].parse(output) as CapabilityOutput<K>,
      async run(context, input) {
        if (
          context.tenant.tenantId !== options.tenantId ||
          context.connectionId !== options.connectionId ||
          context.provider !== 'shopify'
        )
          fail('unavailable');
        const filters = input as CapabilityInput<'inventory.read'> &
          CapabilityInput<'fulfillment.read'>;
        const updatedSince =
          'updatedSince' in input ? (input.updatedSince ?? null) : null;
        const createdSince =
          'createdSince' in input ? (input.createdSince ?? null) : null;
        const historyImport =
          'historyImport' in input ? input.historyImport : undefined;
        const binding = createHash('sha256')
          .update(
            JSON.stringify([
              options.tenantId,
              options.connectionId,
              options.shop,
              API_VERSION,
              capability,
              // The effective page size, so cursors survive a larger requested page.
              readPageSize(capability, input.limit),
              filters.sku ?? null,
              filters.location ?? null,
              filters.order ?? null,
              updatedSince,
              createdSince,
              historyImport?.key ?? null,
              historyImport?.chunkSize ?? null,
            ]),
          )
          .digest('hex');
        let after: string | null = null;
        if (input.cursor) {
          try {
            const cursor = z
              .object({ binding: z.literal(binding), after: z.string().min(1) })
              .strict()
              .parse(
                JSON.parse(
                  Buffer.from(input.cursor, 'base64url').toString('utf8'),
                ),
              );
            after = cursor.after;
          } catch {
            fail('invalid_input');
          }
        }
        const payloads: unknown[] = [];
        // Parse before capture so unexpected fields, customer details and provider errors cannot enter evidence.
        const capture = <T>(
          schema: z.ZodType<T, z.ZodTypeDef, unknown>,
          value: unknown,
        ): T => {
          const parsed = parse(schema, value);
          if (options.rawRetentionMs !== undefined) payloads.push(parsed);

          return parsed;
        };
        let observedAt = now().toISOString();
        const items: Observation<unknown>[] = [];

        function emit(
          resource: SourceIdentity['resource'],
          external: ExternalId,
          updatedAt: string | null,
          data: unknown,
        ) {
          items.push({
            id: id(),
            source: {
              ...external,
              tenantId: options.tenantId,
              connectionId: options.connectionId,
              provider: 'shopify',
              resource,
            },
            kind: 'snapshot',
            observedAt,
            sourceUpdatedAt: updatedAt,
            sourceRevision: null,
            adapterVersion: s.adapterVersion,
            schemaVersion: 1,
            data,
          });
        }

        // Cache only this page. Consumers validate and allowlist each record before capture.
        const nested = new Map<string, Record<string, unknown>>();

        function remember(value: unknown): void {
          if (Array.isArray(value)) {
            for (const item of value) remember(item);
          } else if (value && typeof value === 'object') {
            const fields = parse(record, value);
            if (typeof fields.id === 'string')
              nested.set(fields.id, { ...nested.get(fields.id), ...fields });
            for (const child of Object.values(fields)) remember(child);
          }
        }

        async function node<T>(
          externalId: string,
          type: string,
          fields: string,
          schema: z.ZodType<T, z.ZodTypeDef, unknown>,
        ): Promise<T> {
          const cached = nested.get(externalId);
          // Overflow pages may cache an ID-only reference; fetch its full selection.
          if (cached && Object.keys(cached).length > 1)
            return capture(schema, cached);
          const data = await request(
            `query LumaNode($id: ID!) { node(id: $id) { ... on ${type} { ${fields} } } }`,
            { id: externalId },
          );
          if (data.node === null) fail('not_found');

          return capture(schema, data.node);
        }

        async function children<T>(
          externalId: string,
          type: string,
          field: string,
          fields: string,
          schema: z.ZodType<T, z.ZodTypeDef, unknown>,
        ): Promise<T[]> {
          const result: T[] = [];
          let cursor: string | null = null;
          const initial = nested.get(externalId)?.[field];
          if (initial !== undefined) {
            const page = capture(s.connection(schema), initial);
            result.push(...page.nodes);
            cursor = next(page.pageInfo);
            if (!cursor) return result;
          }
          const seen = new Set<string>(cursor ? [cursor] : []);
          do {
            const data = await request(
              `query LumaChildren($id: ID!, $after: String) { node(id: $id) { ... on ${type} { children: ${field}(first: 100, after: $after) { nodes { ${fields} } ${pageFields} } } } }`,
              { id: externalId, after: cursor },
            );
            if (data.node === null) fail('not_found');
            remember(data.node);
            const parent = parse(record, data.node);
            const page = capture(s.connection(schema), parent.children);
            result.push(...page.nodes);
            cursor = next(page.pageInfo);
            if (cursor && seen.has(cursor)) fail('invalid_response');
            if (cursor) seen.add(cursor);
            // Bound malformed or unexpectedly large scans; never return a truncated snapshot.
            if (seen.size > 1000) fail('invalid_response');
          } while (cursor);

          return result;
        }

        const root =
          capability === 'products.read'
            ? 'products'
            : capability === 'inventory.read'
              ? 'inventoryItems'
              : capability === 'customers.read'
                ? 'customers'
                : 'orders';
        const rootType =
          root === 'products'
            ? 'Product'
            : root === 'inventoryItems'
              ? 'InventoryItem'
              : 'Order';
        const selected = filters.sku ?? filters.order;
        // Timestamps are validated ISO values, so quoting cannot add search operators.
        const search =
          [
            updatedSince ? `updated_at:>='${updatedSince}'` : null,
            createdSince ? `created_at:>='${createdSince}'` : null,
          ]
            .filter(Boolean)
            .join(' ') || null;
        const sorted = createdSince
          ? ', sortKey: CREATED_AT, reverse: true'
          : updatedSince
            ? ', sortKey: UPDATED_AT'
            : '';
        let total: number | null | undefined;
        let history: HistoryLimit | null | undefined;
        const bulk = historyImport
          ? await readBulkHistory({
              request,
              fetch: options.fetch ?? globalThis.fetch,
              capability,
              key: historyImport.key,
              cursor: after,
              limit: historyImport.chunkSize ?? input.limit,
              ...(options.customerAccess
                ? { customerAccess: options.customerAccess }
                : {}),
            })
          : null;
        const encode = (cursor: string | null) =>
          cursor
            ? Buffer.from(JSON.stringify({ binding, after: cursor })).toString(
                'base64url',
              )
            : null;
        if (bulk?.deferred)
          return parse<unknown>(s.outputs[capability], {
            items: [],
            nextCursor: encode(bulk.cursor),
            completeness: 'complete',
            deferred: true,
            retryAfterMs: 2000,
          }) as CapabilityOutput<K>;
        // Export records reflect the shop when the export started, not when Luma reads the file.
        if (bulk?.snapshotAt) observedAt = bulk.snapshotAt;

        // The first page of a scan reports the collection size and any history limit.
        if (
          (!after || bulk?.offset === 0) &&
          !selected &&
          capability !== 'inventory.read'
        ) {
          const countField =
            capability in counted
              ? counted[capability as keyof typeof counted]
              : null;
          const start = parse(
            s.scanStart,
            await request(
              countField
                ? `query LumaScanStart($query: String) { currentAppInstallation { accessScopes { handle } } count: ${countField}(query: $query, limit: null) { count precision } }`
                : 'query LumaScanStart { currentAppInstallation { accessScopes { handle } } }',
              countField ? { query: search } : {},
            ),
          );
          total = start.count?.count ?? null;
          if (root === 'orders')
            history = start.currentAppInstallation.accessScopes.some(
              (scope) => scope.handle === 'read_all_orders',
            )
              ? null
              : {
                  availableFrom: new Date(
                    now().getTime() - recentOrderWindowMs,
                  ).toISOString(),
                  requirement: 'read_all_orders',
                };
        }
        let roots: { id: string }[];
        let nextAfter: string | null = null;
        if (capability === 'customers.read') {
          const access = options.customerAccess;
          if (!access) fail('unsupported_capability');
          const fields = [
            'id createdAt updatedAt state numberOfOrders amountSpent { amount currencyCode } tags',
            access.contact
              ? 'displayName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber }'
              : '',
            access.address
              ? 'defaultAddress { address1 address2 city province zip countryCodeV2 }'
              : '',
          ].join(' ');
          const data = bulk
            ? {
                page: {
                  nodes: bulk.nodes,
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              }
            : await request(
                `query LumaCustomers($first: Int!, $after: String, $query: String) { page: customers(first: $first, after: $after, query: $query${sorted}) { nodes { ${fields} } ${pageFields} } }`,
                {
                  first: readPageSize(capability, input.limit),
                  after,
                  query: search,
                },
              );
          const customers = capture(s.connection(s.customerNode), data.page);
          for (const customer of customers.nodes) {
            const address = access.address ? customer.defaultAddress : null;
            const money = customer.amountSpent;
            emit('customer', ref(customer.id), customer.updatedAt, {
              displayName: access.contact ? text(customer.displayName) : null,
              email: access.contact
                ? text(customer.defaultEmailAddress?.emailAddress, 320)
                : null,
              phone: access.contact
                ? text(customer.defaultPhoneNumber?.phoneNumber, 100)
                : null,
              address: address
                ? {
                    line1: text(address.address1),
                    line2: text(address.address2),
                    city: text(address.city, 256),
                    region: text(address.province, 256),
                    postalCode: text(address.zip, 64),
                    country: text(address.countryCodeV2, 128),
                  }
                : null,
              state: statusFrom(customerStates, customer.state),
              createdAt: customer.createdAt,
              orderCount: customer.numberOfOrders,
              amountSpent:
                /^-?\d{1,14}(\.\d{1,6})?$/.test(money.amount) &&
                /^[A-Z]{3}$/.test(money.currencyCode)
                  ? { amount: money.amount, currency: money.currencyCode }
                  : null,
              tags: customer.tags
                .map((tag) => tag.trim())
                .filter((tag) => tag.length > 0 && tag.length <= 255)
                .slice(0, 250),
              shared: { contact: access.contact, address: access.address },
            } satisfies CustomerSnapshot);
          }
          roots = [];
          nextAfter = bulk ? bulk.cursor : next(customers.pageInfo);
          if (nextAfter && nextAfter === after) fail('invalid_response');
        } else if (bulk) {
          remember(bulk.nodes);
          roots = bulk.nodes.map((value) => ({
            id: parse(s.gid(rootType), value.id),
          }));
          nextAfter = bulk.cursor;
          total = capability === 'inventory.read' ? undefined : bulk.total;
        } else if (selected) {
          if (after) fail('invalid_input');
          roots = [{ id: selected.externalId }];
        } else {
          const fields = readSelection(capability);
          const data = await request(
            root === 'inventoryItems'
              ? `query LumaPage($first: Int!, $after: String) { page: ${root}(first: $first, after: $after) { nodes { ${fields} } ${pageFields} } }`
              : `query LumaPage($first: Int!, $after: String, $query: String) { page: ${root}(first: $first, after: $after, query: $query${sorted}) { nodes { ${fields} } ${pageFields} } }`,
            root === 'inventoryItems'
              ? { first: readPageSize(capability, input.limit), after }
              : {
                  first: readPageSize(capability, input.limit),
                  after,
                  query: search,
                },
          );
          const page = parse(s.connection(record), data.page);
          remember(page.nodes);
          roots = page.nodes.map((value) => ({
            id: parse(s.gid(rootType), value.id),
          }));
          nextAfter = next(page.pageInfo);
          if (nextAfter && nextAfter === after) fail('invalid_response');
        }
        for (const parent of roots) {
          if (capability === 'orders.read') {
            const order = await node(
              parent.id,
              'Order',
              'id updatedAt createdAt name cancelledAt closed displayFinancialStatus currentTotalPriceSet { shopMoney { amount currencyCode } }',
              s.order,
            );
            const lines = await children(
              parent.id,
              'Order',
              'lineItems',
              'id quantity name sku variant { inventoryItem { id } }',
              s.orderLine,
            );
            const total = order.currentTotalPriceSet?.shopMoney;
            emit('order', ref(order.id), order.updatedAt, {
              displayNumber: order.name,
              placedAt: order.createdAt ?? null,
              total: total
                ? { amount: total.amount, currency: total.currencyCode }
                : null,
              status: order.cancelledAt
                ? 'cancelled'
                : order.closed
                  ? 'completed'
                  : 'open',
              paymentStatus: statusFrom(
                paymentStatuses,
                order.displayFinancialStatus ?? '',
              ),
              lines: lines.map((line) => ({
                id: ref(line.id, order.id),
                sku: line.variant ? ref(line.variant.inventoryItem.id) : null,
                quantity: quantity(line.quantity),
                cancelledQuantity: null,
                skuCode: text(line.sku),
                title: text(line.name),
              })),
            });
          } else if (capability === 'products.read') {
            const product = await node(
              parent.id,
              'Product',
              'id updatedAt title status vendor publishedAt priceRangeV2 { minVariantPrice { currencyCode } }',
              s.product,
            );
            const variants = await children(
              parent.id,
              'Product',
              'variants',
              'id sku title price barcode inventoryItem { id }',
              s.variant,
            );
            const currency =
              product.priceRangeV2?.minVariantPrice.currencyCode ?? null;
            emit('product', ref(product.id), product.updatedAt, {
              title: product.title,
              status: statusFrom(productStatuses, product.status),
              vendor: text(product.vendor),
              // Only an Online Store publication has a publication time readable with read_products.
              published: product.publishedAt != null,
              skus: variants.map((variant) => ({
                id: ref(variant.inventoryItem.id),
                code: variant.sku,
                unit: 'each',
                // Shopify names the only variant of a product "Default Title".
                title:
                  variant.title === 'Default Title'
                    ? null
                    : text(variant.title),
                price:
                  variant.price == null
                    ? null
                    : { amount: variant.price, currency },
                barcode: text(variant.barcode),
              })),
            } satisfies ProductSnapshot);
          } else if (capability === 'inventory.read') {
            const item = await node(
              parent.id,
              'InventoryItem',
              'id tracked',
              s.inventoryItem,
            );
            const levels = await children(
              parent.id,
              'InventoryItem',
              'inventoryLevels',
              'id updatedAt location { id } quantities(names: ["on_hand", "committed", "available"]) { name quantity }',
              s.level,
            );
            for (const level of levels) {
              if (
                filters.location &&
                filters.location.externalId !== level.location.id
              )
                continue;
              const values = new Map(
                level.quantities.map((value) => [
                  value.name,
                  String(value.quantity),
                ]),
              );
              if (values.size !== level.quantities.length)
                fail('invalid_response');
              const value = (key: string) =>
                item.tracked ? (values.get(key) ?? null) : null;
              const available = value('available');
              emit('sku', ref(item.id, level.location.id), level.updatedAt, {
                sku: ref(item.id),
                location: ref(level.location.id),
                unit: 'each',
                onHand: value('on_hand'),
                reserved: value('committed'),
                available,
                availabilityBasis:
                  available === null ? 'unknown' : 'provider_reported',
              });
            }
          } else if (capability === 'returns.read') {
            await readReturns(parent.id);
          } else {
            const work = await children(
              parent.id,
              'Order',
              'fulfillmentOrders',
              'id updatedAt status fulfillAt fulfillBy fulfillmentHolds { reason } assignedLocation { name location { id } } deliveryMethod { methodType presentedName }',
              s.fulfillmentOrder,
            );
            for (const operation of work) {
              const lines = await children(
                operation.id,
                'FulfillmentOrder',
                'lineItems',
                'id totalQuantity lineItem { id }',
                s.fulfillmentOrderLine,
              );
              const holds = (operation.fulfillmentHolds ?? []).map((hold) => ({
                reason: holdReasons[hold.reason] ?? 'other',
              }));
              const assigned = operation.assignedLocation;
              const method = operation.deliveryMethod;
              emit('fulfillment', ref(operation.id), operation.updatedAt, {
                order: ref(parent.id),
                status: statusFrom(workStatuses, operation.status),
                lines: lines.map((line) => ({
                  orderLine: ref(line.lineItem.id, parent.id),
                  quantity: quantity(line.totalQuantity),
                })),
                lastProgressAt: operation.updatedAt,
                progressBasis: 'source_updated',
                failureCode:
                  operation.status === 'INCOMPLETE' ? 'incomplete' : null,
                kind: 'fulfillment_order',
                // An ON_HOLD status without a readable hold still blocks the work.
                holds:
                  !holds.length && operation.status === 'ON_HOLD'
                    ? [{ reason: 'other' }]
                    : holds,
                location: assigned?.location
                  ? {
                      id: ref(assigned.location.id),
                      name: text(assigned.name),
                    }
                  : null,
                fulfillAt: operation.fulfillAt ?? null,
                fulfillBy: operation.fulfillBy ?? null,
                method: method
                  ? {
                      type: methodTypes[method.methodType] ?? 'unknown',
                      name: text(method.presentedName),
                    }
                  : null,
              } satisfies FulfillmentSnapshot);
            }
            // Order.fulfillments is an unpaginated list. Omit `first` to avoid silently truncating shipments.
            const order = await node(
              parent.id,
              'Order',
              'fulfillments { id updatedAt status deliveredAt inTransitAt displayStatus estimatedDeliveryAt location { id name } trackingInfo(first: 10) { company number url } }',
              z.object({ fulfillments: z.array(s.fulfillment) }),
            );
            for (const shipment of order.fulfillments) {
              const lines = await children(
                shipment.id,
                'Fulfillment',
                'fulfillmentLineItems',
                'id quantity lineItem { id }',
                s.fulfillmentLine,
              );
              const status = statusFrom(shipmentStatuses, shipment.status);
              emit('fulfillment', ref(shipment.id), shipment.updatedAt, {
                order: ref(parent.id),
                status:
                  status === 'shipped' && shipment.deliveredAt
                    ? 'delivered'
                    : status,
                lines: lines.map((line) => ({
                  orderLine: ref(line.lineItem.id, parent.id),
                  quantity: quantity(line.quantity),
                })),
                progressBasis: 'source_updated',
                lastProgressAt:
                  shipment.deliveredAt ??
                  shipment.inTransitAt ??
                  shipment.updatedAt,
                failureCode: status === 'failed' ? 'fulfillment_failed' : null,
                kind: 'shipment',
                location: shipment.location
                  ? {
                      id: ref(shipment.location.id),
                      name: text(shipment.location.name),
                    }
                  : null,
                estimatedDeliveryAt: shipment.estimatedDeliveryAt ?? null,
                tracking: (shipment.trackingInfo ?? [])
                  .map((entry) => ({
                    carrier: text(entry.company),
                    number: text(entry.number),
                    url: trackingUrl(entry.url),
                  }))
                  .filter((entry) => entry.number || entry.url),
                delivery: shipment.deliveredAt
                  ? 'delivered'
                  : (deliveryStates[shipment.displayStatus ?? ''] ?? null),
              } satisfies FulfillmentSnapshot);
            }
          }
        }

        /** Emits an order's returns, then its refunds, which may refer to them. */
        async function readReturns(orderId: string) {
          const order = ref(orderId);
          const returns = await children(
            orderId,
            'Order',
            'returns',
            'id name status createdAt requestApprovedAt closedAt decline { reason }',
            s.returnNode,
          );
          for (const item of returns) {
            const lines = await children(
              item.id,
              'Return',
              'returnLineItems',
              'id quantity refundedQuantity returnReasonDefinition { name } ... on ReturnLineItem { fulfillmentLineItem { id lineItem { id } } withCodeDiscountedTotalPriceSet { shopMoney { amount currencyCode } } }',
              s.returnLine,
            );
            // Dispositions record what came back; MISSING units were not received.
            const receipts = new Map<
              string,
              { received: number; restocked: number }
            >();
            let receivedAt: string | null = null;
            for (const reverse of await children(
              item.id,
              'Return',
              'reverseFulfillmentOrders',
              'id status',
              s.reverseFulfillmentOrder,
            ))
              for (const line of await children(
                reverse.id,
                'ReverseFulfillmentOrder',
                'lineItems',
                'id fulfillmentLineItem { id } dispositions { type quantity createdAt }',
                s.reverseLine,
              )) {
                if (!line.fulfillmentLineItem) continue;
                const receipt = receipts.get(line.fulfillmentLineItem.id) ?? {
                  received: 0,
                  restocked: 0,
                };
                for (const disposition of line.dispositions) {
                  if (disposition.type === 'MISSING') continue;
                  receipt.received += disposition.quantity;
                  if (disposition.type === 'RESTOCKED')
                    receipt.restocked += disposition.quantity;
                  if (
                    !receivedAt ||
                    Date.parse(disposition.createdAt) > Date.parse(receivedAt)
                  )
                    receivedAt = disposition.createdAt;
                }
                receipts.set(line.fulfillmentLineItem.id, receipt);
              }
            const status = statusFrom(returnStatuses, item.status);
            emit('return', ref(item.id), null, {
              type: 'return',
              order,
              name: text(item.name),
              status,
              requestedAt: item.createdAt ?? null,
              approvedAt: item.requestApprovedAt ?? null,
              closedAt: item.closedAt ?? null,
              declineReason: item.decline
                ? (declineReasons[item.decline.reason] ?? 'other')
                : null,
              receivedAt,
              lines: lines
                .filter((line) => line.quantity > 0)
                .map((line) => {
                  const fulfilled = line.fulfillmentLineItem;
                  const receipt = fulfilled
                    ? (receipts.get(fulfilled.id) ?? {
                        received: 0,
                        restocked: 0,
                      })
                    : null;
                  const value = line.withCodeDiscountedTotalPriceSet?.shopMoney;

                  return {
                    orderLine: fulfilled
                      ? ref(fulfilled.lineItem.id, orderId)
                      : null,
                    quantity: quantity(line.quantity),
                    reason: text(line.returnReasonDefinition?.name),
                    receivedQuantity: receipt ? String(receipt.received) : null,
                    restockedQuantity: receipt
                      ? String(receipt.restocked)
                      : null,
                    refundedQuantity:
                      line.refundedQuantity == null
                        ? null
                        : String(line.refundedQuantity),
                    value: value
                      ? { amount: value.amount, currency: value.currencyCode }
                      : null,
                  };
                }),
            } satisfies ReturnSnapshot);
          }
          // Order.refunds is an unpaginated list. Omit `first` to avoid silently truncating refunds.
          const { refunds } = await node(
            orderId,
            'Order',
            'refunds { id createdAt updatedAt totalRefundedSet { shopMoney { amount currencyCode } } return { id } }',
            z.object({ refunds: z.array(s.refundNode) }),
          );
          for (const refund of refunds) {
            const lines = await children(
              refund.id,
              'Refund',
              'refundLineItems',
              'quantity restockType restocked lineItem { id }',
              s.refundLine,
            );
            const transactions = await children(
              refund.id,
              'Refund',
              'transactions',
              'id kind status processedAt gateway amountSet { shopMoney { amount currencyCode } }',
              s.refundTransaction,
            );
            const total = refund.totalRefundedSet?.shopMoney;
            emit('refund', ref(refund.id), refund.updatedAt, {
              type: 'refund',
              order,
              return: refund.return ? ref(refund.return.id) : null,
              createdAt: refund.createdAt,
              total: total
                ? { amount: total.amount, currency: total.currencyCode }
                : null,
              lines: lines
                .filter((line) => line.quantity > 0)
                .map((line) => ({
                  orderLine: ref(line.lineItem.id, orderId),
                  quantity: quantity(line.quantity),
                  restock: statusFrom(restockTypes, line.restockType),
                  restocked: line.restocked,
                })),
              transactions: transactions
                .filter((transaction) => transaction.kind === 'REFUND')
                .map((transaction) => ({
                  status: statusFrom(transactionStatuses, transaction.status),
                  amount: {
                    amount: transaction.amountSet.shopMoney.amount,
                    currency: transaction.amountSet.shopMoney.currencyCode,
                  },
                  processedAt: transaction.processedAt,
                  gateway: text(transaction.gateway),
                })),
            } satisfies RefundSnapshot);
          }
        }

        const result: Page<unknown> = {
          items,
          nextCursor: encode(nextAfter),
          completeness: 'complete',
          retryAfterMs: request.nextReadDelay(),
          ...(total === undefined ? {} : { total }),
          ...(history === undefined ? {} : { history }),
        };
        const validated = parse<unknown>(
          s.outputs[capability],
          result,
        ) as CapabilityOutput<K>;
        await options.recordObservations({
          tenantId: options.tenantId,
          connectionId: options.connectionId,
          apiVersion: API_VERSION,
          capability,
          observations: validated.items,
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

        return validated;
      },
    };
  }

  return {
    tenantId: options.tenantId,
    id: options.connectionId,
    provider: 'shopify',
    status: 'active',
    adapterVersion: s.adapterVersion,
    mechanism: 'api',
    executor: { kind: 'connector', id: s.adapterVersion },
    capabilities: {
      'orders.read': handler('orders.read'),
      'products.read': handler('products.read'),
      'inventory.read': handler('inventory.read'),
      'fulfillment.read': handler('fulfillment.read'),
      'returns.read': handler('returns.read'),
      ...(options.customerAccess
        ? { 'customers.read': handler('customers.read') }
        : {}),
    },
  };
}

function next(page: z.infer<typeof s.pageInfo>): string | null {
  if (page.hasNextPage && !page.endCursor) fail('invalid_response');

  return page.hasNextPage ? page.endCursor : null;
}
