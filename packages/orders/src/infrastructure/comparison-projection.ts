import { createHash } from 'node:crypto';

import type { SqlTransaction } from '@luma/platform';

import type { CanonicalSnapshot } from '../application/projections.js';
import {
  compareOrderSources,
  comparisonFacts,
  type ComparisonSource,
  orderComparisonPolicy,
  sharedComparisonLines,
} from '../domain/source-comparison.js';

type SnapshotRow = {
  shippingView: boolean;
  orderId: string;
  snapshotId: string;
  document: CanonicalSnapshot;
  signature: string | null;
  changedAt: Date | null;
};

/** Reads compared business facts under parent locks, retaining change times for the caller’s atomic list upsert. */
export async function readOrderComparisons(
  tx: SqlTransaction,
  tenant: string,
  ids: string[],
) {
  const { rows } = await tx.query<SnapshotRow>(
    `SELECT COALESCE(s.order_id,s.entity_id) AS "orderId",s.id AS "snapshotId",s.document,
    COALESCE(c.document->>'provider',c.document->'target'->>'kind','')='starshipit' AS "shippingView",
    o.comparison_signature AS signature,o.comparison_changed_at AS "changedAt"
    FROM orders_snapshots s JOIN orders_projections p ON p.tenant_id=s.tenant_id AND p.entity_id=s.entity_id
     AND p.connection_id=s.connection_id AND p.snapshot_id=s.id
    LEFT JOIN connector_installations c ON c.tenant_id=s.tenant_id AND c.id=s.connection_id
    LEFT JOIN orders_list o ON o.tenant_id=s.tenant_id AND o.entity_id=s.entity_id AND o.connection_id=s.connection_id
    WHERE s.tenant_id=$1 AND (s.entity_id=ANY($2::uuid[]) OR s.order_id=ANY($2::uuid[]))
     AND s.kind IN ('order','fulfillment')
    ORDER BY s.connection_id,s.entity_id`,
    [tenant, ids],
  );
  const grouped = new Map<string, SnapshotRow[]>();
  for (const row of rows) {
    const group = grouped.get(row.orderId) ?? [];
    group.push(row);
    grouped.set(row.orderId, group);
  }
  const updates = [];
  for (const id of ids) {
    const group = grouped.get(id) ?? [];
    const sources: ComparisonSource[] = group.flatMap((row) =>
      row.document.data.type !== 'order' || row.document.deleted
        ? []
        : [
            {
              ...row.document.data,
              ...(row.shippingView ? { lineCoverage: 'partial' as const } : {}),
              snapshotId: row.snapshotId,
              observationId: row.document.observationId,
              observedAt: row.document.observedAt,
              connectionId: row.document.connectionId,
              fulfillments: group.flatMap((child) =>
                child.document.connectionId !== row.document.connectionId ||
                child.document.data.type !== 'fulfillment'
                  ? []
                  : [
                      {
                        ...child.document.data,
                        deleted: child.document.deleted,
                        snapshotId: child.snapshotId,
                        observationId: child.document.observationId,
                        observedAt: child.document.observedAt,
                      },
                    ],
              ),
            },
          ],
    );
    const shared = sharedComparisonLines(sources);
    const sourceUpdates = sources.map((source) => {
      const signature = createHash('sha256')
        .update(JSON.stringify(comparisonFacts(source, shared)))
        .digest('hex');
      const previous = group.find(
        (row) => row.snapshotId === source.snapshotId,
      )!;
      const times = [
        source.observedAt,
        ...source.fulfillments.map((item) => item.observedAt),
      ].map(Date.parse);
      const changedAt =
        signature === previous.signature && previous.changedAt
          ? previous.changedAt.toISOString()
          : new Date(
              Math.max(
                ...times,
                ...group
                  .filter(
                    (row) => row.document.connectionId === source.connectionId,
                  )
                  .map((row) => Date.parse(row.document.observedAt)),
              ),
            ).toISOString();

      return { connectionId: source.connectionId, signature, changedAt, times };
    });
    const { differences, incomplete } = compareOrderSources(sources);
    const compared = sources.length > 1 || differences.length > 0;
    const times = sourceUpdates.flatMap((item) => item.times);
    const raw = incomplete
      ? 'inconclusive'
      : differences.length
        ? 'different'
        : 'matching';
    const confirmAfter = compared
      ? new Date(
          Math.max(...sourceUpdates.map((item) => Date.parse(item.changedAt))) +
            orderComparisonPolicy.graceSeconds * 1000,
        ).toISOString()
      : null;
    for (const row of group.filter(
      (row) => row.document.data.type === 'order',
    )) {
      const source = sourceUpdates.find(
        (item) => item.connectionId === row.document.connectionId,
      );
      updates.push({
        entity_id: id,
        connection_id: row.document.connectionId,
        signature: source?.signature ?? row.signature,
        changed_at: source?.changedAt ?? row.changedAt?.toISOString() ?? null,
        raw,
        read_at: compared ? new Date(Math.min(...times)).toISOString() : null,
        latest_read_at: compared
          ? new Date(Math.max(...times)).toISOString()
          : null,
        confirm_after: confirmAfter,
        differences,
      });
    }
  }

  return updates;
}
