import type { TenantContext } from '@luma/identity';
import { IdentityError, requireTenant } from '@luma/identity';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';

import type {
  InsightChart,
  InsightChartResponse,
  InsightQuery,
  InsightRecordList,
  InsightRecordQuery,
  Insights,
  PurchaseOrderStage,
  StockRiskPosition,
} from '../../application/insights.js';
import type { OrderReadQueries } from '../orders/list-query.js';
import { caseChart, caseRecords } from './cases.js';
import { readConnectionLabels } from './coverage.js';
import {
  procurementChart,
  procurementRecords,
  stockChart,
  stockRecords,
} from './current-state.js';
import { fulfillmentChart, fulfillmentRecords } from './fulfillment.js';
import { orderChart, orderRecords } from './orders.js';

/** How old a chart's evaluation time may be when its records are listed. */
const maxRecordLagMs = 15 * 60 * 1000;

const badRequest = (message: string) =>
  Object.assign(new Error(message), { statusCode: 400, expose: true });

/**
 * Creates the operational charts. Commerce charts read canonical projections in one
 * read-only, repeatable-read snapshot under tenant row security. Stock risk and purchase-order
 * stages come from the procurement owner, which evaluates them in code. A chart and its record
 * list share the same rules and evaluation time, so their totals agree.
 */
export function createInsights(
  db: TenantDatabase,
  deps: {
    orders: OrderReadQueries;
    /** The exceptions owner's `caseTimelineQuery`. */
    cases: string;
    /** Classifies monitored stock positions inside the given snapshot. */
    stock(
      db: TenantDatabase,
    ): (
      context: TenantContext,
      asOf: string,
      connectionId: string | undefined,
    ) => Promise<StockRiskPosition[]>;
    /** Lists purchase orders with their current stage for the refreshed reader. */
    procurement(context: TenantContext): Promise<PurchaseOrderStage[]>;
    refreshContext(context: TenantContext): Promise<TenantContext>;
    now?: () => Date;
  },
): Insights {
  const now = deps.now ?? (() => new Date());

  async function read<T>(
    context: TenantContext,
    operation: (
      tx: SqlTransaction,
      scoped: TenantDatabase,
      fresh: TenantContext,
    ) => Promise<T>,
  ) {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Sign in again to continue.');

    return db.transaction(
      fresh.tenantId,
      async (tx) => {
        await tx.query("SET LOCAL statement_timeout = '4000ms'");
        await tx.query('SET LOCAL jit = off');
        const scoped: TenantDatabase = {
          transaction: async (tenantId, next) => {
            requireTenant(fresh, tenantId);

            return next(tx);
          },
        };

        return operation(tx, scoped, fresh);
      },
      { readOnlySnapshot: true },
    );
  }

  async function stock(
    tx: SqlTransaction,
    scoped: TenantDatabase,
    fresh: TenantContext,
    asOf: string,
    connectionId: string | undefined,
  ) {
    const positions = await deps.stock(scoped)(fresh, asOf, connectionId);
    const labels = await readConnectionLabels(
      tx,
      fresh.tenantId,
      positions.map((p) => p.connectionId),
    );

    return { positions, labels };
  }

  async function procurement(context: TenantContext) {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);

    return deps.procurement(fresh);
  }

  /** Validates a chart's evaluation time: not in the future and at most 15 minutes old. */
  function evaluationTime(asOf: string | undefined) {
    const current = now();
    if (!asOf) return current.toISOString();
    const time = Date.parse(asOf);
    if (time > current.getTime() || current.getTime() - time > maxRecordLagMs)
      throw badRequest(
        'The chart is more than 15 minutes old. Refresh it to list its records.',
      );

    return new Date(time).toISOString();
  }

  return {
    async chart(context, chart: InsightChart, query: InsightQuery) {
      const asOf = now().toISOString();
      if (chart === 'procurement')
        return procurementChart(await procurement(context), asOf);

      return read(
        context,
        async (tx, scoped, fresh): Promise<InsightChartResponse> => {
          if (chart === 'orders')
            return orderChart(tx, fresh.tenantId, query, asOf);
          if (chart === 'fulfillment')
            return fulfillmentChart(tx, fresh.tenantId, query, asOf);
          if (chart === 'cases')
            return caseChart(tx, deps.cases, fresh.tenantId, query, asOf);
          const { positions, labels } = await stock(
            tx,
            scoped,
            fresh,
            asOf,
            query.connectionId,
          );

          return stockChart(positions, labels, asOf);
        },
      );
    },
    async records(context, chart, query: InsightRecordQuery) {
      const asOf = evaluationTime(query.asOf);
      const list = (result: {
        totalCount: number;
        items: InsightRecordList['items'];
      }): InsightRecordList => ({
        chart,
        point: query.point ?? null,
        series: query.series ?? null,
        totalCount: result.totalCount,
        items: result.items,
        nextOffset:
          query.offset + result.items.length < result.totalCount
            ? query.offset + result.items.length
            : null,
        asOf,
      });
      if (chart === 'procurement')
        return list(procurementRecords(await procurement(context), query));

      return read(context, async (tx, scoped, fresh) => {
        if (chart === 'orders')
          return list(
            await orderRecords(tx, deps.orders, fresh.tenantId, query, asOf),
          );
        if (chart === 'fulfillment')
          return list(
            await fulfillmentRecords(tx, fresh.tenantId, query, asOf),
          );
        if (chart === 'cases')
          return list(
            await caseRecords(tx, deps.cases, fresh.tenantId, query, asOf),
          );
        const { positions, labels } = await stock(
          tx,
          scoped,
          fresh,
          asOf,
          query.connectionId,
        );

        return list(stockRecords(positions, labels, query));
      });
    },
  };
}
