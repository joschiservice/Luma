import { createHash } from 'node:crypto';

import type { TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import type {
  CaseDetail,
  CaseEvidencePage,
  CaseQuery,
  CaseReader,
} from '../application/cases.js';
import type { Incident } from '../application/detection.js';
import type { Diagnosis } from '../domain/diagnosis.js';

type Row = {
  document: Incident;
  version: number;
  diagnosis: Diagnosis | null;
  attention_reason: 'approval' | 'manual_intervention' | 'uncertainty' | null;
  attention_at: string;
  activity: string;
  rank: number;
};

// Attention comes from persisted lifecycle, uncertainty escalation or deterministic manual steps.
// Model-selected hypotheses and severity never create an attention request.
const projection = `WITH cases AS (
 SELECT e.document,e.version,d.document AS diagnosis,
 CASE WHEN e.state='resolved' THEN NULL
 WHEN e.state='escalated' OR u.review_required THEN 'uncertainty'
 WHEN e.state='awaiting_approval' OR pa.document->>'outcome'='approval_required' THEN 'approval'
 WHEN d.document->>'status'='ready'
   AND (d.document->'provenance'->>'validUntil' IS NULL OR (d.document->'provenance'->>'validUntil')::timestamptz >= $2::timestamptz)
   AND d.document->'nextSteps' @> '[{"kind":"manual_intervention"}]'::jsonb THEN 'manual_intervention'
 ELSE NULL END AS attention_reason,
 COALESCE(CASE WHEN e.state='escalated' THEN command.at ELSE pa.requested_at END,u.first_deferred_at::text,d.document->'provenance'->>'generatedAt',e.document->>'firstDetectedAt') AS attention_at,
 GREATEST(e.document->>'lastDetectedAt',d.document->'provenance'->>'generatedAt',e.document->'resolution'->>'at',command.at,pa.document->>'evaluatedAt') AS activity,
 CASE WHEN e.document->>'severity'='high' THEN 0 ELSE 1 END AS rank
 FROM exceptions e
 LEFT JOIN exception_diagnosis_heads h ON h.tenant_id=e.tenant_id AND h.exception_id=e.id
 LEFT JOIN exception_diagnoses d ON d.tenant_id=h.tenant_id AND d.exception_id=h.exception_id AND d.revision=h.revision
 LEFT JOIN exception_uncertainty u ON u.tenant_id=e.tenant_id AND u.fingerprint=e.fingerprint
 LEFT JOIN LATERAL (SELECT document->>'createdAt' AS at FROM case_commands WHERE tenant_id=e.tenant_id AND exception_id=e.id ORDER BY created_at DESC,id DESC LIMIT 1) command ON true
 LEFT JOIN LATERAL (
   SELECT pd.document,
     (SELECT min(first.document->>'evaluatedAt') FROM policy_decisions first
      WHERE first.tenant_id=p.tenant_id AND first.proposal_id=p.id AND first.action_hash=p.action_hash
      AND first.document->>'outcome'='approval_required'
      AND first.document->>'policyVersion'=pd.document->>'policyVersion'
      AND first.document->>'actorId'=pd.document->>'actorId') AS requested_at
   FROM case_proposals p
   JOIN LATERAL (SELECT * FROM policy_decisions WHERE tenant_id=p.tenant_id AND proposal_id=p.id AND action_hash=p.action_hash ORDER BY created_at DESC,id DESC LIMIT 1) pd ON true
   WHERE p.tenant_id=e.tenant_id AND p.exception_id=e.id AND p.diagnosis_revision=h.revision
   AND d.document->>'status'='ready'
   AND (d.document->'provenance'->>'validUntil' IS NULL OR (d.document->'provenance'->>'validUntil')::timestamptz>$2::timestamptz)
   AND (p.document->>'expiresAt')::timestamptz>$2::timestamptz
   AND (p.document->'preconditions'->>'validUntil')::timestamptz>$2::timestamptz
   AND NOT EXISTS(SELECT 1 FROM policy_approvals a WHERE a.tenant_id=p.tenant_id AND a.proposal_id=p.id AND a.action_hash=p.action_hash AND a.policy_version=pd.document->>'policyVersion')
 ) pa ON true
 WHERE e.tenant_id=$1
), ordered AS (SELECT *, CASE WHEN attention_reason IS NULL THEN document->>'firstDetectedAt' ELSE attention_at END AS sort_at FROM cases)`;

const cursorSchema = z
  .object({
    context: z.string(),
    rank: z.number().int().min(0).max(1),
    at: z.string().datetime(),
    id: z.string().uuid(),
  })
  .strict();

function contextKey(tenantId: string, query: CaseQuery) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        tenantId,
        query.view,
        query.class ?? null,
        query.severity ?? null,
        query.state ?? null,
        query.limit,
      ]),
    )
    .digest('hex');
}

