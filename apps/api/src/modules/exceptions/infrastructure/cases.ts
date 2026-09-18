import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  CaseDetail,
  CaseQuery,
} from '#modules/exceptions/application/cases';
import type { TenantDatabase } from '#modules/platform/index';
import type { CaseReader } from '#modules/exceptions/application/cases';
import type { Incident } from '#modules/exceptions/application/detection';
import type { Diagnosis } from '#modules/exceptions/domain/diagnosis';

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
 WHEN e.state='awaiting_approval' THEN 'approval'
 WHEN e.state='escalated' OR u.review_required THEN 'uncertainty'
 WHEN d.document->>'status'='ready'
   AND (d.document->'provenance'->>'validUntil' IS NULL OR (d.document->'provenance'->>'validUntil')::timestamptz >= $2::timestamptz)
   AND d.document->'nextSteps' @> '[{"kind":"manual_intervention"}]'::jsonb THEN 'manual_intervention'
 ELSE NULL END AS attention_reason,
 COALESCE(u.first_deferred_at::text,d.document->'provenance'->>'generatedAt',e.document->>'firstDetectedAt') AS attention_at,
 GREATEST(e.document->>'lastDetectedAt',d.document->'provenance'->>'generatedAt',e.document->'resolution'->>'at') AS activity,
 CASE WHEN e.document->>'severity'='high' THEN 0 ELSE 1 END AS rank
 FROM exceptions e
 LEFT JOIN exception_diagnosis_heads h ON h.tenant_id=e.tenant_id AND h.exception_id=e.id
 LEFT JOIN exception_diagnoses d ON d.tenant_id=h.tenant_id AND d.exception_id=h.exception_id AND d.revision=h.revision
 LEFT JOIN exception_uncertainty u ON u.tenant_id=e.tenant_id AND u.fingerprint=e.fingerprint
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
export function createCaseReader(
  db: TenantDatabase,
  now: () => Date,
): CaseReader {
  return {
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
        const result = await tx.query<Row & { sort_at: string }>(
          `${projection}
        SELECT * FROM ordered WHERE
        ($3='needs_you' AND attention_reason IS NOT NULL OR $3='active' AND document->>'state'<>'resolved' OR $3='history' AND document->>'state'='resolved')
        AND ($4::text IS NULL OR document->>'exceptionClass'=$4)
        AND ($5::text IS NULL OR document->>'severity'=$5)
        AND ($6::text IS NULL OR document->>'state'=$6)
        AND ($7::integer IS NULL OR (rank,sort_at::timestamptz,document->>'id') > ($7,$8::timestamptz,$9))
        ORDER BY rank,sort_at::timestamptz,document->>'id' LIMIT $10`,
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
        const rows = result.rows.slice(0, query.limit);
        const last = rows.at(-1);
        const coverage = await tx.query<{ observed: boolean }>(
          'SELECT EXISTS(SELECT 1 FROM exception_sources WHERE tenant_id=$1) AS observed',
          [tenantId],
        );
        return {
          items: rows.map((row) => {
            const { diagnosis, ...summary } = project(row, clock);
            void diagnosis;
            return summary;
          }),
          nextCursor:
            result.rows.length > query.limit && last
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
