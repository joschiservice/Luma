import type { Incident } from '@luma/exceptions';
import type { TenantDatabase } from '@luma/platform';
import { conflict, notFound, unavailable } from '@luma/platform';

import {
  type MeasurementStore,
  type ResolutionMetricReader,
} from '../../application/measurement.js';
import type {
  MeasurementEvent,
  MeasurementScope,
  MeasurementSource,
} from '../../domain/measurement.js';
import { summarizeResolutionMetrics } from '../../domain/measurement.js';
import { readPeople } from './actors.js';

const missing = () => notFound('Incident or evidence not found');

/** Creates append-only measurement commands with immutable environment, optimistic revisions and tenant-owned evidence. */
export function createMeasurementStore(
  db: TenantDatabase,
  now = () => new Date(),
): MeasurementStore {
  const store: MeasurementStore = {
    append: (context, incidentId, input) =>
      db.transaction(context.tenantId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `measurement:${context.tenantId}:${incidentId}`,
        ]);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `measurement-event:${context.tenantId}:${input.id}`,
        ]);
        const prior = (
          await tx.query<{ document: MeasurementEvent; matches: boolean }>(
            'SELECT document,(request=$3::jsonb AND actor_id=$4 AND incident_id=$5) AS matches FROM resolution_measurement_facts WHERE tenant_id=$1 AND id=$2',
            [context.tenantId, input.id, input, context.actor.id, incidentId],
          )
        ).rows[0];
        if (prior) {
          if (!prior.matches)
            throw conflict('Fact ID already belongs to a different assessment');

          return prior.document;
        }
        const incident = (
          await tx.query<{ document: Incident }>(
            'SELECT document FROM exceptions WHERE tenant_id=$1 AND id=$2',
            [context.tenantId, incidentId],
          )
        ).rows[0]?.document;
        if (!incident) throw missing();
        const facts = (
          await tx.query<{ document: MeasurementEvent }>(
            'SELECT document FROM resolution_measurement_facts WHERE tenant_id=$1 AND incident_id=$2 ORDER BY revision',
            [context.tenantId, incidentId],
          )
        ).rows.map((r) => r.document);
        const revision = facts.at(-1)?.revision ?? 0;
        if (revision >= 1000)
          throw conflict(
            'The incident measurement ledger reached its 1,000-fact limit',
          );
        if (input.expectedRevision !== revision)
          throw conflict(
            'Measurement facts changed. Read the current revision.',
          );
        const refs = (
          await tx.query<{ ref: string }>(
            `
        WITH refs AS (
          SELECT e.evidence_key AS ref FROM exception_evidence e WHERE e.tenant_id=$1 AND e.exception_id=$2
          UNION SELECT jsonb_array_elements_text(i.document->'facts'->'evidenceRefs') FROM exception_evidence e JOIN exception_inputs i ON i.tenant_id=e.tenant_id AND i.evidence_key=e.evidence_key WHERE e.tenant_id=$1 AND e.exception_id=$2
          UNION SELECT evidence->>'id' FROM exception_diagnoses d CROSS JOIN LATERAL jsonb_array_elements(d.document->'provenance'->'evidence') evidence WHERE d.tenant_id=$1 AND d.exception_id=$2
          UNION SELECT jsonb_array_elements_text(document->'resolution'->'evidenceRefs') FROM exceptions WHERE tenant_id=$1 AND id=$2
          UNION SELECT jsonb_array_elements_text(document->'verification'->'evidenceRefs') FROM exception_outbox WHERE tenant_id=$1 AND exception_id=$2
        ) SELECT DISTINCT refs.ref FROM refs JOIN exception_sources s ON s.tenant_id=$1 AND s.evidence_key=refs.ref WHERE refs.ref=ANY($3::text[])`,
            [context.tenantId, incidentId, input.fact.evidenceRefs],
          )
        ).rows.map((r) => r.ref);
        if (!input.fact.evidenceRefs.every((ref) => refs.includes(ref)))
          throw missing();
        const fact = input.fact;
        const recordedAt = now().toISOString();
        if (
          'through' in fact &&
          Date.parse(fact.through) > Date.parse(recordedAt)
        )
          throw conflict('Coverage cannot extend into the future');
        if (
          fact.kind === 'environment' &&
          facts.some((e) => e.fact.kind === 'environment')
        )
          throw conflict('The incident environment is immutable');
        if (
          fact.kind === 'attribution' &&
          fact.involvement === 'none' &&
          Date.parse(fact.from) > Date.parse(incident.firstDetectedAt)
        )
          throw conflict('Attribution must cover first detection');
        if (fact.kind === 'incorrect_action') {
          const owned = await tx.query(
            `SELECT 1 FROM case_proposals WHERE tenant_id=$1 AND exception_id=$2 AND id=$3 UNION SELECT 1 FROM action_admission_steps WHERE tenant_id=$1 AND document->>'incidentId'=$2::text AND proposal_id=$3`,
            [context.tenantId, incidentId, fact.proposalId],
          );
          if (!owned.rowCount) throw missing();
        }
        const document: MeasurementEvent = {
          id: input.id,
          incidentId,
          revision: revision + 1,
          schemaVersion: 1,
          actorId: context.actor.id,
          recordedAt,
          fact,
        };
        await tx.query(
          'INSERT INTO resolution_measurement_facts(tenant_id,id,incident_id,revision,kind,actor_id,document,request) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            context.tenantId,
            input.id,
            incidentId,
            document.revision,
            fact.kind,
            context.actor.id,
            document,
            input,
          ],
        );

        return document;
      }),
    history: (context, incidentId, after) =>
      db.transaction(context.tenantId, async (tx) => {
        const result = (
          await tx.query<{
            exists: boolean;
            revision: number;
            items: MeasurementEvent[];
          }>(
            `
        SELECT EXISTS(SELECT 1 FROM exceptions WHERE tenant_id=$1 AND id=$2) AS exists,
          COALESCE((SELECT max(revision) FROM resolution_measurement_facts WHERE tenant_id=$1 AND incident_id=$2),0) AS revision,
          COALESCE((SELECT jsonb_agg(document ORDER BY revision) FROM (SELECT document,revision FROM resolution_measurement_facts WHERE tenant_id=$1 AND incident_id=$2 AND revision>$3 ORDER BY revision LIMIT 101) f),'[]') AS items`,
            [context.tenantId, incidentId, after],
          )
        ).rows[0]!;
        if (!result.exists) throw missing();
        const items = result.items.slice(0, 100);

        return {
          items,
          people: await readPeople(
            tx,
            context.tenantId,
            items.map((item) => item.actorId),
          ),
          revision: result.revision,
          nextRevision:
            result.items.length > 100 ? items.at(-1)!.revision : null,
        };
      }),
  };

  return store;
}