function project(row: Row, now: Date): CaseDetail {
  const incident = row.document;
  const diagnosis = row.diagnosis ? structuredClone(row.diagnosis) : null;
  if (diagnosis && diagnosis.provenance.evidence.length > 100) {
    const count = diagnosis.provenance.evidence.length;
    // Pending snapshots bypass diagnosis validation. Bound the read without deleting
    // persisted evidence or presenting conclusions supported by an incomplete set.
    diagnosis.provenance.evidence = diagnosis.provenance.evidence.slice(0, 100);
    diagnosis.provenance.mappingVersions =
      diagnosis.provenance.mappingVersions.slice(0, 100);
    diagnosis.status =
      diagnosis.status === 'pending' ? 'pending' : 'insufficient_evidence';
    diagnosis.reason = 'evidence_display_limit';
    diagnosis.summary =
      'The full evidence must be reviewed before drawing conclusions.';
    diagnosis.constraints = [
      `Only 100 of ${count} evidence references are shown. Findings and recommendations are withheld until the full evidence can be reviewed.`,
    ];
    diagnosis.facts = [];
    diagnosis.hypotheses = [];
    diagnosis.nextSteps = [];
    diagnosis.impact = {
      observed: [],
      potential: [],
      exposedQuantity: null,
      unit: null,
      cost: null,
    };
    const visibleRefs = new Set(diagnosis.provenance.evidence.map((e) => e.id));
    diagnosis.attention = {
      ...diagnosis.attention,
      suggested: false,
      evidenceRefs: diagnosis.attention.evidenceRefs.filter((id) =>
        visibleRefs.has(id),
      ),
    };
  }
  const expiry = diagnosis?.provenance.validUntil;
  const stale = expiry != null && Date.parse(expiry) < now.getTime();
  if (diagnosis && (stale || incident.state === 'resolved')) {
    diagnosis.superseded = true;
    diagnosis.nextSteps = [];
    if (stale) {
      diagnosis.status = 'insufficient_evidence';
      diagnosis.reason = 'stale_evidence';
    }
  }
  const summaries: Record<string, string> = {
    inventory_mismatch: 'Inventory quantities differ across mapped sources.',
    sync_failure: 'A connection read failed.',
    stuck_fulfillment: 'Fulfillment progress needs investigation.',
    workflow_failure: 'A workflow did not reach its expected outcome.',
  };

  return {
    schemaVersion: 1,
    id: incident.id,
    revision: row.version,
    class: incident.exceptionClass,
    state: incident.state,
    severity: incident.severity,
    summary:
      diagnosis && diagnosis.status !== 'pending' && !stale
        ? diagnosis.summary
        : (summaries[incident.exceptionClass] ??
          'An operation needs investigation.'),
    subject: {
      kind: incident.subject.subjectKind,
      id: incident.subject.subjectId,
      scope: incident.subject.scope,
    },
    sources: [
      ...new Set(
        diagnosis?.provenance.evidence.flatMap((e) =>
          e.source ? [e.source.provider] : [],
        ) ?? [],
      ),
    ],
    detectedAt: incident.firstDetectedAt,
    lastActivityAt: new Date(row.activity).toISOString(),
    attention: {
      required: row.attention_reason !== null,
      reason: row.attention_reason,
      explanation:
        row.attention_reason === 'approval'
          ? 'A policy approval is required.'
          : row.attention_reason === 'uncertainty'
            ? 'Unresolved uncertainty needs human investigation.'
            : row.attention_reason === 'manual_intervention'
              ? 'An authorized operator must review the manual next step.'
              : 'No human attention is currently requested.',
      requestedAt: row.attention_reason
        ? new Date(row.attention_at).toISOString()
        : null,
    },
    freshness: stale ? 'stale' : expiry ? 'fresh' : 'unknown',
    diagnosisStatus: diagnosis?.status ?? 'pending',
    resolution: incident.resolution
      ? incident.resolution.kind === 'verification'
        ? 'verified'
        : 'human_disposition'
      : null,
    diagnosis,
  };
}

