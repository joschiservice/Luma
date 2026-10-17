import type { TenantDatabase } from '@luma/platform';

import type {
  PlaybookOutcome,
  PlaybookRun,
} from '../../application/playbook.js';
import type { PlaybookLibraryStore } from '../../application/playbook-library.js';
import { presentResolutionRun } from '../../application/run-presentation.js';
import type {
  PlaybookActivation,
  PlaybookVersion,
} from '../../domain/playbook.js';
import type { ActivatePlaybook } from '../../domain/playbook-library.js';
import { compilePlaybook } from './schema.js';

/** Reads tenant-scoped published data and records immutable activation reviews. */
export function createPlaybookLibraryStore(
  db: TenantDatabase,
): PlaybookLibraryStore {
  return {
    versions: (context, id) =>
      db.transaction(context.tenantId, async (tx) => {
        const rows = await tx.query<{ document: PlaybookVersion }>(
          `SELECT document FROM playbook_versions WHERE tenant_id=$1 AND ($2::text IS NULL OR definition_id=$2) AND NOT (document ? 'format') ORDER BY definition_id,version`,
          [context.tenantId, id ?? null],
        );

        return rows.rows.map((r) => r.document);
      }),
    activations: (context, id) =>
      db.transaction(context.tenantId, async (tx) => {
        const rows = await tx.query<{
          document: PlaybookActivation;
          active: boolean;
          actor_id: string | null;
          reviewed_at: string | null;
        }>(
          `SELECT a.document, COALESCE(p.active,false) AS active, r.actor_id, r.created_at::text AS reviewed_at
         FROM playbook_activations a LEFT JOIN action_artifacts p ON p.tenant_id=a.tenant_id AND p.id='playbook:'||a.id::text AND p.version=a.version AND p.digest=a.document->>'artifactDigest'
         LEFT JOIN playbook_activation_reviews r ON r.tenant_id=a.tenant_id AND r.id=a.id
         WHERE a.tenant_id=$1 AND a.definition_id=$2 ORDER BY r.created_at DESC NULLS LAST,a.id`,
          [context.tenantId, id],
        );

        return rows.rows.map(({ document, active, actor_id, reviewed_at }) => ({
          ...document,
          active,
          reviewedBy: actor_id,
          reviewedAt: reviewed_at ? new Date(reviewed_at).toISOString() : null,
        }));
      }),
    review: (context, id) =>
      db.transaction(context.tenantId, async (tx) => {
        const row = (
          await tx.query<{
            definition_id: string;
            actor_id: string;
            request: ActivatePlaybook;
          }>(
            `SELECT definition_id,actor_id,request FROM playbook_activation_reviews WHERE tenant_id=$1 AND id=$2`,
            [context.tenantId, id],
          )
        ).rows[0];

        return row
          ? {
              definitionId: row.definition_id,
              actorId: row.actor_id,
              request: row.request,
            }
          : null;
      }),
    recordReview: (context, id, request) =>
      db.transaction(context.tenantId, async (tx) => {
        await tx.query(
          `INSERT INTO playbook_activation_reviews(tenant_id,id,definition_id,actor_id,request) VALUES($1,$2,$3,$4,$5)`,
          [context.tenantId, request.id, id, context.actor.id, request],
        );
      }),
    runs: (context, id) =>
      db.transaction(context.tenantId, async (tx) => {
        const rows = await tx.query<{
          document: PlaybookRun;
          version: PlaybookVersion;
          outcome: PlaybookOutcome | null;
        }>(
          `SELECT r.document, v.document AS version, o.document AS outcome FROM playbook_runs r
         JOIN playbook_versions v ON v.tenant_id=r.tenant_id AND v.definition_id=r.definition_id AND v.version=r.version
         LEFT JOIN LATERAL (SELECT document FROM playbook_outcomes WHERE tenant_id=r.tenant_id AND run_id=r.id ORDER BY sequence DESC LIMIT 1) o ON true
         WHERE r.tenant_id=$1 AND r.definition_id=$2 ORDER BY r.document->>'createdAt' DESC,r.id DESC LIMIT 50`,
          [context.tenantId, id],
        );

        return rows.rows.map(({ document: run, version, outcome }) =>
          presentResolutionRun(run, compilePlaybook(version), outcome),
        );
      }),
  };
}
