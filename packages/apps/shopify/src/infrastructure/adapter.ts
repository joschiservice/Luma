import { createHash, randomUUID } from 'node:crypto';

import {
  type CapabilityHandler,
  type CapabilityInput,
  type CapabilityOutput,
  type ConnectorConnection,
  type HistoryLimit,
  type Observation,
  type Page,
  type ReadCapability,
} from '@luma/connections';
import type { ShopifyTransportOptions } from '@luma/connector-shopify';
import {
  API_VERSION,
  createClient,
  createCursorCodec,
  fail,
  parse,
} from '@luma/connector-shopify';
import { z } from 'zod';

import { readBulkHistory } from './bulk-history.js';
import { createBundleReader } from './bundles.js';
import { readCustomers } from './customer-reads.js';
import { confirmDeletion } from './deletion-confirmation.js';
import { readFulfillments } from './fulfillment-reads.js';
import { readInventoryItem } from './inventory-reads.js';
import { createInventoryTransferCapabilities } from './inventory-transfers.js';
import {
  attributeInventoryWrites,
  type InventoryWriteReceipt,
} from './inventory-write-attribution.js';
import { orderHistory, readOrder } from './order-reads.js';
import { readProduct } from './product-reads.js';
import { readPageSize, readSelection } from './read-selections.js';
import {
  createReadSession,
  next,
  pageFields,
  record,
  type ScanCapability,
} from './read-session.js';
import { createShopifyReturnCapabilities } from './return-actions.js';
import { createShopifyExchangeCapabilities } from './return-exchanges.js';
import { readReturns } from './return-reads.js';
import { createShopifySettlementCapabilities } from './return-settlement.js';
import * as s from './schemas.js';

// Bound to the request that produced it; `after` is Shopify's opaque page cursor.
const readCursor = createCursorCodec(
  z.object({ binding: z.string(), after: z.string().min(1) }).strict(),
);

const counted = {
  'orders.read': 'ordersCount',
  'products.read': 'productsCount',
  'customers.read': 'customersCount',
} as const;

interface ShopifyEvidence {
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
  /**
   * Reports which customer placed each order. Takes effect only with `customerAccess`; set it
   * when the connection grants `customers.read`.
   */
  orderCustomers?: boolean;
  /** Persist the batch before it is returned. Throw if durable recording fails. */
  recordObservations(evidence: ShopifyEvidence): Promise<void>;
  /** Reads accepted actions for these exact source targets. Absent means authorship is unknown. */
  inventoryWrites?(
    targets: { inventoryItemId: string; locationId: string }[],
  ): Promise<InventoryWriteReceipt[]>;
  rawRetentionMs?: number;
  /** Shares transfer shipment identities only when the installation grants their separate read capability. */
  inventoryShipmentAccess?: boolean;
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
  const readBundleRecipes = createBundleReader(request);
  const now = options.now ?? (() => new Date());
  const id = options.id ?? randomUUID;
  const orderCustomers = !!options.customerAccess && !!options.orderCustomers;
  const orderAddresses = !!options.customerAccess?.address;

