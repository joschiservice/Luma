import type { InstalledReturnRuntime } from '@luma/connections/composition';
import type {
  ReturnExchangeSystem,
  ReturnRead,
} from '@luma/orders/composition';

import { createReturnExchangeSystem } from './return-exchanges.js';
import { citedReturnReads, returnRead } from './return-reads.js';
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
      // Every leg's evidence references name one of these reads; orders stores those it cites.
      const reads: ReturnRead[] = [];
      const cited = <T extends { reads: ReturnRead[] }>(
        leg: T | null,
      ): Omit<T, 'reads'> | null => {
        if (!leg) return null;
        const { reads: legReads, ...rest } = leg;
        reads.push(...legReads);

        return rest;
      };
      const shopify = cited(
        process?.sent
          ? await safe(() => exchange.proof(context, process))
          : null,
      );
      const price = cited(
        process?.sent
          ? await safe(async () => {
              const result = await runtime.read(context, {
                connectionId: value.connectionId,
                capability: 'returns.exchange.price.read',
                version: '0',
                input: { operationId: root.id, plan: process.plan },
              });
              if (!result.ok) throw new Error('Replacement price unavailable');

              return {
                ...result.value,
                reads: citedReturnReads(result.value.reads),
              };
            })
          : null,
      );
      const returns = cited(
        await safe(async () => {
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
          if (row.kind !== 'snapshot' || row.data.type !== 'return')
            return null;
          const complete =
            result.value.completeness === 'complete' &&
            !result.value.nextCursor;

          return {
            observedAt: row.observedAt,
            evidenceRefs: [row.id],
            reads: [returnRead(row, complete ? 'complete' : 'partial')],
            complete,
            lines: row.data.lines.map((l) => ({
              source: l.orderLine,
              quantity: l.quantity.amount,
              received: l.receivedQuantity,
              restocked: l.restockedQuantity,
            })),
          };
        }),
      );
      const wawi = cited(
        await safe(async () => {
          const result = await runtime.read(context, {
            connectionId: root.request.replacement.wawiConnectionId,
            capability: 'returns.exchange.reservation.read',
            version: '0',
            input: {
              operationId: root.id,
              item: root.request.replacement.item,
            },
          });
          if (!result.ok) throw new Error('Wawi replacement unavailable');

          return {
            ...result.value,
            reads: citedReturnReads(result.value.reads),
          };
        }),
      );
      const stock = [];
      for (const action of actions.filter(
        (a) => a.kind === 'restock' && a.sent,
      ))
        stock.push({
          action,
          proof: cited(await safe(() => settlement.proof(context, action))),
        });

      return { shopify, price, returns, wawi, stock, reads };
    },
  };
}
