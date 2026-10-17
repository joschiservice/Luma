import { randomUUID } from 'node:crypto';

import type { CapabilityHandler } from '@luma/connections';
import { ConnectorError } from '@luma/connections';
import {
  exchangeReservationInputSchema,
  exchangeReservationSchema,
} from '@luma/connections/adapters';
import { API_VERSION, createClient, parse } from '@luma/connector-jtl';
import { fromUnits, toUnits } from '@luma/orders';
import { z } from 'zod';

import type { JtlConnectorOptions } from './adapter.js';
import { adapterVersion } from './outputs.js';
import * as s from './schemas.js';

/** Reads exact marked replacement orders and native reservations; it never creates an ERP order. */
export function createExchangeReservation(
  options: JtlConnectorOptions,
): CapabilityHandler<'returns.exchange.reservation.read'> {
  const client = createClient(options),
    now = options.now ?? (() => new Date()),
    id = options.id ?? randomUUID;
  const refuse = (): never => {
    throw new ConnectorError({
      code: 'invalid_response',
      effect: 'none',
      retry: 'never',
    });
  };

  async function scan<T extends z.ZodType>(path: string, schema: T) {
    const items: z.output<T>[] = [];
    let complete = false,
      total: number | null = null;
    for (let n = 1; n <= 5; n++) {
      const p = parse(
        s.page(schema),
        await client.request(path, { pageNumber: String(n), pageSize: '100' }),
      );
      if (
        p.pageNumber !== n ||
        p.pageSize !== 100 ||
        (total !== null && total !== p.totalItems) ||
        p.items.length !==
          Math.min(100, Math.max(0, p.totalItems - (n - 1) * 100)) ||
        (p.hasNextPage !== undefined &&
          p.hasNextPage !== n * 100 < p.totalItems) ||
        (n * 100 < p.totalItems &&
          p.nextPageNumber !== undefined &&
          p.nextPageNumber !== n + 1)
      )
        refuse();
      total = p.totalItems;
      items.push(...p.items);
      if (n * 100 >= p.totalItems) {
        complete = true;
        break;
      }
    }

    return { items, complete };
  }

  return {
    descriptor: {
      version: '0',
      minimumRisk: 'low',
      idempotency: 'none',
      retry: { maxAttempts: 3, initialDelayMs: 1000 },
    },
    parseInput: (v) => exchangeReservationInputSchema.parse(v),
    parseOutput: (v) => exchangeReservationSchema.parse(v),
    async run(context, input) {
      if (
        context.tenant.tenantId !== options.tenantId ||
        context.connectionId !== options.connectionId ||
        context.provider !== 'jtl' ||
        input.item.scopeKey
      )
        refuse();
      const observedAt = now().toISOString();
      const orders = await scan('sales-orders', s.order),
        reservations = await scan('stocks/reservations', s.stockReservation);
      if (new Set(orders.items.map((o) => o.id)).size !== orders.items.length)
        refuse();
      const matches = orders.items.filter(
        (o) => o.externalSalesOrderNumber === `luma-ex:${input.operationId}`,
      );
      const selected = [];
      let complete = orders.complete && reservations.complete;
      // More than one marked order already proves ambiguity; no child read can repair that.
      for (const order of matches.slice(0, 2)) {
        const nativeLines = parse(
          z.array(s.orderLine).max(500),
          await client.request(
            `sales-orders/${encodeURIComponent(order.id)}/line-items`,
          ),
        );
        const lines = { items: nativeLines, complete: true };
        if (
          new Set(lines.items.map((l) => l.id)).size !== lines.items.length ||
          lines.items.some((l) => l.salesOrderId !== order.id)
        )
          refuse();
        complete = complete && lines.complete;
        const wanted = lines.items.filter(
          (l) => l.itemId === input.item.externalId,
        );
        const held = reservations.items.filter(
          (r) =>
            r.salesOrderId === order.id && r.itemId === input.item.externalId,
        );
        selected.push({
          id: { externalId: order.id, scopeKey: '' },
          total:
            order.totalGrossAmount != null && order.currencyIso
              ? { amount: order.totalGrossAmount, currency: order.currencyIso }
              : null,
          paid: order.paymentStatus === 2,
          cancelled: order.isCancelled,
          exactLines:
            lines.complete &&
            lines.items.length === 1 &&
            wanted.length === 1 &&
            {
              ...{ each: 'each', stk: 'each', Stück: 'each' },
              ...options.units,
            }[wanted[0]!.salesUnit] === 'each',
          quantity: fromUnits(
            wanted.reduce((n, l) => n + toUnits(l.quantity), 0n),
          ),
          reserved: reservations.complete
            ? fromUnits(held.reduce((n, r) => n + toUnits(r.amount), 0n))
            : null,
        });
      }
      const result = {
        observedAt,
        evidenceRefs: [id()],
        complete,
        orders: selected,
      };
      const observation = {
        id: result.evidenceRefs[0]!,
        source: {
          tenantId: options.tenantId,
          connectionId: options.connectionId,
          provider: 'jtl',
          resource: 'sku' as const,
          externalId: input.item.externalId,
          scopeKey: '',
        },
        kind: 'snapshot' as const,
        observedAt,
        sourceUpdatedAt: null,
        sourceRevision: null,
        adapterVersion,
        schemaVersion: 1 as const,
        data: result,
      };
      await options.recordObservations({
        tenantId: options.tenantId,
        connectionId: options.connectionId,
        apiVersion: API_VERSION,
        capability: 'returns.exchange.reservation.read',
        observations: [observation],
      });

      return {
        ...result,
        reads: [
          {
            ...observation,
            completeness: complete ? 'complete' : 'partial',
          },
        ],
      };
    },
  };
}
