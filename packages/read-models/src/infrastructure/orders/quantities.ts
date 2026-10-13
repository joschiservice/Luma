import type { AuthorityReader } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import { requirePermission, requireTenant } from '@luma/identity';
import { orderComparisonPolicy } from '@luma/orders';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';
import type {
  OrderLineSource,
  OrderQuantities,
  OrderQuantitySources,
} from '@luma/resolution';

import { readSourceFacts } from './detail-facts.js';
import { resolveOrderEntity } from './identity-references.js';
import type { OrderReadQueries } from './list-query.js';
import { currentUnits } from './source-lines.js';

const iso = (value: string | null | undefined) =>
  value ? new Date(value).toISOString() : null;

type ReadRow = {
  connectionId: string;
  provider: string;
  kind: 'order' | 'fulfillment';
  snapshotId: string;
  observationId: string;
  observedAt: Date;
  sourceUpdatedAt: Date | null;
  externalId: string | null;
  scopeKey: string | null;
};

/** Current order and fulfilment reads of an order per source, the order read first. */
async function currentReads(
  tx: SqlTransaction,
  tenantId: string,
  orderId: string,
) {
  const rows = (
    await tx.query<ReadRow>(
      `SELECT p.connection_id::text AS "connectionId",c.document->>'provider' AS provider,s.kind,
        s.id::text AS "snapshotId",s.observation_id::text AS "observationId",s.observed_at AS "observedAt",
        s.source_updated_at AS "sourceUpdatedAt",m.external_id AS "externalId",m.scope_key AS "scopeKey"
       FROM orders_projections p
       JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
       JOIN connector_installations c ON c.tenant_id=p.tenant_id AND c.id=p.connection_id
       LEFT JOIN LATERAL (SELECT external_id,scope_key FROM connector_source_mappings
        WHERE tenant_id=$1 AND connection_id=p.connection_id AND resource='order' AND canonical_id=p.entity_id
        ORDER BY created_at,id LIMIT 1) m ON s.kind='order'
       WHERE p.tenant_id=$1 AND ((s.kind='order' AND p.entity_id=$2) OR (s.kind='fulfillment' AND s.order_id=$2))
       ORDER BY p.connection_id,s.kind DESC,s.observed_at,s.id`,
      [tenantId, orderId],
    )
  ).rows;
  const reads = new Map<
    string,
    Omit<OrderLineSource, 'quantity'> & { orderRead: boolean }
  >();
  for (const row of rows) {
    const read = reads.get(row.connectionId) ?? {
      connectionId: row.connectionId,
      provider: row.provider,
      order: null,
      sourceUpdatedAt: null,
      evidence: [],
      orderRead: false,
    };
    const evidence = {
      snapshotId: row.snapshotId,
      observationId: row.observationId,
      observedAt: row.observedAt.toISOString(),
    };
    if (row.kind === 'order') {
      read.orderRead = true;
      read.evidence.unshift(evidence);
      read.order =
        row.externalId === null
          ? null
          : { externalId: row.externalId, scopeKey: row.scopeKey ?? '' };
      read.sourceUpdatedAt = row.sourceUpdatedAt?.toISOString() ?? null;
    } else read.evidence.push(evidence);
    reads.set(row.connectionId, read);
  }

  return reads;
}

/**
 * Reads orders for scheduled quantity detection from the orders owner's maintained comparison:
 * candidates whose sources differ on a line's current units, and one order's current units per
 * line and source with the reads behind them. Lines are matched as comparisons match them, and
 * a complete source report without the line has zero units. Requires `orders.read`. Hidden
 * sources are left out, and an order with a hidden source counts as incomplete.
 */
