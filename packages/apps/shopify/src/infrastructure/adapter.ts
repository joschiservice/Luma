import { randomUUID } from 'node:crypto';

import {
  type CapabilityHandler,
  type CapabilityInput,
  type CapabilityOutput,
  type ConnectorConnection,
  type Observation,
  type Page,
  type ReadCapability,
} from '@luma/connections';
import type { ShopifyTransportOptions } from '@luma/connector-shopify';
import {
  API_VERSION,
  createClient,
  fail,
  parse,
} from '@luma/connector-shopify';

import { createBundleReader } from './bundles.js';
import { readCustomers } from './customer-reads.js';
import { readFulfillments } from './fulfillment-reads.js';
import { readInventoryItem } from './inventory-reads.js';
import { createInventoryTransferCapabilities } from './inventory-transfers.js';
import {
  attributeInventoryWrites,
  type InventoryWriteReceipt,
} from './inventory-write-attribution.js';
import { readOrder } from './order-reads.js';
import { readProduct } from './product-reads.js';
import { next, type ScanCapability } from './read-session.js';
import { createShopifyReturnCapabilities } from './return-actions.js';
import { createShopifyExchangeCapabilities } from './return-exchanges.js';
import { readReturns } from './return-reads.js';
import { createShopifySettlementCapabilities } from './return-settlement.js';
import {
  openReadSession,
  readRoots,
  readSelectedOrder,
  type ScanSession,
} from './scan-session.js';
import * as s from './schemas.js';

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

  /** Reads every record on a scan page and its nested pages, then builds the page result. */
  const eachRoot =
    (read: (scan: ScanSession, parent: { id: string }) => Promise<unknown>) =>
    async (scan: ScanSession) => {
      const page = await readRoots(scan);
      for (const parent of page.roots) await read(scan, parent);

      return scan.page(page);
    };

  // Keyed by every scan capability, so a capability without a reader fails to compile.
  const readers: Record<
    ScanCapability,
    (scan: ScanSession) => Promise<Page<unknown>>
  > = {
    'orders.read': async (scan) => {
      const page =
        scan.selected && !scan.bulk
          ? await readSelectedOrder(scan, scan.selected)
          : await readRoots(scan);
      for (const parent of page.roots)
        await readOrder(scan, parent, {
          orderCustomers: scan.orderCustomers,
          orderAddresses: scan.orderAddresses,
          bulk: !!scan.bulk,
        });

      return scan.page(page);
    },
    'products.read': eachRoot((scan, parent) =>
      readProduct(scan, parent, { bulk: !!scan.bulk, readBundleRecipes }),
    ),
    'inventory.read': async (scan) => {
      const result = await eachRoot((_, parent) =>
        readInventoryItem(scan, parent, scan.filters),
      )(scan);
      if (options.inventoryWrites) {
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

      return result;
    },
    'fulfillment.read': eachRoot(readFulfillments),
    'returns.read': eachRoot((scan, parent) => readReturns(scan, parent.id)),
    'customers.read': async (scan) => {
      const { bulk, after } = scan;
      const page = await readCustomers(scan, {
        options,
        request,
        bulk,
        sorted: scan.sorted,
        search: scan.search,
        after,
        input: scan.input,
      });
      const nextAfter = bulk ? bulk.cursor : next(page);
      if (nextAfter && nextAfter === after) fail('invalid_response');

      return scan.page({ nextAfter, total: scan.total, history: scan.history });
    },
  };

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
        const opened = await openReadSession(capability, context, input, {
          options,
          request,
          now,
          id,
        });
        if ('output' in opened) return opened.output as CapabilityOutput<K>;

        const result = await readers[capability](opened.session);
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
          ...opened.session.raw(),
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
