import type { Permission, TenantContext } from '@luma/identity';
import {
  hasPermission,
  IdentityError,
  requirePermission,
  requireTenant,
} from '@luma/identity';
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

/** The read permission of the area each chart counts, required on top of `insights.read`. */
const chartPermissions = {
  orders: 'orders.read',
  fulfillment: 'fulfillment.read',
  stock: 'inventory.read',
  cases: 'issues.read',
  procurement: 'procurement.read',
} as const satisfies Record<InsightChart, Permission>;

/** How old a chart's evaluation time may be when its records are listed. */
const maxRecordLagMs = 15 * 60 * 1000;

const badRequest = (message: string) =>
  Object.assign(new Error(message), { statusCode: 400, expose: true });

/**
 * Creates the operational charts. Commerce charts read canonical projections in one
 * read-only, repeatable-read snapshot under tenant row security. Stock risk and purchase-order
 * stages come from the procurement owner, which evaluates them in code. A chart and its record
 * list share the same rules and evaluation time, so their totals agree. Readers need
 * `insights.read` and the read permission of the chart's area; otherwise reads fail with 403.
 * Records keep links to issues and purchase orders only when the reader can read those.
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

  async function authorize(context: TenantContext, chart: InsightChart) {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Sign in again to continue.');
    requirePermission(fresh, 'insights.read');
    requirePermission(fresh, chartPermissions[chart]);

    return fresh;
  }

  async function read<T>(
    context: TenantContext,
    chart: InsightChart,
    operation: (
      tx: SqlTransaction,
      scoped: TenantDatabase,
      fresh: TenantContext,
    ) => Promise<T>,
  ) {
    const fresh = await authorize(context, chart);

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
    return deps.procurement(await authorize(context, 'procurement'));
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
        chart,
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

      return read(context, chart, async (tx, scoped, fresh) => {
        if (chart === 'orders') {
          const result = await orderRecords(
            tx,
            deps.orders,
            fresh.tenantId,
            query,
            asOf,
          );

          return list(
            hasPermission(fresh, 'issues.read')
              ? result
              : {
                  ...result,
                  items: result.items.map((item) =>
                    item.kind === 'order'
                      ? { ...item, attentionIssueIds: [] }
                      : item,
                  ),
                },
          );
        }
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

        const records = stockRecords(positions, labels, query);

        return list(
          hasPermission(fresh, 'procurement.read')
            ? records
            : {
                ...records,
                items: records.items.map((item) =>
                  item.kind === 'stock_position'
                    ? { ...item, purchaseOrderIds: [] }
                    : item,
                ),
              },
        );
      });
    },
  };
}
