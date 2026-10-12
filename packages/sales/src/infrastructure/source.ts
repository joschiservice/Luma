import { randomUUID } from 'node:crypto';

import type {
  ConnectorConnection,
  Observation,
  OrderSnapshot,
} from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import { requirePermission, requireTenant } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import type { SalesOrder } from '../domain/order.js';
import { publishedOrder } from '../domain/order.js';

const pageInput = z
  .object({
    limit: z.number().int().min(1).max(1000),
    cursor: z.string().uuid().optional(),
    updatedSince: z.string().datetime({ offset: true }).optional(),
    createdSince: z.string().datetime({ offset: true }).optional(),
    order: z
      .object({ externalId: z.string().uuid(), scopeKey: z.literal('') })
      .strict()
      .optional(),
  })
  .strict()
  // A point read of one record cannot page or filter.
  .refine(
    (value) =>
      !value.order ||
      (!value.cursor && !value.updatedSince && !value.createdSince),
  );

/** Supplies fresh nonpersonal reads of committed records through the ordinary order capability. */
export function createSalesSource(
  db: TenantDatabase,
  enabled: (context: TenantContext) => Promise<boolean>,
  validate: (value: unknown) => void,
) {
  return async (
    context: TenantContext,
    connectionId: string,
  ): Promise<ConnectorConnection | null> => {
    requireTenant(context, context.tenantId);
    const exists = await db.transaction(
      context.tenantId,
      async (tx) =>
        (
          await tx.query(
            "SELECT id FROM connector_installations WHERE tenant_id=$1 AND id=$2 AND document->>'provider'='luma-erp' AND document->>'status'='active'",
            [context.tenantId, connectionId],
          )
        ).rowCount === 1,
    );
    if (!exists || !(await enabled(context))) return null;

    return {
      tenantId: context.tenantId,
      id: connectionId,
      provider: 'luma-erp',
      status: 'active',
      adapterVersion: 'luma-erp/1',
      mechanism: 'api',
      executor: { kind: 'service', id: 'luma-erp' },
      capabilities: {
        'orders.read': {
          descriptor: {
            version: '0',
            minimumRisk: 'low',
            idempotency: 'none',
            retry: { maxAttempts: 1, initialDelayMs: 0 },
            filters: ['updatedSince', 'createdSince', 'order'],
          },
          parseInput: (value) => {
            const parsed = pageInput.parse(value);

            return {
              limit: parsed.limit,
              ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
              ...(parsed.updatedSince
                ? { updatedSince: parsed.updatedSince }
                : {}),
              ...(parsed.createdSince
                ? { createdSince: parsed.createdSince }
                : {}),
              ...(parsed.order ? { order: parsed.order } : {}),
            };
          },
          parseOutput: (value) => {
            const page = z
              .object({
                items: z.array(z.unknown()),
                nextCursor: z.string().uuid().nullable(),
                completeness: z.literal('complete'),
              })
              .strict()
              .parse(value);

            return {
              ...page,
              items: z
                .array(
                  z.custom<Observation<OrderSnapshot>>((item) => {
                    validate(item);

                    return true;
                  }),
                )
                .parse(page.items),
            };
          },
          run: async (invocation, input) => {
            requireTenant(invocation.tenant, context.tenantId);
            requirePermission(invocation.tenant, 'orders.read');
            const observedAt = new Date().toISOString();

            return db.transaction(
              context.tenantId,
              async (tx) => {
                const rows = await tx.query<{ document: SalesOrder }>(
                  `SELECT o.document || jsonb_build_object('lines',COALESCE((SELECT jsonb_agg(l.document ORDER BY l.position) FROM sales_order_lines l WHERE l.tenant_id=o.tenant_id AND l.sales_order_id=o.id),'[]'::jsonb)) AS document
              FROM sales_orders o WHERE o.tenant_id=$1 AND o.connection_id=$2 AND ($3::uuid IS NULL OR o.id>$3)
              AND ($4::timestamptz IS NULL OR (o.document->>'updatedAt')::timestamptz >= $4)
              AND ($5::timestamptz IS NULL OR (o.document->>'placedAt')::timestamptz >= $5)
              AND ($7::uuid IS NULL OR o.id=$7)
              ORDER BY o.id LIMIT $6`,
                  [
                    context.tenantId,
                    connectionId,
                    input.cursor ?? null,
                    input.updatedSince ?? null,
                    input.createdSince ?? null,
                    input.limit + 1,
                    input.order?.externalId ?? null,
                  ],
                );
                const records = rows.rows
                  .slice(0, input.limit)
                  .map((row) => row.document);

                return {
                  completeness: 'complete' as const,
                  nextCursor:
                    rows.rows.length > input.limit ? records.at(-1)!.id : null,
                  items: records.map((order): Observation<OrderSnapshot> => {
                    const data = publishedOrder(order);

                    return {
                      id: randomUUID(),
                      source: {
                        tenantId: context.tenantId,
                        connectionId,
                        provider: 'luma-erp',
                        resource: 'order',
                        externalId: order.id,
                        scopeKey: '',
                      },
                      kind: 'snapshot',
                      observedAt,
                      sourceUpdatedAt: order.updatedAt,
                      sourceRevision: String(order.version),
                      adapterVersion: 'luma-erp/1',
                      schemaVersion: 1,
                      data: {
                        displayNumber: order.number,
                        status: order.status,
                        paymentStatus: order.paymentStatus,
                        placedAt: order.placedAt,
                        dueAt: order.dueAt,
                        total: data.total,
                        lines: data.lines.map(({ skuId, unit, ...line }) => ({
                          ...line,
                          id: { externalId: line.id, scopeKey: order.id },
                          sku: skuId
                            ? { externalId: skuId, scopeKey: '' }
                            : null,
                          quantity: { amount: line.quantity, unit },
                          currentQuantity: {
                            amount: line.currentQuantity,
                            unit,
                          },
                          cancelledQuantity: {
                            amount: line.cancelledQuantity,
                            unit,
                          },
                        })),
                      },
                    };
                  }),
                };
              },
              { readOnlySnapshot: true },
            );
          },
        },
      },
    };
  };
}
