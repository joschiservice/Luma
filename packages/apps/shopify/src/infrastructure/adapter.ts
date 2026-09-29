import { createHash, randomUUID } from 'node:crypto';

import {
  type CapabilityHandler,
  type CapabilityInput,
  type CapabilityOutput,
  type ConnectorConnection,
  type ExternalId,
  type FulfillmentSnapshot,
  type Observation,
  type OrderSnapshot,
  type Page,
  type ReadCapability,
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

import * as s from './schemas.js';

const pageFields = 'pageInfo { hasNextPage endCursor }';

const ref = (externalId: string, scopeKey = ''): ExternalId => ({
  externalId,
  scopeKey,
});

const quantity = (value: number) => ({ amount: String(value), unit: 'each' });

// Blank or oversized source text is treated as not provided rather than truncated.
const text = (value: string | null | undefined) => {
  const trimmed = value?.trim();

  return trimmed && trimmed.length <= 512 ? trimmed : null;
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

const shipmentStatuses: Record<string, FulfillmentSnapshot['status']> = {
  PENDING: 'pending',
  OPEN: 'processing',
  SUCCESS: 'shipped',
  CANCELLED: 'cancelled',
  ERROR: 'failed',
  FAILURE: 'failed',
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
    K extends Exclude<ReadCapability, 'orders.shipping-method.read'>,
  >(capability: K): CapabilityHandler<K> {
    return {
      descriptor: {
        version: '0',
        minimumRisk: 'low',
        idempotency: 'none',
        retry: { maxAttempts: 3, initialDelayMs: 1000 },
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
        const binding = createHash('sha256')
          .update(
            JSON.stringify([
              options.tenantId,
              options.connectionId,
              options.shop,
              API_VERSION,
              capability,
              input.limit,
              filters.sku ?? null,
              filters.location ?? null,
              filters.order ?? null,
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
        const observedAt = now().toISOString();
        const items: Observation<unknown>[] = [];

        function emit(
          resource: SourceIdentity['resource'],
          external: ExternalId,
          updatedAt: string,
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

        async function node<T>(
          externalId: string,
          type: string,
          fields: string,
          schema: z.ZodType<T, z.ZodTypeDef, unknown>,
        ): Promise<T> {
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
          const seen = new Set<string>();
          do {
            const data = await request(
              `query LumaChildren($id: ID!, $after: String) { node(id: $id) { ... on ${type} { children: ${field}(first: 100, after: $after) { nodes { ${fields} } ${pageFields} } } } }`,
              { id: externalId, after: cursor },
            );
            if (data.node === null) fail('not_found');
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
              : 'orders';
        const rootType =
          root === 'products'
            ? 'Product'
            : root === 'inventoryItems'
              ? 'InventoryItem'
              : 'Order';
        const selected = filters.sku ?? filters.order;
        let roots: { id: string }[];
        let nextAfter: string | null = null;
        if (selected) {
          if (after) fail('invalid_input');
          roots = [{ id: selected.externalId }];
        } else {
          const data = await request(
            `query LumaPage($first: Int!, $after: String) { page: ${root}(first: $first, after: $after) { nodes { id } ${pageFields} } }`,
            { first: input.limit, after },
          );
          const page = capture(
            s.connection(z.object({ id: s.gid(rootType) })),
            data.page,
          );
          roots = page.nodes;
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
              'id updatedAt title status',
              s.product,
            );
            const variants = await children(
              parent.id,
              'Product',
              'variants',
              'id sku inventoryItem { id }',
              s.variant,
            );
            emit('product', ref(product.id), product.updatedAt, {
              title: product.title,
              status:
                product.status === 'ACTIVE'
                  ? 'active'
                  : product.status === 'ARCHIVED'
                    ? 'archived'
                    : 'unknown',
              skus: variants.map((variant) => ({
                id: ref(variant.inventoryItem.id),
                code: variant.sku,
                unit: 'each',
              })),
            });
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
          } else {
            const work = await children(
              parent.id,
              'Order',
              'fulfillmentOrders',
              'id updatedAt status',
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
              });
            }
            // Order.fulfillments is an unpaginated list. Omit `first` to avoid silently truncating shipments.
            const order = await node(
              parent.id,
              'Order',
              'fulfillments { id updatedAt status deliveredAt inTransitAt }',
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
              });
            }
          }
        }
        const result: Page<unknown> = {
          items,
          nextCursor: nextAfter
            ? Buffer.from(
                JSON.stringify({ binding, after: nextAfter }),
              ).toString('base64url')
            : null,
          completeness: 'complete',
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
    },
  };
}

function next(page: z.infer<typeof s.pageInfo>): string | null {
  if (page.hasNextPage && !page.endCursor) fail('invalid_response');

  return page.hasNextPage ? page.endCursor : null;
}
