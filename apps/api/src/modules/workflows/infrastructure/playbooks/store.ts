import { z } from 'zod';

import type { TenantContext } from '#modules/identity/index';
import { requireRole } from '#modules/identity/index';
import type { SqlTransaction, TenantDatabase } from '#modules/platform/index';
import type {
  PlaybookOutcome,
  PlaybookRun,
  PlaybookStore,
} from '#modules/workflows/application/playbook';
import type {
  PlaybookActivation,
  PlaybookVersion,
} from '#modules/workflows/domain/playbook';
import {
  canonicalPlaybook,
  compilePlaybook,
  playbookHash,
} from '#modules/workflows/infrastructure/playbooks/schema';

/**
 * Creates tenant-scoped storage for immutable playbook versions, activations, and bound
 * runs.
 */
export function createPlaybookStore(db: TenantDatabase): PlaybookStore {
  function scoped<T>(
    context: TenantContext,
    fn: (tx: SqlTransaction) => Promise<T>,
  ) {
    requireRole(context, ['owner', 'admin']);

    return db.transaction(context.tenantId, fn);
  }

  return {
    publish: (context, version) =>
      scoped(context, async (tx) => {
        await tx.query(
          'INSERT INTO playbook_definitions(tenant_id,id,document) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [context.tenantId, version.definition.id, version.definition],
        );
        const definition = (
          await tx.query<{ document: unknown }>(
            'SELECT document FROM playbook_definitions WHERE tenant_id=$1 AND id=$2',
            [context.tenantId, version.definition.id],
          )
        ).rows[0];
        if (
          canonicalPlaybook(definition?.document) !==
          canonicalPlaybook(version.definition)
        )
          throw new Error('Playbook definition is immutable');
        await tx.query(
          'INSERT INTO playbook_versions(tenant_id,definition_id,version,digest,document) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [
            context.tenantId,
            version.definition.id,
            version.version,
            version.digest,
            version,
          ],
        );
        const row = (
          await tx.query<{ digest: string }>(
            'SELECT digest FROM playbook_versions WHERE tenant_id=$1 AND definition_id=$2 AND version=$3',
            [context.tenantId, version.definition.id, version.version],
          )
        ).rows[0];
        if (row?.digest !== version.digest)
          throw new Error('Playbook version is immutable');
      }),
    version: (context, id, version) =>
      scoped(context, async (tx) => {
        const row = (
          await tx.query<{ document: PlaybookVersion; digest: string }>(
            'SELECT document,digest FROM playbook_versions WHERE tenant_id=$1 AND definition_id=$2 AND version=$3',
            [context.tenantId, id, version],
          )
        ).rows[0];
        if (!row) return null;
        const { digest, ...source } = row.document;
        const compiled = compilePlaybook(source);
        if (compiled.digest !== digest || digest !== row.digest)
          throw new Error('Playbook version digest mismatch');

        return compiled;
      }),
    activate: (context, activation) =>
      scoped(context, async (tx) => {
        await tx.query(
          'INSERT INTO playbook_activations(tenant_id,id,definition_id,version,version_digest,document) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
          [
            context.tenantId,
            activation.id,
            activation.definitionId,
            activation.version,
            activation.versionDigest,
            activation,
          ],
        );
        const row = (
          await tx.query<{ document: PlaybookActivation }>(
            'SELECT document FROM playbook_activations WHERE tenant_id=$1 AND id=$2',
            [context.tenantId, activation.id],
          )
        ).rows[0];
        if (canonicalPlaybook(row?.document) !== canonicalPlaybook(activation))
          throw new Error('Playbook activation is immutable');
      }),
    activation: (context, id) =>
      scoped(
        context,
        async (tx) =>
          (
            await tx.query<{ document: PlaybookActivation }>(
              'SELECT document FROM playbook_activations WHERE tenant_id=$1 AND id=$2',
              [context.tenantId, id],
            )
          ).rows[0]?.document ?? null,
      ),
    bind: (context, run) =>
      scoped(context, async (tx) => {
        z.object({
          incidentId: z.string().uuid(),
          diagnosisRevision: z.number().int().positive(),
        }).parse(run);
        await tx.query(
          'INSERT INTO playbook_runs(tenant_id,id,activation_id,definition_id,version,version_digest,document) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
          [
            context.tenantId,
            run.id,
            run.activationId,
            run.definitionId,
            run.version,
            run.versionDigest,
            run,
          ],
        );
        const row = (
          await tx.query<{ document: PlaybookRun }>(
            'SELECT document FROM playbook_runs WHERE tenant_id=$1 AND id=$2',
            [context.tenantId, run.id],
          )
        ).rows[0];
        if (
          !row ||
          canonicalPlaybook(row.document) !==
            canonicalPlaybook({ ...run, createdAt: row.document.createdAt })
        )
          throw new Error('Playbook run is immutable');

        return row.document;
      }),
    run: (context, id) =>
      scoped(
        context,
        async (tx) =>
          (
            await tx.query<{ document: PlaybookRun }>(
              'SELECT document FROM playbook_runs WHERE tenant_id=$1 AND id=$2',
              [context.tenantId, id],
            )
          ).rows[0]?.document ?? null,
      ),
    record: (context, id, outcome) =>
      scoped(context, async (tx) => {
        await tx.query(
          'INSERT INTO playbook_outcomes(tenant_id,run_id,digest,document) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [context.tenantId, id, playbookHash(outcome), outcome],
        );
      }),
    outcomes: (context, id) =>
      scoped(context, async (tx) =>
        (
          await tx.query<{ document: PlaybookOutcome }>(
            'SELECT document FROM playbook_outcomes WHERE tenant_id=$1 AND run_id=$2 ORDER BY sequence',
            [context.tenantId, id],
          )
        ).rows.map((r) => r.document),
      ),
  };
}
