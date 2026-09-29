import { createHash, randomUUID } from 'node:crypto';

import {
  type CapabilityHandler,
  type CapabilityInput,
  type CapabilityOutput,
  type ConnectorConnection,
  type ExternalId,
  type Observation,
  type ReadCapability,
  type SourceIdentity,
} from '@luma/connections';
import type { JtlTransportOptions } from '@luma/connector-jtl';
import { API_VERSION, createClient, fail, parse } from '@luma/connector-jtl';
import { z } from 'zod';

import { adapterVersion, outputs } from './outputs.js';
import * as s from './schemas.js';
import { createJtlShippingMethodCapabilities } from './shipping-method.js';

// Blank or oversized source text is treated as not provided rather than truncated.
const text = (value: string | null | undefined) => {
  const trimmed = value?.trim();

  return trimmed && trimmed.length <= 512 ? trimmed : null;
};

const ref = (id: number | string, scopeKey = ''): ExternalId => ({
  externalId: String(id),
  scopeKey,
});

export interface JtlEvidence {
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
  /** Enable only after confirming sales-order read/write grants and endpoint support. */
  shippingMethodActions?: boolean;
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
    K extends Exclude<ReadCapability, 'orders.shipping-method.read'>,
  >(capability: K): CapabilityHandler<K> {
    return {
      descriptor: {
        version: '0',
        minimumRisk: 'low',
        idempotency: 'none',
        retry: { maxAttempts: 3, initialDelayMs: 1000 },
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

        function capture<T>(
          schema: z.ZodType<T, z.ZodTypeDef, unknown>,
          value: unknown,
        ): T {
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

          return { items: result.items as z.infer<T>[], hasNext };
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

        async function orderLines(orderId: string) {
          const lines = capture(
            z.array(s.orderLine),
            await client.request(`sales-orders/${orderId}/line-items`),
          );
          if (
            new Set(lines.map((line) => line.id)).size !== lines.length ||
            lines.some((line) => line.salesOrderId !== orderId)
          )
            fail('invalid_response');

          return lines;
        }

        let hasNext: boolean;
        if (capability === 'orders.read') {
          const result = await page(
            'sales-orders',
            s.order,
            pageNumber,
            input.limit,
          );
          hasNext = result.hasNext;
          for (const order of result.items) {
            const lines = await orderLines(order.id);
            // ERP 2.2 sales orders and delivery notes have no modification time, so these
            // snapshots are ordered by observation time. Creation dates are not update times.
            emit('order', ref(order.id), null, {
              displayNumber: order.salesOrderNumber,
              placedAt: order.salesOrderDate ?? null,
              total:
                order.totalGrossAmount != null &&
                /^[A-Z]{3}$/.test(order.currencyIso ?? '')
                  ? {
                      amount: order.totalGrossAmount,
                      currency: order.currencyIso!,
                    }
                  : null,
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
                cancelledQuantity: null,
                skuCode: text(line.sKU),
                title: text(line.name),
              })),
            });
          }
        } else if (
          capability === 'products.read' ||
          capability === 'inventory.read'
        ) {
          const result = await page('items', s.item, pageNumber, input.limit);
          hasNext = result.hasNext;
          for (const item of result.items) {
            if (capability === 'products.read') {
              emit('product', ref(item.id), item.modifiedTimestamp ?? null, {
                title: item.name ?? null,
                status: item.isActive ? 'active' : 'archived',
                skus: [
                  { id: ref(item.id), code: item.sKU, unit: unit(item.unit) },
                ],
              });
            } else {
              if (filters.sku && filters.sku.externalId !== String(item.id))
                continue;
              const location = filters.location?.externalId ?? 'all-warehouses';
              const stock =
                location === 'all-warehouses'
                  ? null
                  : capture(
                      s.warehouseStock,
                      await client.request(
                        `warehouses/${location}/items/${item.id}/stocks`,
                      ),
                    );
              const known = (value: string | null | undefined) =>
                item.isInventoryManagementActive ? (value ?? null) : null;
              const available =
                location === 'all-warehouses'
                  ? known(item.stockAvailable)
                  : null;
              emit(
                'sku',
                ref(item.id, location),
                item.modifiedTimestamp ?? null,
                {
                  sku: ref(item.id),
                  location: ref(location),
                  unit: unit(item.unit),
                  onHand: known(stock ? stock.totalQuantity : item.stockTotal),
                  reserved: stock ? null : known(item.stockReservedTotal),
                  available,
                  availabilityBasis:
                    available === null ? 'unknown' : 'provider_reported',
                },
              );
            }
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
          for (const root of result.items) {
            const note = capture(
              s.note,
              await client.request(`delivery-notes/${root.id}`),
            );
            if (
              note.id !== root.id ||
              (filters.order &&
                String(note.salesOrderId) !== filters.order.externalId) ||
              note.packages.some((value) => value.deliveryNoteId !== note.id)
            )
              fail('invalid_response');
            const lines = await children(
              `delivery-notes/${note.id}/line-items`,
              s.noteLine,
            );
            const sourceLines = await orderLines(note.salesOrderId);
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
      'orders.read': handler('orders.read'),
      'products.read': handler('products.read'),
      'inventory.read': handler('inventory.read'),
      'fulfillment.read': handler('fulfillment.read'),
    },
  };
}
