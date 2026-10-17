import { createHash } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import { requireTenant } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { canonicalJson as canonical, conflict } from '@luma/platform';
import { z } from 'zod';

import type {
  ActivatedArtifact,
  BoundActionStep,
} from '../application/admission.js';
import { parseAction } from './validation.js';

const text = z.string().min(1).max(200);

/** Validates the run and step references accepted by action admission. */
export const parseAdmissionReference = (input: unknown) =>
  z
    .object({
      runId: z.string().uuid(),
      stepId: text,
    })
    .strict()
    .parse(input);

const artifactSchema = z
  .object({
    id: text,
    version: text,
    playbook: z
      .object({
        versionDigest: z.string().regex(/^[a-f0-9]{64}$/),
        policyVersion: text,
        principalIds: z.array(text).min(1).max(100),
        connectionIds: z.array(z.string().uuid()).min(1).max(100),
        targetIds: z.array(z.string().uuid()).min(1).max(100),
      })
      .strict()
      .optional(),
    generation: z
      .object({ kind: z.enum(['manual', 'generated']), reference: text })
      .strict(),
    steps: z
      .record(
        z.string(),
        z
          .object({
            capability: text,
            capabilityVersion: text,
            targetKind: text,
            minimumRisk: z.enum(['low', 'medium', 'high']),
          })
          .strict(),
      )
      .refine(
        (steps) =>
          Object.keys(steps).length > 0 &&
          Object.keys(steps).every((key) => text.safeParse(key).success),
      ),
  })
  .strict();

const digest = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');

/**
 * Provisioning methods stay in trusted composition; workers receive only the admission port.
 * Callers authorize provisioning with their own permission (procurement, workflow activation or
 * an app's permission); execution checks the step's permission again before any effect.
 */
