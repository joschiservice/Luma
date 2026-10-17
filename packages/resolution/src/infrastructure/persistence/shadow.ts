import type { Diagnosis, IncidentVerificationAttempt } from '@luma/exceptions';
import { IdentityError } from '@luma/identity';
import {
  canonicalJson as canonicalPlaybook,
  conflict,
  notFound,
  type TenantDatabase,
} from '@luma/platform';
import type {
  PlaybookActivation,
  PlaybookRun,
  PlaybookVersion,
} from '@luma/workflows';

import type { ShadowStore } from '../../application/shadow.js';
import type {
  ShadowComparison,
  ShadowEvaluation,
} from '../../application/shadow-evaluation.js';

const missing = () => notFound('Shadow evaluation or case not found');

/** Stores immutable Shadow snapshots and reviews under tenant RLS; reads only retained production evidence. */
export function createShadowStore(
  db: TenantDatabase,
  validation: {
    compilePlaybook(input: unknown): PlaybookVersion;
    playbookHash(input: unknown): string;
  },
): ShadowStore {
  const { compilePlaybook, playbookHash } = validation;

  return {
    evaluate: (context, incidentId, request, evaluate, prepared) =>
      db.transaction(context.tenantId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `shadow:${context.tenantId}:${request.id}`,
        ]);
        const prior = (
          await tx.query<{ document: ShadowEvaluation; matches: boolean }>(
            'SELECT document,(incident_id=$3 AND actor_id=$4 AND workflow=$5) AS matches FROM shadow_evaluations WHERE tenant_id=$1 AND id=$2',
            [
              context.tenantId,
              request.id,
              incidentId,
              context.actor.id,
              request.workflow,
            ],
          )
        ).rows[0];
        if (prior) {
          if (!prior.matches)
            throw conflict(
              'Evaluation ID already belongs to a different request',
            );

          return prior.document;
        }
        // Share the case writer lock while taking the diagnosis/proposal snapshot.
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `exceptions:${context.tenantId}`,
        ]);
        const row = (
          await tx.query<{
            diagnosis: Diagnosis | null;
            candidate: PlaybookRun | null;
            version: unknown;
            activation: PlaybookActivation | null;
            active: boolean | null;
            resolved: boolean;
          }>(
            `SELECT e.state='resolved' AS resolved,d.document AS diagnosis,r.document AS candidate,v.document AS version,a.document AS activation,aa.active
        FROM exceptions e
        LEFT JOIN exception_diagnosis_heads h ON h.tenant_id=e.tenant_id AND h.exception_id=e.id
        LEFT JOIN exception_diagnoses d ON d.tenant_id=h.tenant_id AND d.exception_id=h.exception_id AND d.revision=h.revision
        LEFT JOIN LATERAL (SELECT p.* FROM case_proposals p WHERE p.tenant_id=e.tenant_id AND p.exception_id=e.id ORDER BY p.diagnosis_revision DESC LIMIT 1) p ON true
        LEFT JOIN playbook_runs r ON r.tenant_id=p.tenant_id AND r.id=p.id AND r.definition_id=$3
        LEFT JOIN playbook_versions v ON v.tenant_id=r.tenant_id AND v.definition_id=r.definition_id AND v.version=r.version
        LEFT JOIN playbook_activations a ON a.tenant_id=r.tenant_id AND a.id=r.activation_id
        LEFT JOIN action_artifacts aa ON aa.tenant_id=a.tenant_id AND aa.id='playbook:'||a.id AND aa.version=a.version
        WHERE e.tenant_id=$1 AND e.id=$2`,
            [context.tenantId, incidentId, request.workflow],
          )
        ).rows[0];
        if (!row) throw missing();
        const candidate = prepared === undefined ? row.candidate : prepared;
        if (prepared) {
          const binding = (
            await tx.query<{
              version: unknown;
              activation: PlaybookActivation;
              active: boolean;
            }>(
              `SELECT v.document AS version,a.document AS activation,aa.active
             FROM playbook_versions v JOIN playbook_activations a ON a.tenant_id=v.tenant_id AND a.definition_id=v.definition_id AND a.version=v.version
             LEFT JOIN action_artifacts aa ON aa.tenant_id=a.tenant_id AND aa.id='playbook:'||a.id AND aa.version=a.version
             WHERE v.tenant_id=$1 AND v.definition_id=$2 AND v.version=$3 AND a.id=$4`,
              [
                context.tenantId,
                prepared.definitionId,
                prepared.version,
                prepared.activationId,
              ],
            )
          ).rows[0];
          if (!binding) throw conflict('Playbook binding unavailable');
          Object.assign(row, binding);
        }
        if (row.diagnosis && row.resolved) row.diagnosis.superseded = true;
        if (
          candidate &&
          (
            await tx.query(
              'SELECT 1 FROM executed_actions WHERE tenant_id=$1 AND proposal_id=$2',
              [context.tenantId, candidate.id],
            )
          ).rowCount
        )
          throw conflict('The proposal already has an execution attempt');
        let version = null;
        if (candidate) {
          if (candidate.principalId !== context.actor.id)
            throw new IdentityError(
              403,
              'FORBIDDEN',
              'Proposal belongs to another principal',
            );
          if (!row.version || typeof row.version !== 'object')
            throw conflict('Playbook version unavailable');
          const { digest, ...source } = row.version as Record<string, unknown>;
          version = compilePlaybook(source);
          if (
            version.digest !== digest ||
            version.digest !== candidate.versionDigest ||
            playbookHash(candidate.snapshot) !== candidate.snapshotDigest ||
            playbookHash(candidate.action) !== candidate.actionHash ||
            candidate.definitionId !== request.workflow ||
            candidate.incidentId !== incidentId ||
            candidate.tenantId !== context.tenantId
          )
            throw conflict('Playbook binding integrity mismatch');
        }
        const activation = row.activation;
        const available =
          !!candidate &&
          !!row.active &&
          !!activation &&
          activation.versionDigest === candidate.versionDigest &&
          activation.artifactDigest === candidate.artifactDigest &&
          activation.grants.principalIds.includes(context.actor.id) &&
          activation.grants.connectionIds.includes(
            candidate.action.connectionId,
          ) &&
          activation.grants.targetIds.includes(candidate.action.target.id);
        const document = evaluate({
          diagnosis: row.diagnosis,
          candidate,
          version,
          available,
        });
        await tx.query(
          'INSERT INTO shadow_evaluations(tenant_id,id,incident_id,workflow,actor_id,document) VALUES($1,$2,$3,$4,$5,$6)',
          [
            context.tenantId,
            request.id,
            incidentId,
            request.workflow,
            context.actor.id,
            document,
          ],
        );

        return document;
      }),
    review: (context, id, review) =>
      db.transaction(context.tenantId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `shadow:${context.tenantId}:${id}`,
        ]);
        const run = (
          await tx.query<{ document: ShadowEvaluation }>(
            'SELECT document FROM shadow_evaluations WHERE tenant_id=$1 AND id=$2',
            [context.tenantId, id],
          )
        ).rows[0]?.document;
        if (!run) throw missing();
        const previous = (
          await tx.query<{ document: ShadowComparison['review'] }>(
            'SELECT document FROM shadow_reviews WHERE tenant_id=$1 AND evaluation_id=$2',
            [context.tenantId, id],
          )
        ).rows[0];
        const document = { ...review, actorId: context.actor.id };
        if (previous) {
          if (
            canonicalPlaybook(previous.document) !== canonicalPlaybook(document)
          )
            throw conflict('The operator comparison is immutable');

          return;
        }
        if (Date.parse(review.occurredAt) < Date.parse(run.createdAt))
          throw conflict('Operator evidence must follow the Shadow evaluation');
        const refs = (
          await tx.query<{ id: string }>(
            `WITH refs AS (
        SELECT evidence->>'id' AS id FROM exception_diagnoses d CROSS JOIN LATERAL jsonb_array_elements(d.document->'provenance'->'evidence') evidence WHERE d.tenant_id=$1 AND d.exception_id=$2
        UNION SELECT jsonb_array_elements_text(document->'evidenceRefs') FROM exception_outbox WHERE tenant_id=$1 AND exception_id=$2
        UNION SELECT jsonb_array_elements_text(document->'resolution'->'evidenceRefs') FROM exceptions WHERE tenant_id=$1 AND id=$2
      ) SELECT DISTINCT refs.id FROM refs JOIN exception_sources s ON s.tenant_id=$1 AND s.evidence_key=refs.id WHERE refs.id=ANY($3::text[])`,
            [context.tenantId, run.incidentId, review.evidenceRefs],
          )
        ).rows.map((r) => r.id);
        if (!review.evidenceRefs.every((ref) => refs.includes(ref)))
          throw conflict('Evidence must belong to this incident');
        await tx.query(
          'INSERT INTO shadow_reviews(tenant_id,evaluation_id,document) VALUES($1,$2,$3)',
          [context.tenantId, id, document],
        );
      }),
    list: (context, workflow, since, until, incidentId) =>
      db.transaction(context.tenantId, async (tx) => {
        const rows = (
          await tx.query<{
            evaluation: ShadowEvaluation;
            review: ShadowComparison['review'];
            verification: IncidentVerificationAttempt | null;
          }>(
            `
        WITH selected AS (
          SELECT DISTINCT ON (incident_id) * FROM shadow_evaluations
          WHERE tenant_id=$1 AND workflow=$2 AND ($5::uuid IS NULL OR incident_id=$5) AND (document->>'createdAt')::timestamptz >= $3 AND (document->>'createdAt')::timestamptz < $4
          ORDER BY incident_id,(document->>'createdAt')::timestamptz DESC,id DESC
        ) SELECT s.document AS evaluation,r.document AS review,v.document AS verification
        FROM selected s LEFT JOIN shadow_reviews r ON r.tenant_id=s.tenant_id AND r.evaluation_id=s.id
        LEFT JOIN LATERAL (
          SELECT document FROM (
            SELECT document,created_at,id FROM exception_outbox
            WHERE tenant_id=s.tenant_id AND exception_id=s.incident_id
            AND document->>'type'='exception.verification_attempt'
            AND (document->>'outcome'<>'passed' OR document->>'accepted'='true')
            UNION ALL
            SELECT jsonb_build_object(
              'phase',v.phase,'authoritative',true,'complete',true,
              'outcome',v.document->'result'->>'outcome',
              'evaluatorVersion',v.document->'result'->>'evaluatorVersion',
              'evidenceRefs',v.document->'result'->'observationRefs',
              'occurredAt',v.document->'result'->>'observedAt'
            ),v.created_at,v.id
            FROM execution_verifications v JOIN case_proposals p ON p.tenant_id=v.tenant_id AND p.id=v.proposal_id
            JOIN executed_actions x ON x.tenant_id=v.tenant_id AND x.proposal_id=v.proposal_id
            JOIN playbook_versions pv ON pv.tenant_id=s.tenant_id AND pv.definition_id=s.document->'candidate'->>'definitionId' AND pv.version=s.document->'candidate'->>'version' 
            WHERE v.tenant_id=s.tenant_id AND p.exception_id=s.incident_id
            AND (v.document->'result'->>'observedAt')::timestamptz >= (x.document->'attempt'->>'startedAt')::timestamptz
            AND (v.document->'result'->>'observedAt')::timestamptz <= (x.document->'attempt'->>'startedAt')::timestamptz + (pv.document->'ir'->'verification'->>'maxDurationSeconds')::double precision * interval '1 second'
            AND (v.document->'result'->>'observedAt')::timestamptz <= now()
            AND p.document->'target'=s.document->'candidate'->'action'->'target'
            AND p.document->'expectedPostcondition'=s.document->'candidate'->'action'->'expectedPostcondition'
            AND p.document->>'capability'=s.document->'candidate'->'action'->>'capability'
            AND p.document->>'connectionId'=s.document->'candidate'->'action'->>'connectionId'
          ) evidence WHERE true
          AND document->>'phase'='completed'
          AND document->>'authoritative'='true' AND document->>'complete'='true'
          AND document->>'outcome' IN ('passed','failed')
          AND document->>'failureCode' IS NULL
          AND document->>'evaluatorVersion'=s.document->'simulation'->>'evaluatorVersion'
          AND CASE WHEN jsonb_typeof(document->'evidenceRefs')='array' THEN jsonb_array_length(document->'evidenceRefs') ELSE 0 END>0
          AND (document->>'occurredAt')::timestamptz >= (s.document->>'createdAt')::timestamptz
          ORDER BY created_at DESC,id DESC LIMIT 1
        ) v ON true ORDER BY s.incident_id LIMIT 501`,
            [context.tenantId, workflow, since, until, incidentId ?? null],
          )
        ).rows;

        return rows.map(({ evaluation, review, verification }) => ({
          evaluation,
          review,
          actual: verification
            ? {
                outcome: verification.outcome as 'passed' | 'failed',
                evaluatorVersion: verification.evaluatorVersion,
                evidenceRefs: verification.evidenceRefs!,
                occurredAt: verification.occurredAt,
              }
            : null,
        }));
      }),
  };
}