/**
 * Creates persisted case, overview, and evidence reads with tenant-scoped pagination and
 * current freshness assessment.
 */
export function createCaseReader(
  db: TenantDatabase,
  now: () => Date,
): CaseReader {
  return {
    evidence: (tenantId, id, query) =>
      db.transaction(tenantId, async (tx) => {
        const found = await tx.query(
          'SELECT id FROM exceptions WHERE tenant_id=$1 AND id=$2',
          [tenantId, id],
        );
        if (!found.rowCount) return null;
        const key = createHash('sha256')
          .update(
            JSON.stringify([
              'case-evidence-v1',
              tenantId,
              id,
              query.limit,
              'id:C:asc',
            ]),
          )
          .digest('hex');
        let after: string | null = null;
        if (query.cursor) {
          try {
            const bytes = Buffer.from(query.cursor, 'base64url');
            if (bytes.toString('base64url') !== query.cursor)
              throw new Error('Invalid encoding');
            const cursor = z
              .object({ context: z.string(), id: z.string().min(1).max(512) })
              .strict()
              .parse(JSON.parse(bytes.toString('utf8')));
            if (cursor.context !== key)
              throw new Error('Cursor context mismatch');
            after = cursor.id;
          } catch {
            throw Object.assign(new Error('Invalid cursor context'), {
              statusCode: 400,
            });
          }
        }
        // Select only provenance fields. Provider payloads and arbitrary facts never cross this boundary.
        const result = await tx.query<{
          item: CaseEvidencePage['items'][number];
        }>(
          `
          WITH refs AS (
            SELECT ref.id FROM exception_evidence e
            JOIN exception_inputs i ON i.tenant_id=e.tenant_id AND i.evidence_key=e.evidence_key
            CROSS JOIN LATERAL jsonb_array_elements_text(i.document->'facts'->'evidenceRefs') AS ref(id)
            WHERE e.tenant_id=$1 AND e.exception_id=$2
            UNION
            SELECT evidence->>'id' FROM exception_diagnoses d
            CROSS JOIN LATERAL jsonb_array_elements(d.document->'provenance'->'evidence') AS evidence
            WHERE d.tenant_id=$1 AND d.exception_id=$2
            UNION
            SELECT jsonb_array_elements_text(document->'resolution'->'evidenceRefs')
            FROM exceptions WHERE tenant_id=$1 AND id=$2
          )
          SELECT jsonb_build_object(
            'id',s.evidence_key, 'observedAt',s.document->'observedAt',
            'sourceUpdatedAt',s.document->'sourceUpdatedAt',
            'adapterVersion',s.document->'adapterVersion', 'schemaVersion',s.document->'schemaVersion',
            'source',s.document->'source',
            'completeness',CASE s.document->'facts'->'complete'
              WHEN 'true'::jsonb THEN 'complete' WHEN 'false'::jsonb THEN 'incomplete' ELSE 'unknown' END
          ) AS item
          FROM refs JOIN exception_sources s ON s.tenant_id=$1 AND s.evidence_key=refs.id
          WHERE ($3::text IS NULL OR s.evidence_key COLLATE "C" > $3::text COLLATE "C")
          ORDER BY s.evidence_key COLLATE "C" LIMIT $4`,
          [tenantId, id, after, query.limit + 1],
        );
        const items = result.rows.slice(0, query.limit).map((row) => row.item);
        const last = items.at(-1);

        return {
          schemaVersion: 1,
          items,
          nextCursor:
            result.rows.length > query.limit && last
              ? Buffer.from(
                  JSON.stringify({ context: key, id: last.id }),
                ).toString('base64url')
              : null,
        };
      }),
    overview: (tenantId, start, end) =>
      db.transaction(tenantId, async (tx) => {
        // Counts and the bounded queue share one database snapshot and attention projection.
        const result = await tx.query<{
          attention_count: number;
          active_count: number;
          verified_resolutions: number;
          decisions: Row[];
        }>(
          `${projection}
        SELECT
          (SELECT count(*)::integer FROM ordered WHERE attention_reason IS NOT NULL) AS attention_count,
          (SELECT count(*)::integer FROM ordered WHERE document->>'state'<>'resolved') AS active_count,
          (SELECT count(*)::integer FROM ordered WHERE document->>'state'='resolved'
            AND document->'resolution'->>'kind'='verification'
            AND (document->'resolution'->>'at')::timestamptz >= $3::timestamptz
            AND (document->'resolution'->>'at')::timestamptz < $2::timestamptz) AS verified_resolutions,
          COALESCE((SELECT jsonb_agg(q) FROM (SELECT * FROM ordered WHERE attention_reason IS NOT NULL
            ORDER BY rank,sort_at::timestamptz,document->>'id' LIMIT 5) q),'[]'::jsonb) AS decisions`,
          [tenantId, end, start],
        );
        const row = result.rows[0]!;

        return {
          attentionCount: row.attention_count,
          activeCount: row.active_count,
          verifiedResolutions: row.verified_resolutions,
          prioritizedDecisions: row.decisions.map((value) => {
            const { diagnosis, ...summary } = project(value, new Date(end));
            void diagnosis;

            return summary;
          }),
        };
      }),
    list: (tenantId, query) =>
      db.transaction(tenantId, async (tx) => {
        const clock = now();
        const key = contextKey(tenantId, query);
        let cursor: z.infer<typeof cursorSchema> | undefined;
        if (query.cursor) {
          try {
            cursor = cursorSchema.parse(
              JSON.parse(Buffer.from(query.cursor, 'base64url').toString()),
            );
            if (cursor.context !== key)
              throw new Error('Cursor context mismatch');
          } catch {
            throw Object.assign(new Error('Invalid cursor context'), {
              statusCode: 400,
            });
          }
        }
        const result = await tx.query<{
          items: (Row & { sort_at: string })[];
          total_count: number;
          offset: number;
        }>(
          `${projection}
        , filtered AS (SELECT * FROM ordered WHERE
        ($3='needs_you' AND attention_reason IS NOT NULL OR $3='active' AND document->>'state'<>'resolved' OR $3='history' AND document->>'state'='resolved')
        AND ($4::text IS NULL OR document->>'exceptionClass'=$4)
        AND ($5::text IS NULL OR document->>'severity'=$5)
        AND ($6::text IS NULL OR document->>'state'=$6)),
        page AS (SELECT * FROM filtered WHERE ($7::integer IS NULL OR (rank,sort_at::timestamptz,document->>'id') > ($7,$8::timestamptz,$9))
        ORDER BY rank,sort_at::timestamptz,document->>'id' LIMIT $10)
        SELECT (SELECT count(*)::integer FROM filtered) AS total_count,
        (SELECT count(*)::integer FROM filtered WHERE $7::integer IS NOT NULL AND
          (rank,sort_at::timestamptz,document->>'id') <= ($7,$8::timestamptz,$9)) AS offset,
        COALESCE((SELECT jsonb_agg(page ORDER BY rank,sort_at::timestamptz,document->>'id') FROM page), '[]'::jsonb) AS items`,
          [
            tenantId,
            clock.toISOString(),
            query.view,
            query.class ?? null,
            query.severity ?? null,
            query.state ?? null,
            cursor?.rank ?? null,
            cursor?.at ?? null,
            cursor?.id ?? null,
            query.limit + 1,
          ],
        );
        const page = result.rows[0]!;
        const rows = page.items.slice(0, query.limit);
        const last = rows.at(-1);
        const coverage = await tx.query<{ observed: boolean }>(
          'SELECT EXISTS(SELECT 1 FROM exception_sources WHERE tenant_id=$1) AS observed',
          [tenantId],
        );

        return {
          totalCount: page.total_count,
          offset: page.offset,
          items: rows.map((row) => {
            const { diagnosis, ...summary } = project(row, clock);
            void diagnosis;

            return summary;
          }),
          nextCursor:
            page.items.length > query.limit && last
              ? Buffer.from(
                  JSON.stringify({
                    context: key,
                    rank: last.rank,
                    at: new Date(last.sort_at).toISOString(),
                    id: last.document.id,
                  }),
                ).toString('base64url')
              : null,
          coverage: coverage.rows[0]?.observed ? 'observed' : 'unobserved',
        };
      }),
    get: (tenantId, id) =>
      db.transaction(tenantId, async (tx) => {
        const clock = now();
        const result = await tx.query<Row>(
          `${projection} SELECT * FROM ordered WHERE document->>'id'=$3`,
          [tenantId, clock.toISOString(), id],
        );

        return result.rows[0] ? project(result.rows[0], clock) : null;
      }),
  };
}
