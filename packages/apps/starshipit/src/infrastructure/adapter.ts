import { createHash, randomUUID } from 'node:crypto';

import {
  type CapabilityHandler,
  type CapabilityOutput,
  type ConnectorConnection,
  ConnectorError,
  type Observation,
} from '@luma/connections';
import { commerceSchema } from '@luma/connections/composition';
import {
  API_VERSION,
  createClient,
  fail,
  parse,
  type StarshipitTransportOptions,
} from '@luma/connector-starshipit';
import * as s from '@luma/connector-starshipit/schemas';
import { z } from 'zod';

import {
  fulfillmentSnapshots,
  orderSnapshot,
  ref,
  revision,
} from './mapping.js';

const adapterVersion = 'starshipit/1';
const external = z
  .object({
    externalId: z.string().regex(/^[1-9]\d{0,15}$/),
    scopeKey: z.literal(''),
  })
  .strict();
const querySchema = z
  .object({
    limit: z.number().int().min(1).max(100),
    cursor: z.string().min(1).max(8192).optional(),
    order: external.optional(),
  })
  .strict()
  .refine((v) => !(v.order && v.cursor));
const cursorSchema = z
  .object({
    binding: z.string(),
    status: z.number().int().min(0).max(2),
    page: z.number().int().positive(),
  })
  .strict();
const statuses = ['Unshipped', 'Printed', 'Shipped'];

export interface StarshipitConnectorOptions extends StarshipitTransportOptions {
  tenantId: string;
  connectionId: string;
  recordObservations(evidence: {
    tenantId: string;
    connectionId: string;
    apiVersion: typeof API_VERSION;
    capability: 'orders.read' | 'fulfillment.read';
    observations: Observation<unknown>[];
  }): Promise<void>;
  now?: () => Date;
}

/** Reads every shipping state; scan pages are complete only after all order details and tracking reads succeed. */
export function createStarshipitConnector(
  options: StarshipitConnectorOptions,
): ConnectorConnection {
  const client = createClient(options);

  function handler<K extends 'orders.read' | 'fulfillment.read'>(
    capability: K,
  ): CapabilityHandler<K> {
    return {
      descriptor: {
        version: '0',
        minimumRisk: 'low',
        idempotency: 'none',
        retry: { maxAttempts: 3, initialDelayMs: 1000 },
        ...(capability === 'orders.read' ? { filters: ['order'] } : {}),
      },
      parseInput: (value) => {
        const parsed = querySchema.parse(value);

        return {
          limit: parsed.limit,
          ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
          ...(parsed.order ? { order: parsed.order } : {}),
        };
      },
      parseOutput(value): CapabilityOutput<K> {
        const page = z
          .object({
            items: z.array(z.unknown()),
            nextCursor: z.string().nullable(),
            completeness: z.enum(['complete', 'partial']),
          })
          .strict()
          .parse(value);
        for (const observation of page.items)
          commerceSchema.parse({ capability, observation });

        return page as CapabilityOutput<K>;
      },
      async run(context, input) {
        if (
          context.tenant.tenantId !== options.tenantId ||
          context.connectionId !== options.connectionId ||
          context.provider !== 'starshipit'
        )
          fail('unavailable');
        const query = querySchema.parse(input);
        const observedAt = (options.now?.() ?? new Date()).toISOString();
        const binding = createHash('sha256')
          .update(
            JSON.stringify([
              options.tenantId,
              options.connectionId,
              capability,
              query.limit,
            ]),
          )
          .digest('hex');
        let cursor = { binding, status: 0, page: 1 };
        if (query.cursor) {
          try {
            cursor = cursorSchema.parse(
              JSON.parse(Buffer.from(query.cursor, 'base64url').toString()),
            );
          } catch {
            fail('invalid_input');
          }
          if (cursor.binding !== binding) fail('invalid_input');
        }
        let ids: string[];
        let next: typeof cursor | null = null;
        if (query.order) ids = [query.order.externalId];
        else {
          const page = parse(
            s.list,
            await client.read(
              'orders',
              new URLSearchParams({
                status: statuses[cursor.status]!,
                page_number: String(cursor.page),
                page_size: String(query.limit),
              }),
            ),
          );
          if (
            page.page_number !== cursor.page ||
            page.data.orders.length > query.limit
          )
            fail('invalid_response');
          ids = [...new Set(page.data.orders.map((order) => order.order_id))];
          next =
            cursor.page < page.total_pages
              ? { ...cursor, page: cursor.page + 1 }
              : cursor.status < 2
                ? { ...cursor, status: cursor.status + 1, page: 1 }
                : null;
        }
        const observations: Observation<unknown>[] = [];
        for (const id of ids) {
          let order: z.infer<typeof s.order>;
          try {
            order = parse(
              s.detail,
              await client.read(
                'orders',
                new URLSearchParams({ order_id: id }),
              ),
            ).order;
          } catch (error) {
            if (
              query.order &&
              error instanceof ConnectorError &&
              error.failure.code === 'not_found'
            )
              continue;
            throw error;
          }
          if (order.order_id !== id) fail('invalid_response');
          const emit = (
            resource: 'order' | 'fulfillment',
            externalId: string,
            data: unknown,
            sourceUpdatedAt: string | null,
          ) =>
            observations.push({
              id: randomUUID(),
              source: {
                tenantId: options.tenantId,
                connectionId: options.connectionId,
                provider: 'starshipit',
                resource,
                ...ref(externalId),
              },
              kind: 'snapshot',
              observedAt,
              sourceUpdatedAt,
              sourceRevision: revision(order),
              adapterVersion,
              schemaVersion: 1,
              data,
            });
          if (capability === 'orders.read')
            emit('order', id, orderSnapshot(order), null);
          else {
            // Order number is a provider-side lookup, never a canonical mapping key.
            if (!order.order_number) fail('invalid_response');
            const tracks = parse(
              s.tracked,
              await client.read(
                'track',
                new URLSearchParams({ order_number: order.order_number }),
              ),
            );
            if (
              tracks.some((track) => track.order_number !== order.order_number)
            )
              fail('invalid_response');
            const receivedAt = (options.now?.() ?? new Date()).toISOString();
            if (
              tracks.some(
                (track) =>
                  (track.last_updated_date &&
                    track.last_updated_date > receivedAt) ||
                  (track.shipment_date && track.shipment_date > receivedAt),
              )
            )
              fail('invalid_response');
            for (const fulfillment of fulfillmentSnapshots(order, tracks))
              emit(
                'fulfillment',
                fulfillment.id,
                fulfillment.data,
                fulfillment.sourceUpdatedAt,
              );
          }
        }
        const result = this.parseOutput({
          items: observations,
          nextCursor: next
            ? Buffer.from(JSON.stringify(next)).toString('base64url')
            : null,
          completeness: 'complete',
        });
        await options.recordObservations({
          tenantId: options.tenantId,
          connectionId: options.connectionId,
          apiVersion: API_VERSION,
          capability,
          observations,
        });

        return result;
      },
    };
  }

  return {
    tenantId: options.tenantId,
    id: options.connectionId,
    provider: 'starshipit',
    status: 'active',
    adapterVersion,
    mechanism: 'api',
    executor: { kind: 'connector', id: adapterVersion },
    capabilities: {
      'orders.read': handler('orders.read'),
      'fulfillment.read': handler('fulfillment.read'),
    },
  };
}
