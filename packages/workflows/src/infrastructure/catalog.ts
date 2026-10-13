import { IdentityError } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import type { WorkflowCatalogStore } from '../application/catalog.js';
import type { PlaybookOutcome, PlaybookRun } from '../application/playbook.js';
import type { PlaybookVersion } from '../domain/playbook.js';
import { canonicalPlaybook, compilePlaybook } from './playbooks/schema.js';
import { compileProcessWorkflow } from './process-schema.js';
import { createProcessStepStore } from './process-store.js';
import { compileWorkflow } from './workflow-schema.js';

/** Rechecks the stored digest before a published native version can be used. */
export const compilePublishedWorkflow = (input: unknown) =>
  input &&
  typeof input === 'object' &&
  'format' in input &&
  input.format === 'workflow/2'
    ? compileProcessWorkflow(input)
    : compileWorkflow(input);

/** Stores native and legacy versions in the existing immutable, tenant-isolated catalog. */
export function createWorkflowCatalogStore(
  db: TenantDatabase,
): WorkflowCatalogStore {
  const steps = createProcessStepStore(db);

  return {
    cancelCode: (context, definitionId, runId, stepId) =>
      db.transaction(context.tenantId, async (tx) => {
        const row = (
          await tx.query<{ document: unknown }>(
            'SELECT v.document FROM workflow_trigger_runs r JOIN playbook_versions v ON v.tenant_id=r.tenant_id AND v.definition_id=r.definition_id AND v.version=r.version WHERE r.tenant_id=$1 AND r.id=$2 AND r.definition_id=$3',
            [context.tenantId, runId, definitionId],
          )
        ).rows[0];
        const version = row ? compilePublishedWorkflow(row.document) : null;
        const step =
          version?.format === 'workflow/2'
            ? version.steps.find(
                (item) => item.id === stepId && item.kind === 'code',
              )
            : null;
        if (!step || step.kind !== 'code')
          throw new IdentityError(404, 'NOT_FOUND', 'Code Step not found.');
        await tx.query(
          "INSERT INTO workflow_code_records(tenant_id,run_id,step_id,record_key,document) VALUES($1,$2,$3,'cancelled',$4) ON CONFLICT DO NOTHING",
          [
            context.tenantId,
            runId,
            stepId,
            { artifactDigest: step.artifactDigest, value: true },
          ],
        );
      }),
    processSteps: steps.list,
    versions: (context, id) =>
      db.transaction(context.tenantId, async (tx) => {
        const result = await tx.query<{ document: unknown }>(
          "SELECT v.document FROM playbook_versions v WHERE v.tenant_id=$1 AND ($2::text IS NULL OR v.definition_id=$2) AND v.document->>'format' IN ('workflow/1','workflow/2') AND NOT EXISTS(SELECT 1 FROM workflow_package_archives a WHERE a.tenant_id=v.tenant_id AND a.definition_id=v.definition_id AND a.archived)",
          [context.tenantId, id ?? null],
        );

        return result.rows.map((r) => compilePublishedWorkflow(r.document));
      }),
    publish: (context, version) =>
      db.transaction(context.tenantId, async (tx) => {
        const checked = compilePublishedWorkflow(version);
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
