import type { TenantDatabase, SqlTransaction } from '#modules/platform/index';
import { IdentityError } from '#modules/identity/index';
import type { Diagnosis, Incident } from '#modules/exceptions/index';
import type { ActivatedArtifact } from '#modules/execution/index';
import type {
  LearningStore,
  ResolutionHistory,
  ResolutionRun,
  LearningEvent,
  LearningFact,
} from '#modules/workflows/application/learning';

const missing = () =>
  new IdentityError(404, 'NOT_FOUND', 'Resolution run or source not found');
const conflict = (message: string): never => {
  throw new IdentityError(409, 'CONFLICT', message);
};
async function lock(tx: SqlTransaction, tenantId: string, runId: string) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `resolution:${tenantId}:${runId}`,
  ]);
}
async function run(
  tx: SqlTransaction,
  tenantId: string,
  incidentId: string,
  id: string,
) {
  const row = (
    await tx.query<{ document: ResolutionRun }>(
      'SELECT document FROM resolution_runs WHERE tenant_id=$1 AND incident_id=$2 AND id=$3',
      [tenantId, incidentId, id],
    )
  ).rows[0];
  if (!row) throw missing();
  return row.document;
}
function evidence(fact: LearningFact) {
  if (fact.kind === 'cause')
    return [...fact.supportingEvidenceRefs, ...fact.contradictingEvidenceRefs];
  if (fact.kind === 'repair_step') return fact.inputEvidenceRefs;
  return fact.evidenceRefs;
}
export function createLearningStore(
  db: TenantDatabase,
  now: () => Date,
): LearningStore {
  return {
    list: (context, incidentId, after) =>
      db.transaction(context.tenantId, async (tx) => {
        const exists = await tx.query(
          'SELECT 1 FROM exceptions WHERE tenant_id=$1 AND id=$2',
          [context.tenantId, incidentId],
        );
        if (!exists.rowCount) throw missing();
        const rows = (
          await tx.query<{ document: ResolutionRun }>(
            'SELECT document FROM resolution_runs WHERE tenant_id=$1 AND incident_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT 51',
            [context.tenantId, incidentId, after ?? null],
          )
        ).rows;
        const items = rows.slice(0, 50).map((row) => row.document);
        return {
          items,
          nextCursor: rows.length > 50 ? items.at(-1)!.id : null,
        };
      }),
    start: (context, incidentId, input) =>
      db.transaction(context.tenantId, async (tx) => {
        await lock(tx, context.tenantId, input.id);
        const previous = (
          await tx.query<{ document: ResolutionRun; matches: boolean }>(
            'SELECT document,(request=$3::jsonb AND actor_id=$4 AND incident_id=$5) AS matches FROM resolution_runs WHERE tenant_id=$1 AND id=$2',
            [context.tenantId, input.id, input, context.actor.id, incidentId],
          )
        ).rows[0];
        if (previous) {
          if (!previous.matches)
            conflict('Run ID already belongs to a different selection');
          return previous.document;
        }
        // Snapshot only reusable context; raw source payloads remain with their owner.
        const diagnosis = (
          await tx.query<{ document: Diagnosis }>(
            'SELECT document FROM exception_diagnoses WHERE tenant_id=$1 AND exception_id=$2 AND revision=$3',
            [context.tenantId, incidentId, input.diagnosisRevision],
          )
        ).rows[0]?.document;
        const artifact = (
          await tx.query<{
            document: ActivatedArtifact;
            digest: string;
            active: boolean;
          }>(
            'SELECT document,digest,active FROM action_artifacts WHERE tenant_id=$1 AND id=$2 AND version=$3',
            [context.tenantId, input.resolution.id, input.resolution.version],
          )
        ).rows[0];
        if (!diagnosis || !artifact) throw missing();
        if (!artifact.active) conflict('Selected resolution is revoked');
        const binding = (
          await tx.query<{
            document: {
              incidentId: string;
              diagnosisRevision: number;
              artifactId: string;
              artifactVersion: string;
            };
          }>(
            'SELECT document FROM action_admission_runs WHERE tenant_id=$1 AND id=$2',
            [context.tenantId, input.id],
          )
        ).rows[0]?.document;
        if (
          binding &&
          (binding.incidentId !== incidentId ||
            binding.diagnosisRevision !== input.diagnosisRevision ||
            binding.artifactId !== input.resolution.id ||
            binding.artifactVersion !== input.resolution.version)
        )
          conflict('Resolution run binding conflicts');
        if (input.resolution.previousVersion) {
          const base = await tx.query(
            'SELECT 1 FROM action_artifacts WHERE tenant_id=$1 AND id=$2 AND version=$3',
            [
              context.tenantId,
              input.resolution.id,
              input.resolution.previousVersion,
            ],
          );
          if (!base.rowCount) conflict('Previous resolution version not found');
        }
        const document: ResolutionRun = {
          ...input,
          schemaVersion: 1,
          incidentId,
          actorId: context.actor.id,
          createdAt: now().toISOString(),
          context: {
            evidenceRefs: diagnosis.provenance.evidence.map((e) => e.id),
            mappingVersions: diagnosis.provenance.mappingVersions,
            configVersion: diagnosis.provenance.configVersion,
            ruleVersion: diagnosis.provenance.ruleVersion,
            diagnosisVersion: diagnosis.provenance.engineVersion,
            hypotheses: diagnosis.hypotheses,
            model: diagnosis.provenance.model,
          },
          generation: artifact.document.generation,
          artifactDigest: artifact.digest,
        };
        await tx.query(
          'INSERT INTO resolution_runs(tenant_id,id,incident_id,diagnosis_revision,artifact_id,artifact_version,document,request,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            context.tenantId,
            input.id,
            incidentId,
            input.diagnosisRevision,
            input.resolution.id,
            input.resolution.version,
            document,
            input,
            context.actor.id,
          ],
        );
        return document;
      }),
    append: (context, incidentId, runId, input) =>
      db.transaction(context.tenantId, async (tx) => {
        await lock(tx, context.tenantId, runId);
        const selected = await run(tx, context.tenantId, incidentId, runId);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `learning-event:${context.tenantId}:${input.id}`,
        ]);
        const previous = (
          await tx.query<{ document: LearningEvent; matches: boolean }>(
            'SELECT document,(request=$3::jsonb AND actor_id=$4 AND run_id=$5) AS matches FROM resolution_learning_events WHERE tenant_id=$1 AND id=$2',
            [context.tenantId, input.id, input, context.actor.id, runId],
          )
        ).rows[0];
        if (previous) {
          if (!previous.matches)
            conflict('Event ID already belongs to a different record');
          return previous.document;
        }
        const recordedAt = now().toISOString();
        if (Date.parse(input.occurredAt) > Date.parse(recordedAt))
          conflict('Observation time is in the future');
        const refs = [...new Set(evidence(input.fact))];
        const owned = await tx.query(
          `WITH refs AS (
          SELECT jsonb_array_elements_text(i.document->'facts'->'evidenceRefs') AS id FROM exception_evidence e JOIN exception_inputs i ON i.tenant_id=e.tenant_id AND i.evidence_key=e.evidence_key WHERE e.tenant_id=$1 AND e.exception_id=$2
          UNION SELECT jsonb_array_elements_text(document->'resolution'->'evidenceRefs') FROM exceptions WHERE tenant_id=$1 AND id=$2
          UNION SELECT jsonb_array_elements_text(document->'verification'->'evidenceRefs') FROM exception_outbox WHERE tenant_id=$1 AND exception_id=$2
        ) SELECT DISTINCT s.evidence_key FROM refs JOIN exception_sources s ON s.tenant_id=$1 AND s.evidence_key=refs.id WHERE s.evidence_key=ANY($3::text[])`,
          [context.tenantId, incidentId, refs],
        );
        if (owned.rowCount !== refs.length)
          conflict('Evidence must belong to this incident');
        const fact = input.fact;
        if ('stepId' in fact) {
          const human = await tx.query(
            "SELECT 1 FROM resolution_learning_events WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3 AND kind='repair_step'",
            [context.tenantId, runId, fact.stepId],
          );
          const automated = await tx.query(
            'SELECT 1 FROM action_admission_steps WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3',
            [context.tenantId, runId, fact.stepId],
          );
          if (
            fact.kind === 'repair_step' &&
            (human.rowCount || automated.rowCount)
          )
            conflict('Step ID is already bound');
          if (
            fact.kind !== 'repair_step' &&
            !human.rowCount &&
            !automated.rowCount
          )
            conflict('Step not found');
        }
        if (fact.kind === 'outcome' && fact.result === 'verified') {
          // Operator assertions cannot upgrade acceptance into a verified business result.
          const incident = (
            await tx.query<{ document: Incident }>(
              'SELECT document FROM exceptions WHERE tenant_id=$1 AND id=$2',
              [context.tenantId, incidentId],
            )
          ).rows[0]?.document;
          const resolution = incident?.resolution;
          if (
            resolution?.kind !== 'verification' ||
            resolution.outcome !== 'passed' ||
            !resolution.authoritative ||
            !resolution.complete ||
            resolution.evaluatorVersion !== fact.evaluatorVersion ||
            !fact.evidenceRefs.every((ref) =>
              resolution.evidenceRefs.includes(ref),
            ) ||
            Date.parse(input.occurredAt) < Date.parse(resolution.at)
          )
            conflict(
              'A verified outcome requires the incident’s authoritative verification',
            );
        }
        if (fact.kind === 'recurrence') {
          const recurrence = await tx.query(
            'SELECT 1 FROM exceptions WHERE tenant_id=$1 AND id=$2 AND previous_exception_id=$3',
            [context.tenantId, fact.incidentId, selected.incidentId],
          );
          if (!recurrence.rowCount)
            conflict('Incident is not a recorded recurrence of this case');
        }
        const sequence = Number(
          (
            await tx.query<{ next: number }>(
              'SELECT COALESCE(max(sequence),0)+1 AS next FROM resolution_learning_events WHERE tenant_id=$1 AND run_id=$2',
              [context.tenantId, runId],
            )
          ).rows[0]!.next,
        );
        const document: LearningEvent = {
          ...input,
          sequence,
          actorId: context.actor.id,
          recordedAt,
        };
        await tx.query(
          'INSERT INTO resolution_learning_events(tenant_id,id,run_id,sequence,kind,step_id,recurrence_id,document,request,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            context.tenantId,
            input.id,
            runId,
            sequence,
            fact.kind,
            'stepId' in fact ? fact.stepId : null,
            fact.kind === 'recurrence' ? fact.incidentId : null,
            document,
            input,
            context.actor.id,
          ],
        );
        return document;
      }),
    read: (context, incidentId, runId) =>
      db.transaction(context.tenantId, async (tx) => {
        // All collections share a PostgreSQL statement snapshot.
        const row = (
          await tx.query<ResolutionHistory & Record<string, unknown>>(
            `
        WITH steps AS (SELECT * FROM action_admission_steps WHERE tenant_id=$1 AND run_id=$3)
        SELECT r.document AS run,
          COALESCE((SELECT jsonb_agg(document ORDER BY sequence) FROM resolution_learning_events WHERE tenant_id=$1 AND run_id=$3),'[]') AS events,
          COALESCE((SELECT jsonb_agg(document ORDER BY created_at,step_id) FROM steps),'[]') AS steps,
          COALESCE((SELECT jsonb_agg(e.document ORDER BY e.created_at,e.id) FROM executed_actions e JOIN steps s ON s.tenant_id=e.tenant_id AND s.proposal_id=e.proposal_id),'[]') AS executions,
          COALESCE((SELECT jsonb_agg(v.document ORDER BY v.created_at,v.id,v.phase DESC) FROM execution_verifications v JOIN steps s ON s.tenant_id=v.tenant_id AND s.proposal_id=v.proposal_id),'[]') AS verifications,
          COALESCE((SELECT jsonb_agg(f.document ORDER BY f.created_at,f.id) FROM execution_failures f JOIN steps s ON s.tenant_id=f.tenant_id AND s.proposal_id=f.proposal_id),'[]') AS failures,
          (SELECT document FROM exceptions WHERE tenant_id=$1 AND id=$2) AS incident,
          COALESCE((SELECT jsonb_agg(document ORDER BY created_at,id) FROM exception_outbox WHERE tenant_id=$1 AND exception_id=$2 AND document->>'type'='exception.verification_attempt'),'[]') AS "incidentVerifications",
          COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'detectedAt',document->>'firstDetectedAt') ORDER BY created_at,id) FROM exceptions WHERE tenant_id=$1 AND previous_exception_id=$2),'[]') AS recurrences
        FROM resolution_runs r WHERE r.tenant_id=$1 AND r.incident_id=$2 AND r.id=$3`,
            [context.tenantId, incidentId, runId],
          )
        ).rows[0];
        if (!row) throw missing();
        return row;
      }),
  };
}