/** Reads authoritative approval/repair records across every attempt, alongside versioned assessments, without maintaining aggregates. */
export function createResolutionMetricReader(
  db: TenantDatabase,
): ResolutionMetricReader {
  return (tenantId, asOf, scope: MeasurementScope = {}) =>
    db.transaction(tenantId, async (tx) => {
      await tx.query("SET LOCAL statement_timeout = '3000ms'");
      const end = new Date(scope.end ?? asOf).toISOString();
      const start = scope.start
        ? new Date(scope.start).toISOString()
        : new Date(
            Date.parse(end) -
              (scope.window === '24h' ? 1 : scope.window === '30d' ? 30 : 7) *
                86400000,
          ).toISOString();
      const rows = (
        await tx.query<MeasurementSource & Record<string, unknown>>(
          `
      WITH cohort AS (
        SELECT * FROM exceptions WHERE tenant_id=$1 AND
          ((document->>'firstDetectedAt'>=$2 AND document->>'firstDetectedAt'<$3) OR
           (document->'resolution'->>'at'>=$2 AND document->'resolution'->>'at'<$3))
          AND ($4::text IS NULL OR document->>'exceptionClass'=$4)
          ORDER BY document->>'firstDetectedAt',id LIMIT 10001
      ), source_evidence AS (
        SELECT c.id AS incident_id,s.document FROM cohort c
        JOIN exception_evidence e ON e.tenant_id=c.tenant_id AND e.exception_id=c.id
        JOIN exception_inputs i ON i.tenant_id=e.tenant_id AND i.evidence_key=e.evidence_key
        CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(i.document->'facts'->'evidenceRefs')='array' THEN i.document->'facts'->'evidenceRefs' ELSE '[]' END) ref(key)
        JOIN exception_sources s ON s.tenant_id=i.tenant_id AND s.evidence_key=ref.key
        UNION SELECT c.id,s.document FROM cohort c
        CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(c.document->'resolution'->'evidenceRefs')='array' THEN c.document->'resolution'->'evidenceRefs' ELSE '[]' END) ref(key)
        JOIN exception_sources s ON s.tenant_id=c.tenant_id AND s.evidence_key=ref.key
      ), proposals AS (
        SELECT p.tenant_id,p.id,p.exception_id FROM case_proposals p JOIN cohort c ON c.tenant_id=p.tenant_id AND c.id=p.exception_id
        UNION SELECT s.tenant_id,s.proposal_id,c.id FROM action_admission_steps s JOIN cohort c ON c.tenant_id=s.tenant_id AND c.id=s.incident_id
      ), humans AS (
        SELECT p.exception_id AS incident_id,'approval:' || a.id::text AS ref FROM proposals p JOIN policy_approvals a ON a.tenant_id=p.tenant_id AND a.proposal_id=p.id
        UNION SELECT c.id,'disposition:' || o.id::text FROM cohort c JOIN exception_outbox o ON o.tenant_id=c.tenant_id AND o.exception_id=c.id WHERE o.document->'resolution'->>'kind'='human_disposition'
        UNION SELECT c.id,'decision:' || d.id::text FROM cohort c JOIN case_commands d ON d.tenant_id=c.tenant_id AND d.exception_id=c.id
        UNION SELECT c.id,'selection:' || r.id::text FROM cohort c JOIN resolution_runs r ON r.tenant_id=c.tenant_id AND r.incident_id=c.id
        UNION SELECT c.id,'learning:' || e.id::text FROM cohort c JOIN resolution_runs r ON r.tenant_id=c.tenant_id AND r.incident_id=c.id JOIN resolution_learning_events e ON e.tenant_id=r.tenant_id AND e.run_id=r.id WHERE e.kind IN ('repair_step','intervention','human_edit') OR (e.kind='cause' AND e.document->'fact'->>'basis'='operator_investigation')
      ) SELECT c.id,c.document->>'exceptionClass' AS title,c.state,c.document->>'firstDetectedAt' AS "detectedAt",c.previous_exception_id AS "previousIncidentId",
        c.document->'resolution' AS resolution,
        COALESCE((SELECT jsonb_agg(DISTINCT s.document->>'connectionId') FROM source_evidence s WHERE s.incident_id=c.id AND s.document->>'connectionId' IS NOT NULL),'[]') AS "connectionIds",
        COALESCE((SELECT jsonb_agg(DISTINCT jsonb_build_object('id',r.document->'resolution'->>'id','version',r.document->'resolution'->>'version')) FROM resolution_runs r WHERE r.tenant_id=c.tenant_id AND r.incident_id=c.id AND r.document->'resolution'->>'id' IS NOT NULL AND r.document->'resolution'->>'version' IS NOT NULL),'[]') AS artifacts,
        COALESCE((SELECT jsonb_agg(document ORDER BY revision) FROM resolution_measurement_facts f WHERE f.tenant_id=$1 AND f.incident_id=c.id),'[]') AS events,
        COALESCE((SELECT jsonb_agg(ref ORDER BY ref) FROM humans h WHERE h.incident_id=c.id),'[]') AS "humanEvidence",
        EXISTS(SELECT 1 FROM source_evidence s LEFT JOIN connector_installations installation ON installation.tenant_id=$1 AND installation.id::text=s.document->>'connectionId'
          WHERE s.incident_id=c.id AND (
            s.document->'facts'->>'synthetic'='true' OR s.document->>'adapterVersion' LIKE '%synthetic%'
            OR s.document->>'adapterVersion' LIKE '%simulator%' OR s.document->>'key' LIKE 'pilot:%'
            OR installation.document->>'label' LIKE 'SIMULATED %'
            OR EXISTS(SELECT 1 FROM jsonb_each_text(COALESCE(installation.document->'target','{}'::jsonb)) t WHERE t.value LIKE '%.invalid%' OR t.value LIKE 'luma-synthetic-%')
          )) AS synthetic,
        EXISTS(SELECT FROM proposals p JOIN execution_observe_only o ON o.tenant_id=p.tenant_id AND o.proposal_id=p.id WHERE p.exception_id=c.id) AS "observeOnly"
      FROM cohort c ORDER BY c.document->>'firstDetectedAt',c.id`,
          [tenantId, start, end, scope.issueClass ?? null],
        )
      ).rows;
      if (rows.length > 10000)
        throw unavailable(
          'The resolution cohort exceeds 10,000 incidents. Choose a shorter window.',
        );

      return summarizeResolutionMetrics(rows, asOf, scope);
    });
}
