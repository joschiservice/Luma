import type { TenantDatabase } from '@luma/platform';

import type { WatchState } from './adapter.js';

/** Reads and records one connection's Gmail push registration in tenant-scoped storage. */
export function createWatchStore(
  db: TenantDatabase,
  tenantId: string,
  connectionId: string,
) {
  return {
    async load(): Promise<WatchState | null> {
      return db.transaction(tenantId, async (tx) => {
        const result = await tx.query<{
          topic: string;
          history_id: string;
          expires_at: Date;
        }>(
          'SELECT topic,history_id,expires_at FROM gmail_watches WHERE tenant_id=$1 AND connection_id=$2',
          [tenantId, connectionId],
        );
        const row = result.rows[0];

        return row
          ? {
              topic: row.topic,
              historyId: row.history_id,
              expiresAt: new Date(row.expires_at).toISOString(),
            }
          : null;
      });
    },
    async save(state: WatchState) {
      await db.transaction(tenantId, async (tx) => {
        await tx.query(
          `INSERT INTO gmail_watches(tenant_id,connection_id,topic,history_id,expires_at,updated_at)
           VALUES($1,$2,$3,$4,$5,now())
           ON CONFLICT (tenant_id,connection_id) DO UPDATE
           SET topic=excluded.topic,history_id=excluded.history_id,expires_at=excluded.expires_at,updated_at=now()`,
          [
            tenantId,
            connectionId,
            state.topic,
            state.historyId,
            state.expiresAt,
          ],
        );
      });
    },
  };
}
