import type { TenantDatabase } from '@luma/platform';

import type { WorkflowCatalogStore } from '../application/catalog.js';
import type { PlaybookOutcome, PlaybookRun } from '../application/playbook.js';
import type { PlaybookVersion } from '../domain/playbook.js';
import { canonicalPlaybook, compilePlaybook } from './playbooks/schema.js';
import { compileWorkflow } from './workflow-schema.js';

/** Stores native and legacy versions in the existing immutable, tenant-isolated catalog. */
export function createWorkflowCatalogStore(
  db: TenantDatabase,
): WorkflowCatalogStore {
  return {
    versions: (context, id) =>
      db.transaction(context.tenantId, async (tx) => {
        const result = await tx.query<{ document: unknown }>(
          "SELECT document FROM playbook_versions WHERE tenant_id=$1 AND ($2::text IS NULL OR definition_id=$2) AND document->>'format'='workflow/1'",
          [context.tenantId, id ?? null],
        );

        return result.rows.map((r) => compileWorkflow(r.document));
      }),
    publish: (context, version) =>
      db.transaction(context.tenantId, async (tx) => {
        const checked = compileWorkflow(version);
        await tx.query(
          'INSERT INTO playbook_definitions(tenant_id,id,document) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [context.tenantId, checked.definition.id, checked.definition],
        );
        const definition = (
          await tx.query<{ document: unknown }>(
            'SELECT document FROM playbook_definitions WHERE tenant_id=$1 AND id=$2',
            [context.tenantId, checked.definition.id],
          )
        ).rows[0];
        if (
          canonicalPlaybook(definition?.document) !==
          canonicalPlaybook(checked.definition)
        )
          throw new Error('Workflow definition is immutable');
        await tx.query(
          'INSERT INTO playbook_versions(tenant_id,definition_id,version,digest,document) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [
            context.tenantId,
            checked.definition.id,
            checked.version,
            checked.digest,
            checked,
          ],
        );
        const row = (
          await tx.query<{ digest: string }>(
            'SELECT digest FROM playbook_versions WHERE tenant_id=$1 AND definition_id=$2 AND version=$3',
            [context.tenantId, checked.definition.id, checked.version],
          )
        ).rows[0];
        if (row?.digest !== checked.digest)
          throw new Error('Workflow version is immutable');
      }),
    resolutionVersions: (context, id) =>
      db.transaction(context.tenantId, async (tx) => {
        const rows = await tx.query<{ document: unknown }>(
          "SELECT document FROM playbook_versions WHERE tenant_id=$1 AND definition_id=$2 AND NOT (document ? 'format')",
          [context.tenantId, id],
        );

        return rows.rows.map((r) => compilePlaybook(r.document));
      }),
    runs: (context, id) =>
      db.transaction(context.tenantId, async (tx) => {
        const rows = await tx.query<{
          run: PlaybookRun;
          version: PlaybookVersion;
          outcomes: PlaybookOutcome[];
        }>(
          `SELECT r.document AS run,v.document AS version,COALESCE((SELECT jsonb_agg(o.document ORDER BY o.sequence) FROM playbook_outcomes o WHERE o.tenant_id=r.tenant_id AND o.run_id=r.id),'[]'::jsonb) AS outcomes FROM playbook_runs r JOIN playbook_versions v ON v.tenant_id=r.tenant_id AND v.definition_id=r.definition_id AND v.version=r.version WHERE r.tenant_id=$1 AND r.definition_id=$2 ORDER BY (r.document->>'createdAt')::timestamptz DESC,r.id DESC LIMIT 50`,
          [context.tenantId, id],
        );

        return rows.rows.map((r) => ({
          ...r,
          version: compilePlaybook(r.version),
        }));
      }),
  };
}
