import type { TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import type { WorkflowDraftContent } from '../domain/draft.js';
import { draftFromVersion } from '../domain/draft.js';
import type {
  HistoricalProcessCapture,
  ImprovementEvidence,
} from '../domain/workflow-improvement.js';
import { compileProcessWorkflow } from './process-schema.js';

/** Reads only owner-retained native runs linked to the verified incident and exact baseline semantics. */
export function createImprovementHistoryReader(
  db: TenantDatabase,
  hash: (value: unknown) => string,
) {
  return async (
    context: TenantContext,
    evidence: ImprovementEvidence,
    baseline: WorkflowDraftContent,
  ): Promise<HistoricalProcessCapture[]> =>
    db.transaction(
      context.tenantId,
      async (tx) => {
        await tx.query("SET LOCAL statement_timeout='3000ms'");
        const rows = (
          await tx.query<{
            run: HistoricalProcessCapture['run'];
            version: unknown;
            outputs: HistoricalProcessCapture['outputs'];
          }>(
            `
      SELECT r.document AS run,v.document AS version,COALESCE((SELECT jsonb_agg(s.document ORDER BY sequence) FROM workflow_process_steps s WHERE s.tenant_id=r.tenant_id AND s.run_id=r.id),'[]') AS outputs
      FROM workflow_trigger_runs r JOIN playbook_versions v ON v.tenant_id=r.tenant_id AND v.definition_id=r.definition_id AND v.version=r.version
      WHERE r.tenant_id=$1 AND r.definition_id=$2 AND v.document->>'format'='workflow/2'
        AND r.version_digest=v.digest AND r.document->'evidence'->>'sourceId'=$3
        AND r.document->'context'->'inputs'->>'caseId'=$3
        AND v.document->'applicability'->'trigger'->>'issueType'=$4
      ORDER BY r.document->>'createdAt' DESC,r.id LIMIT 10`,
            [
              context.tenantId,
              baseline.definition.id,
              evidence.incidentId,
              evidence.pattern,
            ],
          )
        ).rows;

        return rows.flatMap((row) => {
          const version = compileProcessWorkflow(row.version);
          if (
            row.run.tenantId !== context.tenantId ||
            row.run.versionDigest !== version.digest ||
            hash(draftFromVersion(version)) !== hash(baseline)
          )
            return [];

          return [{ run: row.run, version, outputs: row.outputs }];
        });
      },
      { readOnlySnapshot: true },
    );
}