export function createAdmissionStore(db: TenantDatabase) {
  const reader = {
    step: (context: TenantContext, runId: string, stepId: string) =>
      db.transaction(context.tenantId, async (tx) => {
        const row = (
          await tx.query<{ document: BoundActionStep }>(
            'SELECT document FROM action_admission_steps WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3',
            [context.tenantId, runId, stepId],
          )
        ).rows[0];

        return row?.document ?? null;
      }),
    artifact: (context: TenantContext, id: string, version: string) =>
      db.transaction(
        context.tenantId,
        async (tx): Promise<ActivatedArtifact | null> => {
          const row = (
            await tx.query<{
              document: z.infer<typeof artifactSchema>;
              digest: string;
              active: boolean;
            }>(
              'SELECT document,digest,active FROM action_artifacts WHERE tenant_id=$1 AND id=$2 AND version=$3',
              [context.tenantId, id, version],
            )
          ).rows[0];
          if (!row) return null;
          const document = artifactSchema.parse(row.document);
          if (digest(document) !== row.digest)
            throw new Error('Artifact digest mismatch');

          return { ...document, digest: row.digest, active: row.active };
        },
      ),
  };

  return {
    ...reader,
    async activate(context: TenantContext, input: unknown) {
      requireTenant(context, context.tenantId);
      const document = artifactSchema.parse(input);
      const hash = digest(document);
      await db.transaction(context.tenantId, async (tx) => {
        await tx.query(
          'INSERT INTO action_artifacts(tenant_id,id,version,digest,document) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [context.tenantId, document.id, document.version, hash, document],
        );
        const row = (
          await tx.query<{ digest: string; active: boolean }>(
            'SELECT digest,active FROM action_artifacts WHERE tenant_id=$1 AND id=$2 AND version=$3',
            [context.tenantId, document.id, document.version],
          )
        ).rows[0];
        if (row?.digest !== hash || !row.active)
          throw new Error('Artifact version is immutable or revoked');
      });

      return { ...document, digest: hash, active: true };
    },
    async revoke(context: TenantContext, id: string, version: string) {
      requireTenant(context, context.tenantId);
      await db.transaction(context.tenantId, async (tx) => {
        await tx.query(
          'UPDATE action_artifacts SET active=false WHERE tenant_id=$1 AND id=$2 AND version=$3',
          [context.tenantId, id, version],
        );
      });
    },
    async bind(
      context: TenantContext,
      input: Omit<BoundActionStep, 'actionHash'>,
    ) {
      requireTenant(context, input.tenantId);
      const reference = parseAdmissionReference({
        runId: input.runId,
        stepId: input.stepId,
      });
      if (input.subject) {
        z.object({ kind: text, id: text }).strict().parse(input.subject);
        if (
          input.incidentId !== undefined ||
          input.diagnosisRevision !== undefined
        )
          throw new Error('Use one admission subject');
      } else {
        z.string().uuid().parse(input.incidentId);
        z.number().int().positive().parse(input.diagnosisRevision);
      }
      const { action, hash } = parseAction(input.action);
      requireTenant(context, action.tenantId);
      if (
        input.principalId !== context.actor.id ||
        action.proposedBy.id !== context.actor.id ||
        action.proposedBy.kind !== 'user'
      )
        throw new Error('Run principal does not match');
      const artifact = await reader.artifact(
        context,
        input.artifactId,
        input.artifactVersion,
      );
      if (!artifact?.active || artifact.digest !== input.artifactDigest)
        throw new Error('Artifact is not activated');
      if (artifact.playbook || input.eligibilityValidUntil !== undefined)
        z.string().datetime().parse(input.eligibilityValidUntil);
      const document: BoundActionStep = {
        ...input,
        ...reference,
        action,
        actionHash: hash,
      };
      await db.transaction(context.tenantId, async (tx) => {
        // The workflow owner takes the same fence before cancellation. Binding commits
        // before possible effects, so cancellation cannot misclassify a bound first step.
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `workflow-run:${context.tenantId}:${input.runId}`,
        ]);
        const workflow = await tx.query<{ state: string }>(
          'SELECT state FROM workflow_trigger_runs WHERE tenant_id=$1 AND id=$2',
          [context.tenantId, input.runId],
        );
        if (workflow.rows[0]?.state === 'cancelled')
          throw conflict(
            'This workflow run was cancelled before its action was bound.',
          );
        const run = {
          tenantId: input.tenantId,
          runId: input.runId,
          principalId: input.principalId,
          artifactId: input.artifactId,
          artifactVersion: input.artifactVersion,
          artifactDigest: input.artifactDigest,
          ...(input.subject
            ? { subject: input.subject }
            : {
                incidentId: input.incidentId,
                diagnosisRevision: input.diagnosisRevision,
              }),
        };
        await tx.query(
          'INSERT INTO action_admission_runs(tenant_id,id,artifact_id,artifact_version,document) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [
            context.tenantId,
            input.runId,
            input.artifactId,
            input.artifactVersion,
            run,
          ],
        );
        const storedRun = (
          await tx.query<{ document: typeof run }>(
            'SELECT document FROM action_admission_runs WHERE tenant_id=$1 AND id=$2',
            [context.tenantId, input.runId],
          )
        ).rows[0];
        if (!storedRun || canonical(storedRun.document) !== canonical(run))
          throw new Error('Run authority is already bound');

        await tx.query(
          'INSERT INTO action_admission_steps(tenant_id,run_id,step_id,proposal_id,artifact_id,artifact_version,document) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
          [
            context.tenantId,
            input.runId,
            input.stepId,
            action.id,
            input.artifactId,
            input.artifactVersion,
            document,
          ],
        );
        const row = (
          await tx.query<{ document: BoundActionStep }>(
            'SELECT document FROM action_admission_steps WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3',
            [context.tenantId, input.runId, input.stepId],
          )
        ).rows[0];
        if (!row || canonical(row.document) !== canonical(document))
          throw new Error('Logical action is already bound');
      });
    },
  };
}