export function createOrderQuantities(
  db: TenantDatabase,
  queries: Pick<OrderReadQueries, 'state'>,
  authority: (db: TenantDatabase) => AuthorityReader,
  excludedSources: (
    context: TenantContext,
  ) => Promise<string[]> = async () => [],
  now = () => new Date(),
): Pick<OrderQuantitySources, 'candidates' | 'quantities'> {
  async function read<T>(
    context: TenantContext,
    operation: (
      tx: SqlTransaction,
      scoped: TenantDatabase,
      asOf: string,
      hidden: string[],
    ) => Promise<T>,
  ) {
    requireTenant(context, context.tenantId);
    requirePermission(context, 'orders.read');
    const hidden = await excludedSources(context);
    const asOf = now().toISOString();

    return db.transaction(
      context.tenantId,
      async (tx) => {
        await tx.query(
          "SELECT set_config('app.hidden_order_sources',$1,true)",
          [`{${hidden.join(',')}}`],
        );
        await tx.query("SET LOCAL statement_timeout = '4000ms'");
        const scoped: TenantDatabase = {
          transaction: async (tenantId, next) => {
            requireTenant(context, tenantId);

            return next(tx);
          },
        };

        return operation(tx, scoped, asOf, hidden);
      },
      { readOnlySnapshot: true },
    );
  }

  return {
    candidates: (context, { include, changedBefore, limit }) =>
      read(context, async (tx) =>
        (
          await tx.query<{ id: string }>(
            // Separate branches keep the differing-orders lookup on its partial index.
            `SELECT id FROM (
               SELECT DISTINCT ON (id) id,rank,read_at FROM (
                 SELECT o.entity_id::text AS id,0 AS rank,o.comparison_read_at AS read_at FROM orders_list o
                 WHERE o.tenant_id=$1 AND o.selected AND o.entity_id=ANY($3::uuid[])
                 UNION ALL
                 SELECT o.entity_id::text,1,o.comparison_read_at FROM orders_list o
                 WHERE o.tenant_id=$1 AND o.selected AND o.comparison_raw='different'
                  AND o.comparison_differences @> '[{"field":"currentQuantity"}]'::jsonb
                  AND o.comparison_confirm_after-make_interval(secs=>$4)<=$2::timestamptz
               ) found ORDER BY id,rank
             ) candidates ORDER BY rank,read_at NULLS FIRST,id LIMIT $5`,
            [
              context.tenantId,
              changedBefore,
              include,
              orderComparisonPolicy.graceSeconds,
              limit,
            ],
          )
        ).rows.map((row) => row.id),
      ),
    quantities: (context, id) =>
      read(context, async (tx, scoped, asOf, hidden) => {
        const orderId = await resolveOrderEntity(tx, context.tenantId, id);
        const facts = await readSourceFacts(
          tx,
          queries,
          context.tenantId,
          orderId,
          asOf,
        );
        if (!facts) return null;
        const reads = await currentReads(tx, context.tenantId, orderId);
        const current = facts.sources.filter(
          (source) =>
            !source.deleted && reads.get(source.connectionId)?.orderRead,
        );
        const snapshot = await authority(scoped).read(context);
        const lines = snapshot.groups.find(
          (group) => group.group === 'order_lines',
        );
        const { timing, incomplete } = facts.comparison;
        const keys = [
          ...new Set(
            current.flatMap((source) =>
              source.lines.flatMap((line) =>
                line.comparisonKey ? [line.comparisonKey] : [],
              ),
            ),
          ),
        ].sort();

        return {
          orderId,
          complete:
            !!timing &&
            timing.raw !== 'inconclusive' &&
            !incomplete &&
            !facts.sources.some((source) =>
              hidden.includes(source.connectionId),
            ),
          changedAt: timing?.confirmAfter
            ? new Date(
                Date.parse(timing.confirmAfter) -
                  orderComparisonPolicy.graceSeconds * 1000,
              ).toISOString()
            : null,
          oldestReadAt: iso(timing?.readAt),
          latestReadAt: iso(timing?.latestReadAt),
          authority: {
            state: lines?.state ?? 'unknown',
            connectionId:
              lines?.state === 'resolved' ? (lines.connectionId ?? null) : null,
            revision: snapshot.revision,
          },
          lines: keys.map((lineKey) => {
            const matching = current.flatMap((source) =>
              source.lines.filter((line) => line.comparisonKey === lineKey),
            );

            return {
              lineKey,
              unit: matching[0]?.unit ?? 'unknown',
              sources: current.map((source): OrderLineSource => {
                const { orderRead, ...read } = reads.get(source.connectionId)!;
                void orderRead;
                const found = source.lines.filter(
                  (line) => line.comparisonKey === lineKey,
                );

                return {
                  ...read,
                  quantity:
                    found.length === 1
                      ? currentUnits(found[0]!)
                      : // A complete report without the line has none of it, as comparisons treat it.
                        !found.length &&
                          source.lines.every((line) => line.comparisonKey)
                        ? '0'
                        : null,
                };
              }),
            };
          }),
        } satisfies OrderQuantities;
      }),
  };
}
