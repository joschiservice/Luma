import { IdentityError, type TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import type { ImprovementDiscoverySource } from '../../domain/improvement-discovery.js';
import type {
  MeasurementEvent,
  MeasurementSource,
} from '../../domain/measurement.js';

type Row = MeasurementSource &
  Record<string, unknown> & {
    run_id: string;
    subject_id: string;
    artifact_id: string;
    artifact_version: string;
    artifact_digest: string;
    interventions: string;
    edits: string;
    effort: string | null;
    recurrences: string;
    events: MeasurementEvent[];
  };

/** Reads at most 500 distinct verified incidents in a consistent tenant-scoped 30-day cohort. */
export function createImprovementDiscoveryReader(db: TenantDatabase) {
  return (
    context: TenantContext,
    asOf: string,
  ): Promise<ImprovementDiscoverySource[]> =>
    db.transaction(
      context.tenantId,
      async (tx) => {
        const start = new Date(Date.parse(asOf) - 30 * 86400000).toISOString();
        await tx.query("SET LOCAL statement_timeout='3000ms'");
        const rows = (
          await tx.query<Row>(
            `
      WITH selected AS (
        SELECT DISTINCT ON (r.incident_id) r.*,e.document AS incident,e.state FROM resolution_runs r
        JOIN exceptions e ON e.tenant_id=r.tenant_id AND e.id=r.incident_id
        WHERE r.tenant_id=$1 AND e.state='resolved' AND e.document->>'exceptionClass' IN ('inventory_mismatch','sync_failure')
          AND e.document->'resolution'->>'kind'='verification' AND e.document->'resolution'->>'outcome'='passed'
          AND e.document->'resolution'->>'complete'='true' AND e.document->'resolution'->>'authoritative'='true'
          AND jsonb_array_length(e.document->'resolution'->'evidenceRefs')>0
          AND length(r.document->>'artifactDigest')>0
          AND e.document->'resolution'->>'at'>=$2 AND e.document->'resolution'->>'at'<$3
          AND EXISTS(SELECT 1 FROM resolution_learning_events l WHERE l.tenant_id=r.tenant_id AND l.run_id=r.id AND l.kind='outcome'
            AND l.document->'fact'->>'result'='verified' AND l.document->'fact'->>'complete'='true' AND l.document->'fact'->>'authoritative'='true'
            AND l.document->'fact'->>'evaluatorVersion'=e.document->'resolution'->>'evaluatorVersion'
            AND (l.document->'fact'->'evidenceRefs') @> (e.document->'resolution'->'evidenceRefs'))
        ORDER BY r.incident_id,r.created_at DESC,r.id
      ), cohort AS (SELECT * FROM selected ORDER BY incident->'resolution'->>'at' DESC,incident_id LIMIT 501), source_evidence AS (
        SELECT c.incident_id,s.document FROM cohort c JOIN exception_evidence e ON e.tenant_id=c.tenant_id AND e.exception_id=c.incident_id
        JOIN exception_inputs i ON i.tenant_id=e.tenant_id AND i.evidence_key=e.evidence_key
        CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(i.document->'facts'->'evidenceRefs')='array' THEN i.document->'facts'->'evidenceRefs' ELSE '[]' END) ref(key)
        JOIN exception_sources s ON s.tenant_id=i.tenant_id AND s.evidence_key=ref.key
        UNION SELECT c.incident_id,s.document FROM cohort c CROSS JOIN LATERAL jsonb_array_elements_text(c.incident->'resolution'->'evidenceRefs') ref(key)
        JOIN exception_sources s ON s.tenant_id=c.tenant_id AND s.evidence_key=ref.key
      ) SELECT c.incident_id AS id,c.incident->>'exceptionClass' AS title,c.state,c.incident->>'firstDetectedAt' AS "detectedAt",
        c.incident->>'previousExceptionId' AS "previousIncidentId",c.incident->'resolution' AS resolution,
        c.id AS run_id,c.incident->'subject'->>'subjectId' AS subject_id,c.artifact_id,c.artifact_version,c.document->>'artifactDigest' AS artifact_digest,
        COALESCE((SELECT jsonb_agg(document ORDER BY revision) FROM resolution_measurement_facts f WHERE f.tenant_id=$1 AND f.incident_id=c.incident_id AND f.kind='environment'),'[]') AS events,
        '[]'::jsonb AS "humanEvidence",
        (SELECT count(*) FROM resolution_learning_events l WHERE l.tenant_id=$1 AND l.run_id=c.id AND l.kind='intervention') AS interventions,
        (SELECT count(*) FROM resolution_learning_events l WHERE l.tenant_id=$1 AND l.run_id=c.id AND l.kind='human_edit') AS edits,
        (SELECT sum((l.document->'fact'->>'effortSeconds')::numeric) FROM resolution_learning_events l WHERE l.tenant_id=$1 AND l.run_id=c.id AND l.kind IN ('intervention','repair_step')) AS effort,
        (SELECT count(*) FROM exceptions child WHERE child.tenant_id=$1 AND child.previous_exception_id=c.incident_id) AS recurrences,
        EXISTS(SELECT 1 FROM source_evidence s LEFT JOIN connector_installations installation ON installation.tenant_id=$1 AND installation.id::text=s.document->>'connectionId'
          WHERE s.incident_id=c.incident_id AND (s.document->'facts'->>'synthetic'='true' OR s.document->>'adapterVersion' LIKE '%synthetic%'
          OR s.document->>'adapterVersion' LIKE '%simulator%' OR s.document->>'key' LIKE 'pilot:%' OR installation.document->>'label' LIKE 'SIMULATED %'
          OR EXISTS(SELECT 1 FROM jsonb_each_text(COALESCE(installation.document->'target','{}'::jsonb)) t WHERE t.value LIKE '%.invalid%' OR t.value LIKE 'luma-synthetic-%'))) AS synthetic,
        EXISTS(SELECT 1 FROM action_admission_steps step JOIN execution_observe_only observed ON observed.tenant_id=step.tenant_id AND observed.proposal_id=step.proposal_id WHERE step.tenant_id=$1 AND step.document->>'incidentId'=c.incident_id::text) AS "observeOnly"
      FROM cohort c ORDER BY c.incident->'resolution'->>'at' DESC,c.incident_id`,
            [context.tenantId, start, asOf],
          )
        ).rows;
        if (rows.length > 500)
          throw new IdentityError(
            503,
            'SERVICE_UNAVAILABLE',
            'This discovery cohort exceeds 500 verified issues. Inspect individual issues in Insights and choose a verified resolution directly.',
          );

        return rows.map((row) => ({
          measurement: row,
          runId: row.run_id,
          subjectId: row.subject_id,
          artifact: {
            id: row.artifact_id,
            version: row.artifact_version,
            digest: row.artifact_digest,
          },
          humanInterventions: Number(row.interventions),
          humanEdits: Number(row.edits),
          effortSeconds: row.effort === null ? null : Number(row.effort),
          recurrences: Number(row.recurrences),
        }));
      },
      { readOnlySnapshot: true },
    );
}
