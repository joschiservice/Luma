import { IdentityError } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import type { ViewsStore, ViewsTransaction } from '../application/views.js';
import type { StoredAdaptiveView } from '../domain/views.js';
import { personalViewLimit, sharedViewLimit } from '../domain/views.js';
import { parseStoredView, parseViewRevision } from './views-validation.js';

/** Persists live query definitions and immutable revisions under the tenant transaction. */
export function createViewsStore(db: TenantDatabase): ViewsStore {
  return {
    transaction: (tenantId, operation) =>
      db.transaction(tenantId, async (tx) => {
        // Serializes limit checks for the workspace; view writes are rare and short.
        async function requireCapacity(view: StoredAdaptiveView) {
          await tx.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('adaptive-views:'||$1::text,0))",
            [tenantId],
          );
          const shared = view.sharing.scope !== 'private';
          const result = await tx.query<{ count: number }>(
            shared
              ? "SELECT count(*)::int AS count FROM adaptive_views WHERE tenant_id=$1 AND NOT archived AND sharing_scope<>'private' AND id<>$2"
              : "SELECT count(*)::int AS count FROM adaptive_views WHERE tenant_id=$1 AND NOT archived AND sharing_scope='private' AND owner_id=$3 AND id<>$2",
            shared ? [tenantId, view.id] : [tenantId, view.id, view.ownerId],
          );
          const limit = shared ? sharedViewLimit : personalViewLimit;
          if ((result.rows[0]?.count ?? 0) >= limit)
            throw new IdentityError(
              409,
              'CONFLICT',
              shared
                ? `This workspace already has ${sharedViewLimit} shared views. Archive one before sharing another.`
                : `You already have ${personalViewLimit} personal views. Archive one before saving another.`,
            );
        }

        const store: ViewsTransaction = {
          async list(actorId) {
            // Bounded by the limits: 50 personal views per member and 200 shared views.
            const result = await tx.query<{ document: unknown }>(
              "SELECT document FROM adaptive_views WHERE tenant_id=$1 AND NOT archived AND (owner_id=$2 OR sharing_scope<>'private') ORDER BY updated_at DESC,id LIMIT 250",
              [tenantId, actorId],
            );

            return result.rows.map((row) => parseStoredView(row.document));
          },
          async get(id) {
            const result = await tx.query<{ document: unknown }>(
              'SELECT document FROM adaptive_views WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
              [tenantId, id],
            );

            return result.rows[0]
              ? parseStoredView(result.rows[0].document)
              : null;
          },
          async save(view, changedBy, expectedRevision) {
            if (view.tenantId !== tenantId)
              throw new IdentityError(404, 'NOT_FOUND', 'View not found.');
            if (!view.archived) await requireCapacity(view);
            if (expectedRevision === null) {
              const result = await tx.query(
                'INSERT INTO adaptive_views(tenant_id,id,revision,archived,updated_at,document) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id',
                [
                  tenantId,
                  view.id,
                  view.revision,
                  view.archived,
                  view.updatedAt,
                  JSON.stringify(view),
                ],
              );
              if (!result.rowCount)
                throw new IdentityError(
                  409,
                  'CONFLICT',
                  'This view already exists.',
                );
            } else {
              const result = await tx.query(
                'UPDATE adaptive_views SET revision=$3,archived=$4,updated_at=$5,document=$6 WHERE tenant_id=$1 AND id=$2 AND revision=$7 RETURNING id',
                [
                  tenantId,
                  view.id,
                  view.revision,
                  view.archived,
                  view.updatedAt,
                  JSON.stringify(view),
                  expectedRevision,
                ],
              );
              if (!result.rowCount)
                throw new IdentityError(
                  409,
                  'CONFLICT',
                  'The view changed. Reload it before saving.',
                );
            }
            await tx.query(
              'INSERT INTO adaptive_view_revisions(tenant_id,view_id,revision,document) VALUES($1,$2,$3,$4)',
              [
                tenantId,
                view.id,
                view.revision,
                JSON.stringify({ ...view, changedBy }),
              ],
            );
          },
          async history(id) {
            const result = await tx.query<{ document: unknown }>(
              'SELECT document FROM adaptive_view_revisions WHERE tenant_id=$1 AND view_id=$2 ORDER BY revision DESC LIMIT 101',
              [tenantId, id],
            );

            return {
              items: result.rows
                .slice(0, 100)
                .map((row) => parseViewRevision(row.document)),
              truncated: result.rows.length > 100,
            };
          },
        };

        return operation(store);
      }),
  };
}