  function handler<K extends ScanCapability>(
    capability: K,
  ): CapabilityHandler<K> {
    return {
      descriptor: {
        version: '0',
        minimumRisk: 'low',
        idempotency: 'none',
        retry: { maxAttempts: 3, initialDelayMs: 1000 },
        ...(capability === 'inventory.read'
          ? { filters: ['historyImport' as const, 'confirmMissing' as const] }
          : {
              filters: [
                'updatedSince' as const,
                ...(capability === 'orders.read' ||
                capability === 'products.read'
                  ? ['confirmMissing' as const]
                  : []),
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
                ...(capability === 'orders.read' ? ['order' as const] : []),
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
        // A point read of one order is not a scan; it cannot page or filter.
        if (
          capability === 'orders.read' &&
          'order' in input &&
          input.order &&
          (input.cursor ||
            input.updatedSince ||
            input.createdSince ||
            input.historyImport ||
            input.confirmMissing)
        )
          fail('invalid_input');
        if ('confirmMissing' in input && input.confirmMissing) {
          if (
            input.cursor ||
            input.updatedSince ||
            input.createdSince ||
            input.historyImport
          )
            fail('invalid_input');

          return (await confirmDeletion(capability, input.confirmMissing, {
            options,
            request,
            now,
            id,
          })) as CapabilityOutput<K>;
        }
        const filters = input as CapabilityInput<'inventory.read'> &
          CapabilityInput<'fulfillment.read'>;
        if (capability === 'inventory.read' && filters.includeComposition) {
          const access = parse(
            s.scanStart,
            await request(
              'query LumaScanStart { currentAppInstallation { accessScopes { handle } } }',
              {},
            ),
          );
          if (
            !access.currentAppInstallation.accessScopes.some((scope) =>
              ['read_products', 'write_products'].includes(scope.handle),
            )
          )
            fail('permission_denied');
        }
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
              filters.includeComposition ?? false,
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
          const cursor = readCursor.decode(input.cursor);
          if (cursor.binding !== binding) fail('invalid_input');
          after = cursor.after;
        }
        const session = createReadSession({
          ...options,
          request,
          now,
          id,
        });
        const { remember } = session;

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
              orderCustomers,
            })
          : null;
        const encode = (cursor: string | null) =>
          cursor ? readCursor.encode({ binding, after: cursor }) : null;
        if (bulk?.deferred)
          return parse<unknown>(s.outputs[capability], {
            items: [],
            nextCursor: encode(bulk.cursor),
            completeness: 'complete',
            deferred: true,
            retryAfterMs: 2000,
          }) as CapabilityOutput<K>;
        // Export records reflect the shop when the export started, not when Luma reads the file.
        if (bulk?.snapshotAt) session.observeAt(bulk.snapshotAt);

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
            history = orderHistory(
              start.currentAppInstallation.accessScopes,
              now(),
            );
        }
        let roots: { id: string }[];
        let nextAfter: string | null = null;
        if (capability === 'customers.read') {
          const page = await readCustomers(session, {
            options,
            request,
            bulk,
            sorted,
            search,
            after,
            input,
          });
          roots = [];
          nextAfter = bulk ? bulk.cursor : next(page);
          if (nextAfter && nextAfter === after) fail('invalid_response');
        } else if (bulk) {
          remember(bulk.nodes);
          roots = bulk.nodes.map((value) => ({
            id: parse(s.gid(rootType), value.id),
          }));
          nextAfter = bulk.cursor;
          total = capability === 'inventory.read' ? undefined : bulk.total;
        } else if (selected && capability === 'orders.read') {
          // Same selection as an order page, so the observation matches a scan of this order.
          const data = parse(
            z.object({ node: record.nullable() }),
            await request(
              `query LumaOrder($id: ID!) { node(id: $id) { ... on Order { ${readSelection(capability, orderCustomers, orderAddresses)} } } }`,
              { id: selected.externalId },
            ),
          );
          roots = [];
          if (data.node) {
            if (parse(s.gid('Order'), data.node.id) !== selected.externalId)
              fail('invalid_response');
            remember(data.node);
            roots.push({ id: selected.externalId });
          } else {
            // Without read_all_orders, older orders read as absent rather than missing.
            const start = parse(
              s.scanStart,
              await request(
                'query LumaScanStart { currentAppInstallation { accessScopes { handle } } }',
                {},
              ),
            );
            history = orderHistory(
              start.currentAppInstallation.accessScopes,
              now(),
            );
          }
        } else if (selected) {
          if (after) fail('invalid_input');
          roots = [{ id: selected.externalId }];
        } else {
          const fields = readSelection(
            capability,
            orderCustomers,
            orderAddresses,
            filters.includeComposition === true,
          );
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
            await readOrder(session, parent, {
              orderCustomers,
              orderAddresses,
              bulk: !!bulk,
            });
          } else if (capability === 'products.read') {
            await readProduct(session, parent, {
              bulk: !!bulk,
              readBundleRecipes,
            });
          } else if (capability === 'inventory.read') {
            await readInventoryItem(session, parent, filters);
          } else if (capability === 'returns.read') {
            await readReturns(session, parent.id);
          } else {
            await readFulfillments(session, parent);
          }
        }
        const result: Page<unknown> = {
          items: session.items,
          nextCursor: encode(nextAfter),
          completeness: 'complete',
          retryAfterMs: request.nextReadDelay(),
          ...(total === undefined ? {} : { total }),
          ...(history === undefined ? {} : { history }),
        };
        if (capability === 'inventory.read' && options.inventoryWrites) {
          const inventory = parse(s.outputs['inventory.read'], result);
          const receipts = await options.inventoryWrites(
            inventory.items.map((item) => ({
              inventoryItemId: item.data.sku.externalId,
              locationId: item.data.location.externalId,
            })),
          );
          await attributeInventoryWrites(request, inventory.items, receipts);
          for (const [index, item] of inventory.items.entries()) {
            const original = result.items[index];
            if (original) original.data = item.data;
          }
          result.retryAfterMs = request.nextReadDelay();
        }
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
          ...session.raw(),
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
      ...createShopifyReturnCapabilities(options),
      ...createShopifySettlementCapabilities(options),
      ...createShopifyExchangeCapabilities(options),
      'orders.read': handler('orders.read'),
      'products.read': handler('products.read'),
      'inventory.read': handler('inventory.read'),
      ...createInventoryTransferCapabilities({
        ...options,
        now,
        id,
        shipmentAccess: options.inventoryShipmentAccess ?? false,
      }),
      'fulfillment.read': handler('fulfillment.read'),
      'returns.read': handler('returns.read'),
      ...(options.customerAccess
        ? { 'customers.read': handler('customers.read') }
        : {}),
    },
  };
}
