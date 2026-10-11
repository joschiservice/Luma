import type { InstalledReturnRuntime } from '@luma/connections/composition';
import type { ReturnExchangeSystem } from '@luma/orders/composition';

import { createReturnExchangeSystem } from './return-exchanges.js';
import { createReturnSettlementSystem } from './return-settlement.js';

/** Composes independent native reads of both systems. A failed leg stays absent and sends no effect. */
export function createReturnConsistencySystem(
  runtime: InstalledReturnRuntime,
): ReturnExchangeSystem {
  const exchange = createReturnExchangeSystem(runtime),
    settlement = createReturnSettlementSystem(runtime);

  return {
    ...exchange,
    async consistency(context, value, root, process, actions) {
      const safe = async <T>(read: () => Promise<T>): Promise<T | null> => {
        try {
          return await read();
        } catch {
          return null;
        }
      };
      const shopify = process?.sent
        ? await safe(() => exchange.proof(context, process))
        : null;
      const price = process?.sent
        ? await safe(async () => {
            const result = await runtime.read(context, {
              connectionId: value.connectionId,
              capability: 'returns.exchange.price.read',
              version: '0',
              input: { operationId: root.id, plan: process.plan },
            });
            if (!result.ok) throw new Error('Replacement price unavailable');

            return result.value;
          })
        : null;
      const returns = await safe(async () => {
        const result = await runtime.read(context, {
          connectionId: value.connectionId,
          capability: 'returns.read',
          version: '0',
          input: { limit: 100, order: root.request.order },
        });
        if (!result.ok) throw new Error('Return evidence unavailable');
        const matching = result.value.items.filter(
          (r) =>
            r.kind === 'snapshot' &&
            r.data.type === 'return' &&
            r.source.externalId === shopify?.returnId,
        );
        if (matching.length !== 1) return null;
        const row = matching[0]!;
        if (row.kind !== 'snapshot' || row.data.type !== 'return') return null;

        return {
          observedAt: row.observedAt,
          evidenceRefs: [row.id],
          complete:
            result.value.completeness === 'complete' &&
            !result.value.nextCursor,
          lines: row.data.lines.map((l) => ({
            source: l.orderLine,
            quantity: l.quantity.amount,
            received: l.receivedQuantity,
            restocked: l.restockedQuantity,
          })),
        };
      });
      const wawi = await safe(async () => {
        const result = await runtime.read(context, {
          connectionId: root.request.replacement.wawiConnectionId,
          capability: 'returns.exchange.reservation.read',
          version: '0',
          input: { operationId: root.id, item: root.request.replacement.item },
        });
        if (!result.ok) throw new Error('Wawi replacement unavailable');

        return result.value;
      });
      const stock = [];
      for (const action of actions.filter(
        (a) => a.kind === 'restock' && a.sent,
      ))
        stock.push({
          action,
          proof: await safe(() => settlement.proof(context, action)),
        });

      return { shopify, price, returns, wawi, stock };
    },
  };
}
