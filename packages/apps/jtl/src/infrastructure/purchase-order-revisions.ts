import { createHash } from 'node:crypto';

import {
  type CapabilityHandler,
  ConnectorError,
  type ConnectorFailure,
  type SupplierOrderSnapshot,
} from '@luma/connections';
import { purchaseOrderRevisionInputSchema } from '@luma/connections/composition';
import { createClient, parse } from '@luma/connector-jtl';
import { z } from 'zod';

import { jtlPermissions } from '../domain/permissions.js';
import type { JtlConnectorOptions } from './adapter.js';
import * as s from './schemas.js';

const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );

type Order = z.infer<typeof s.purchaseOrder>;

function refuse(
  code: ConnectorFailure['code'],
  failure?: ConnectorFailure,
): never {
  throw new ConnectorError({
    ...failure,
    code,
    effect: 'none',
    retry: 'never',
    dispatch: 'not_dispatched',
  });
}

/** Dispatches one documented line operation; uncertain writes are reconciled by a separate read only. */
export function createJtlPurchaseOrderRevision(
  options: JtlConnectorOptions,
  map: (order: Order) => SupplierOrderSnapshot,
): CapabilityHandler<'purchase-orders.revise'> {
  const client = createClient(options);

  return {
    descriptor: {
      version: '0',
      minimumRisk: 'high',
      idempotency: 'none',
      permission: jtlPermissions.purchaseOrders,
      retry: { maxAttempts: 1, initialDelayMs: 1000 },
    },
    parseInput: (input) => purchaseOrderRevisionInputSchema.parse(input),
    parseOutput: (output) =>
      z
        .object({
          status: z.literal('accepted'),
          evidenceRefs: z.array(z.string().uuid()).length(1),
          providerRequestId: z.string().nullable(),
        })
        .strict()
        .parse(output),
    async run(context, value) {
      if (
        context.tenant.tenantId !== options.tenantId ||
        context.connectionId !== options.connectionId ||
        context.provider !== 'jtl'
      )
        refuse('unavailable');
      if (!context.idempotencyKey) refuse('invalid_input');
      const request = purchaseOrderRevisionInputSchema.safeParse(value);
      if (!request.success) refuse('invalid_input');
      const input = request.data;
      let method: 'PATCH' | 'POST' | 'DELETE' = 'PATCH',
        path = `purchase-orders/${encodeURIComponent(input.order.externalId)}`,
        body: Record<string, unknown> = {};
      try {
        const current = parse(s.purchaseOrder, await client.request(path));
        if (
          current.purchaseOrderId !== input.order.externalId ||
          canonicalJson(map(current)) !== canonicalJson(input.expected)
        )
          refuse('conflict');
        if (![0, 5].includes(current.status)) refuse('conflict');
        if (input.operation.kind === 'add_line') {
          const operation = input.operation;
          if (
            current.lineItems.length >= 100 ||
            current.lineItems.some(
              (line) => line.itemId === operation.sku.externalId,
            ) ||
            operation.sku.scopeKey !== ''
          )
            refuse('conflict');
          const assignments = parse(
            s.page(s.itemSupplier),
            await client.request(
              `items/${encodeURIComponent(operation.sku.externalId)}/suppliers`,
              { pageNumber: '1', pageSize: '100' },
            ),
          );
          if (assignments.totalItems > 100) refuse('conflict');
          const prices = assignments.items.filter(
            (a) => a.supplierId === current.supplierId,
          );
          const price = prices[0];
          if (
            prices.length !== 1 ||
            !price ||
            price.netPurchasePrice == null ||
            price.vatRate == null
          )
            refuse('conflict');
          path += '/line-items';
          method = 'POST';
          body = {
            itemId: operation.sku.externalId,
            quantity: operation.quantity,
            deliveryDate: `${operation.requestedDeliveryDate}T12:00:00Z`,
            netPurchasePriceAmount: Number(price.netPurchasePrice),
            vatRatePercentage: Number(price.vatRate),
          };
        } else {
          const operation = input.operation;
          if (operation.line.scopeKey !== input.order.externalId)
            refuse('invalid_input');
          const line = current.lineItems.find(
            (l) => l.lineItemId === operation.line.externalId,
          );
          if (!line || Number(line.deliveredQuantity) > 0) refuse('conflict');
          path += `/line-items/${encodeURIComponent(operation.line.externalId)}`;
          if (operation.kind === 'remove_line') {
            if (current.lineItems.length <= 1) refuse('conflict');
            method = 'DELETE';
          } else
            body = {
              ...(operation.quantity !== undefined
                ? { quantity: operation.quantity }
                : {}),
              ...(operation.requestedDeliveryDate
                ? {
                    deliveryDate: `${operation.requestedDeliveryDate}T12:00:00Z`,
                  }
                : {}),
            };
        }
      } catch (error) {
        if (error instanceof ConnectorError)
          refuse(error.failure.code, error.failure);
        refuse('internal');
      }
      const key = createHash('sha256')
        .update(
          JSON.stringify([
            options.tenantId,
            options.connectionId,
            'purchase-orders.revise',
            context.idempotencyKey,
          ]),
        )
        .digest('hex');
      let providerRequestId: string | null = null;
      const response = await client.request(
        path,
        {},
        {
          method,
          body,
          idempotencyKey: key,
          receipt: (id) => {
            providerRequestId = id;
          },
        },
      );
      if (!s.purchaseOrder.safeParse(response).success)
        throw new ConnectorError({
          code: 'invalid_response',
          effect: 'unknown',
          retry: 'reconcile',
        });
      const hex = createHash('sha256')
        .update(`jtl:purchase-order-revision:${key}`)
        .digest('hex');

      return {
        status: 'accepted',
        evidenceRefs: [
          `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
        ],
        providerRequestId,
      };
    },
  };
}
