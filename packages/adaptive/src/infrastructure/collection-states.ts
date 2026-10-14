import type { TenantDatabase } from '@luma/platform';

import type { CollectionStatesStore } from '../application/collection-states.js';
import type { StoredCollectionState } from '../domain/collection-states.js';
import { collectionsValidation } from './collections-validation.js';

type Row = { document: unknown; sequence: string; updated_at: Date };

function stored(row: Row): StoredCollectionState {
  return {
    state: collectionsValidation.state(row.document),
    sequence: Number(row.sequence),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Stores each member's list state per page under the tenant's row security. */
export function createCollectionStatesStore(
  db: TenantDatabase,
): CollectionStatesStore {
  return {
    get: (tenantId, userId, domain) =>
      db.transaction(tenantId, async (tx) => {
        const result = await tx.query<Row>(
          'SELECT document,sequence,updated_at FROM adaptive_collection_states WHERE tenant_id=$1 AND user_id=$2 AND domain=$3',
          [tenantId, userId, domain],
        );

        return result.rows[0] ? stored(result.rows[0]) : null;
      }),
    save: (tenantId, userId, domain, value) =>
      db.transaction(tenantId, async (tx) => {
        // A save only replaces an older sequence; the current row is returned either way.
        await tx.query(
          `INSERT INTO adaptive_collection_states(tenant_id,user_id,domain,document,sequence,updated_at)
           VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT (tenant_id,user_id,domain) DO UPDATE SET document=EXCLUDED.document,
            sequence=EXCLUDED.sequence,updated_at=EXCLUDED.updated_at
           WHERE adaptive_collection_states.sequence < EXCLUDED.sequence`,
          [
            tenantId,
            userId,
            domain,
            JSON.stringify(value.state),
            value.sequence,
            value.updatedAt,
          ],
        );
        const result = await tx.query<Row>(
          'SELECT document,sequence,updated_at FROM adaptive_collection_states WHERE tenant_id=$1 AND user_id=$2 AND domain=$3',
          [tenantId, userId, domain],
        );

        const row = result.rows[0];
        if (!row) throw new Error('List state was not stored.');

        return stored(row);
      }),
    remove: (tenantId, userId, domain) =>
      db.transaction(tenantId, async (tx) => {
        const result = await tx.query(
          domain
            ? 'DELETE FROM adaptive_collection_states WHERE tenant_id=$1 AND user_id=$2 AND domain=$3'
            : 'DELETE FROM adaptive_collection_states WHERE tenant_id=$1 AND user_id=$2',
          domain ? [tenantId, userId, domain] : [tenantId, userId],
        );

        return result.rowCount ?? 0;
      }),
  };
}
