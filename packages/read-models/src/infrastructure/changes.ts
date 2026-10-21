import { hasPermission, requirePermission } from '@luma/identity';
import { gone, type TenantDatabase } from '@luma/platform';

import {
  type ChangeFeed,
  type ChangeItem,
  changeReadPermissions,
  type ChangeRecordType,
} from '../application/changes.js';
import {
  type ChangePosition,
  changeRetentionDays,
  feedStart,
  readChangeCursor,
  writeChangeCursor,
} from '../domain/changes.js';

const badRequest = (message: string) =>
  Object.assign(new Error(message), { statusCode: 400, expose: true });

const changeTypes = Object.keys(changeReadPermissions) as ChangeRecordType[];

// Rows of transactions older than the oldest one still running. Every earlier row is committed
// and visible in this snapshot, and no later commit can add a row before them.
const settled = 'xact < pg_snapshot_xmin(pg_current_snapshot())';

type ChangeRow = ChangePosition & {
  type: ChangeRecordType;
  recordId: string;
  operation: ChangeItem['operation'];
  recordedAt: Date;
};

/** The later of two positions. */
function later(a: ChangePosition, b: ChangePosition) {
  const [ax, bx] = [BigInt(a.xact), BigInt(b.xact)];

  return ax > bx || (ax === bx && BigInt(a.id) > BigInt(b.id)) ? a : b;
}

/**
 * Reads the workspace's change feed in a consistent snapshot. Cursors hold a feed position, so
 * they work with any type filter.
 */
export function createChangeFeed(db: TenantDatabase): ChangeFeed {
  return {
    async list(context, query) {
      for (const type of query.types ?? [])
        requirePermission(context, changeReadPermissions[type]);
      const types =
        query.types ??
        changeTypes.filter((type) =>
          hasPermission(context, changeReadPermissions[type]),
        );
      const after =
        query.after === undefined ? feedStart : readChangeCursor(query.after);
      if (!after)
        throw badRequest(
          'This cursor is not valid. Request changes without `after` to get the current position.',
        );

      return await db.transaction(
        context.tenantId,
        async (tx) => {
          const head = (
            await tx.query<ChangePosition>(
              `SELECT xact::text AS xact,id::text AS id FROM (
               (SELECT xact,id FROM workspace_changes WHERE tenant_id=$1 AND ${settled} ORDER BY xact DESC,id DESC LIMIT 1)
               UNION ALL SELECT xact,id FROM workspace_change_horizons WHERE tenant_id=$1) p
              ORDER BY xact DESC,id DESC LIMIT 1`,
              [context.tenantId],
            )
          ).rows[0];
          if (query.after === undefined)
            return {
              items: [],
              cursor: writeChangeCursor(head ?? feedStart),
              hasMore: false,
            };
          const expired = await tx.query(
            'SELECT 1 FROM workspace_change_horizons WHERE tenant_id=$1 AND (xact,id) > ($2::xid8,$3::bigint)',
            [context.tenantId, after.xact, after.id],
          );
          if (expired.rowCount)
            throw gone(
              `Changes older than ${changeRetentionDays} days are no longer kept. Read every record again, starting from a new position.`,
            );
          const rows = (
            await tx.query<ChangeRow>(
              `SELECT xact::text AS xact,id::text AS id,record_type AS type,record_id AS "recordId",
                operation,recorded_at AS "recordedAt"
              FROM workspace_changes WHERE tenant_id=$1 AND (xact,id) > ($2::xid8,$3::bigint)
               AND ${settled} AND record_type=ANY($4::text[])
              ORDER BY xact,id LIMIT $5`,
              [context.tenantId, after.xact, after.id, types, query.limit + 1],
            )
          ).rows;
          const page = rows.slice(0, query.limit);
          const last = page.at(-1);
          const hasMore = rows.length > query.limit;

          return {
            items: page.map((row) => ({
              type: row.type,
              id: row.recordId,
              operation: row.operation,
              recordedAt: row.recordedAt.toISOString(),
            })),
            // The last page has seen every settled row up to the head, including types it leaves
            // out, so the next request starts there.
            cursor: writeChangeCursor(
              hasMore && last ? last : later(head ?? after, after),
            ),
            hasMore,
          };
        },
        { readOnlySnapshot: true },
      );
    },
  };
}
