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
import type { Diagnosis, DiagnosisInput } from '../domain/diagnosis.js';
import { inventorySources } from '../domain/inventory-sources.js';
import {
  type CaseMetricItem,
  summarizeCaseMetrics,
} from '../domain/metrics.js';

type Row = {
  document: Incident;
  owner: import('../application/owners.js').CaseOwner | null;
  version: number;
  diagnosis: Diagnosis | null;
  attention_reason: 'approval' | 'manual_intervention' | 'uncertainty' | null;
  attention_at: string;
  activity: string;
  rank: number;
};

// Attention comes from persisted lifecycle, uncertainty escalation or deterministic manual steps.
// Model-selected hypotheses and severity never create an attention request.
// Inbox attention rules. Expects $1 tenant ID and $2 evaluation time. `columns` adds trusted
// select-list entries, such as the current policy decision `pa.document` and `pa.proposal`.
function caseQuery(filter = 'true', columns = '') {
  return `cases AS (
 SELECT e.document,e.version,owner.document || jsonb_build_object('name',person.name) AS owner,d.document AS diagnosis${columns},
 CASE WHEN e.state='resolved' THEN NULL
 WHEN e.state='escalated' OR u.review_required THEN 'uncertainty'
 WHEN pa.observe_only THEN 'manual_intervention'
 WHEN e.state='awaiting_approval' OR pa.document->>'outcome'='approval_required' THEN 'approval'
 WHEN d.document->>'status'='ready'
   AND (d.document->'provenance'->>'validUntil' IS NULL OR (d.document->'provenance'->>'validUntil')::timestamptz >= $2::timestamptz)
   AND d.document->'nextSteps' @> '[{"kind":"manual_intervention"}]'::jsonb THEN 'manual_intervention'
 ELSE NULL END AS attention_reason,
 COALESCE(CASE WHEN e.state='escalated' THEN command.at ELSE pa.requested_at END,u.first_deferred_at::text,d.document->'provenance'->>'generatedAt',e.document->>'firstDetectedAt') AS attention_at,
 GREATEST(e.document->>'lastDetectedAt',d.document->'provenance'->>'generatedAt',e.document->'resolution'->>'at',command.at,pa.document->>'evaluatedAt') AS activity,
 CASE WHEN e.document->>'severity'='high' THEN 0 ELSE 1 END AS rank
 FROM exceptions e
 LEFT JOIN case_owners owner ON owner.tenant_id=e.tenant_id AND owner.exception_id=e.id
 LEFT JOIN workspace_people person ON person.tenant_id=owner.tenant_id AND person.user_id=owner.user_id
 LEFT JOIN exception_diagnosis_heads h ON h.tenant_id=e.tenant_id AND h.exception_id=e.id
 LEFT JOIN exception_diagnoses d ON d.tenant_id=h.tenant_id AND d.exception_id=h.exception_id AND d.revision=h.revision
 LEFT JOIN exception_uncertainty u ON u.tenant_id=e.tenant_id AND u.fingerprint=e.fingerprint
 LEFT JOIN LATERAL (SELECT document->>'createdAt' AS at FROM case_commands WHERE tenant_id=e.tenant_id AND exception_id=e.id ORDER BY created_at DESC,id DESC LIMIT 1) command ON true
 LEFT JOIN LATERAL (
   SELECT pd.document,p.document AS proposal,
     (EXISTS(SELECT FROM organizations WHERE id=p.tenant_id AND write_mode='observe_only')
      OR EXISTS(SELECT FROM connector_installations WHERE tenant_id=p.tenant_id AND id=(p.document->>'connectionId')::uuid AND document->>'writeMode'='observe_only')
      OR EXISTS(SELECT FROM execution_observe_only WHERE tenant_id=p.tenant_id AND proposal_id=p.id)) AS observe_only,
     (SELECT min(first.document->>'evaluatedAt') FROM policy_decisions first
      WHERE first.tenant_id=p.tenant_id AND first.proposal_id=p.id AND first.action_hash=p.action_hash
      AND first.document->>'outcome'='approval_required'
      AND first.document->>'policyVersion'=pd.document->>'policyVersion'
      AND first.document->>'actorId'=pd.document->>'actorId') AS requested_at
   FROM case_proposals p
   LEFT JOIN LATERAL (SELECT * FROM policy_decisions WHERE tenant_id=p.tenant_id AND proposal_id=p.id AND action_hash=p.action_hash ORDER BY created_at DESC,id DESC LIMIT 1) pd ON true
   WHERE p.tenant_id=e.tenant_id AND p.exception_id=e.id AND p.diagnosis_revision=h.revision
   AND d.document->>'status'='ready'
   AND (d.document->'provenance'->>'validUntil' IS NULL OR (d.document->'provenance'->>'validUntil')::timestamptz>$2::timestamptz)
   AND (p.document->>'expiresAt')::timestamptz>$2::timestamptz
   AND (p.document->'preconditions'->>'validUntil')::timestamptz>$2::timestamptz
   AND NOT EXISTS(SELECT 1 FROM policy_approvals a WHERE a.tenant_id=p.tenant_id AND a.proposal_id=p.id AND a.action_hash=p.action_hash AND a.policy_version=pd.document->>'policyVersion')
 ) pa ON true
 WHERE e.tenant_id=$1 AND (${filter})
), ordered AS (SELECT *, CASE WHEN attention_reason IS NULL THEN document->>'firstDetectedAt' ELSE attention_at END AS sort_at FROM cases)`;
}

const caseCtes = caseQuery();

const projection = `WITH ${caseCtes}`;

/**
 * Selects `order_id` and `issue_id` for every unresolved fulfillment issue that needs a person
 * under the inbox's attention rules. Other reads embed it in their own transaction; bind `$1`
 * to the tenant ID and `$2` to the evaluation time.
 */
function attentionQuery(
  filter = "e.state<>'resolved' AND e.subject_kind='fulfillment'",
) {
  return `WITH ${caseQuery(filter)}
 SELECT DISTINCT r.order_id,(o.document->>'id')::uuid AS issue_id
 FROM ordered o
 JOIN connector_source_mappings m ON m.tenant_id=$1
  AND m.resource='fulfillment'
  AND m.connection_id::text=o.document->'subject'->'scope'->>0
  AND m.external_id=o.document->'subject'->>'subjectId'
  AND m.scope_key=''
 JOIN orders_relationships r ON r.tenant_id=m.tenant_id AND r.child_id=m.canonical_id
 WHERE o.attention_reason IS NOT NULL AND o.document->'subject'->>'subjectKind'='fulfillment'`;
}

/** Selects all unresolved order attention using the inbox rules at $2. */
export const orderAttentionQuery = attentionQuery();

/**
 * Selects every unresolved case that needs a person under the inbox's attention rules, with the
 * compact facts a decision queue presents: the current proposal and policy decision for
 * approvals, the first manual step and the diagnosis evidence window. An approval whose current
 * proposal already has a response under its latest policy version, or a rejection, is left out:
 * the case stays `awaiting_approval` until its workflow observes the response, but nobody needs
 * to decide again. Stale diagnoses keep their `summary` and `manual_step`; callers must check
 * `valid_until`. Bind `$1` to the tenant ID and `$2` to the evaluation time.
 */
export const caseDecisionQuery = `WITH ${caseQuery("e.state<>'resolved'", ',pa.document AS policy,pa.proposal,pa.observe_only')}
 SELECT o.owner,(o.document->>'id')::uuid AS exception_id,o.attention_reason AS reason,
  o.attention_at::timestamptz AS requested_at,o.document->>'severity' AS severity,
  o.document->>'exceptionClass' AS class,o.document->>'state' AS state,o.document->'subject' AS subject,
  o.diagnosis->>'status' AS diagnosis_status,o.diagnosis->>'summary' AS summary,
  (o.diagnosis->'provenance'->>'validUntil')::timestamptz AS valid_until,
  (SELECT min((ev->>'observedAt')::timestamptz) FROM jsonb_array_elements(o.diagnosis->'provenance'->'evidence') ev) AS observed_at,
  (SELECT step->>'text' FROM jsonb_array_elements(o.diagnosis->'nextSteps') step
    WHERE step->>'kind'='manual_intervention' LIMIT 1) AS manual_step,
  o.diagnosis->'impact'->>'exposedQuantity' AS exposed_quantity,o.diagnosis->'impact'->>'unit' AS exposed_unit,
  o.policy->>'actorId' AS requester_id,o.policy->>'id' AS decision_id,o.proposal,o.observe_only,
  (SELECT workspace_requires_independent_approval()) AS require_independent_approval
 FROM ordered o WHERE o.attention_reason IS NOT NULL
 AND NOT (o.attention_reason='approval' AND EXISTS (
  SELECT 1 FROM case_proposals p
  JOIN policy_approvals a ON a.tenant_id=p.tenant_id AND a.proposal_id=p.id AND a.action_hash=p.action_hash
  WHERE p.tenant_id=$1 AND p.exception_id=(o.document->>'id')::uuid
  AND p.diagnosis_revision=(o.diagnosis->>'revision')::integer
  AND (a.document->>'outcome'='rejected' OR a.policy_version=(
   SELECT d.document->>'policyVersion' FROM policy_decisions d
   WHERE d.tenant_id=p.tenant_id AND d.proposal_id=p.id AND d.action_hash=p.action_hash
   ORDER BY d.created_at DESC,d.id DESC LIMIT 1))))`;

/**
 * Selects every issue with its class, severity, state, first detection, current resolution and
 * why it needs a person under the inbox's attention rules. A reopened issue keeps its first
 * detection; `resolved_at` and `resolution` describe only a currently resolved issue. Missing or
 * malformed detection times are null. Bind `$1` to the tenant ID and `$2` to the evaluation time.
 */
export const caseTimelineQuery = `WITH ${caseCtes}
 SELECT DISTINCT ON (document->>'id') (document->>'id')::uuid AS id,document->>'exceptionClass' AS class,
  document->>'severity' AS severity,document->>'state' AS state,
  CASE WHEN document->>'firstDetectedAt' ~ '^\\d{4}-\\d{2}-\\d{2}T' THEN (document->>'firstDetectedAt')::timestamptz END AS detected_at,
  CASE WHEN document->>'state'='resolved' AND document->'resolution'->>'at' ~ '^\\d{4}-\\d{2}-\\d{2}T'
   THEN (document->'resolution'->>'at')::timestamptz END AS resolved_at,
  CASE WHEN document->>'state'<>'resolved' THEN NULL
   WHEN document->'resolution'->>'kind'='verification' THEN 'verified'
   WHEN document->'resolution'->>'kind'='human_disposition' THEN 'human_disposition' END AS resolution,
  attention_reason AS attention
 FROM ordered ORDER BY document->>'id'`;

/**
 * Limits attention evaluation to the trusted SQL relation's entity_id column. The relation
 * must contain tenant-scoped order IDs; values remain bound through $1 and $2.
 */
export function orderAttentionForOrders(orders: string) {
  return attentionQuery(`e.state<>'resolved' AND e.subject_kind='fulfillment' AND e.id IN (
    SELECT issue.id FROM orders_relationships r
    JOIN connector_source_mappings m ON m.tenant_id=r.tenant_id AND m.canonical_id=r.child_id
      AND m.resource='fulfillment' AND m.scope_key=''
    JOIN exceptions issue ON issue.tenant_id=m.tenant_id AND issue.subject_kind='fulfillment'
      AND issue.subject_id=m.external_id AND issue.document->'subject'->'scope'->>0=m.connection_id::text
    WHERE r.tenant_id=$1 AND r.order_id IN (SELECT entity_id FROM ${orders}))`);
}

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
        query.ownerId ?? null,
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
    order_quantity_mismatch: 'Order line quantities differ between systems.',
    sync_failure: 'A connection read failed.',
    stuck_fulfillment: 'Fulfillment progress needs investigation.',
    workflow_failure: 'A workflow did not reach its expected outcome.',
  };

  return {
    schemaVersion: 1,
    owner: row.owner,
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
        AND ($6::text IS NULL OR document->>'state'=$6)
        AND ($11::text IS NULL OR ($11='unassigned' AND owner->>'userId' IS NULL) OR owner->>'userId'=$11)),
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
            query.ownerId ?? null,
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
        const result = await tx.query<
          Row & { diagnosis_snapshot: DiagnosisInput | null }
        >(
          `${projection} SELECT ordered.*, (SELECT d.snapshot FROM exception_diagnoses d
            WHERE d.tenant_id=$1 AND d.exception_id=$3::text::uuid AND d.revision=(ordered.diagnosis->>'revision')::integer) AS diagnosis_snapshot
            FROM ordered WHERE document->>'id'=$3`,
          [tenantId, clock.toISOString(), id],
        );

        const row = result.rows[0];

        return row
          ? {
              ...project(row, clock),
              inventorySources: inventorySources(row.diagnosis_snapshot),
            }
          : null;
      }),
  };
}

/** Returns the next diagnosis or approval expiry that can change order attention without a write. */
export function createOrderAttentionBoundaryReader(db: TenantDatabase) {
  return (tenantId: string, asOf: string): Promise<string | null> =>
    db.transaction(tenantId, async (tx) => {
      const result = await tx.query<{ boundary: string | null }>(
        `SELECT min(at)::text AS boundary FROM (
      SELECT (document->'provenance'->>'validUntil')::timestamptz AS at FROM exception_diagnoses WHERE tenant_id=$1
      UNION ALL SELECT (document->'provenance'->>'validUntil')::timestamptz + interval '1 millisecond' FROM exception_diagnoses WHERE tenant_id=$1
      UNION ALL SELECT (document->>'expiresAt')::timestamptz FROM case_proposals WHERE tenant_id=$1
      UNION ALL SELECT (document->'preconditions'->>'validUntil')::timestamptz FROM case_proposals WHERE tenant_id=$1
    ) boundaries WHERE at > $2::timestamptz`,
        [tenantId, asOf],
      );
      const boundary = result.rows[0]?.boundary;

      return boundary ? new Date(boundary).toISOString() : null;
    });
}

/** Reads all subject kinds from the inbox's authoritative attention projection. */
export function createCaseMetricReader(db: TenantDatabase) {
  return async (tenantId: string, asOf: string) =>
    db.transaction(tenantId, async (tx) => {
      const result = await tx.query<{ item: CaseMetricItem }>(
        `${projection}
      SELECT DISTINCT ON (document->>'id') jsonb_build_object(
        'kind','case','id',document->>'id','subjectKind',document->'subject'->>'subjectKind',
        'subjectId',document->'subject'->>'subjectId','state',document->>'state',
        'title',document->>'exceptionClass','detectedAt',document->>'firstDetectedAt',
        'ageSeconds',NULL,'reason',attention_reason) AS item
      FROM ordered WHERE document->>'state'<>'resolved' ORDER BY document->>'id'`,
        [tenantId, asOf],
      );
      const boundary = await createOrderAttentionBoundaryReader({
        transaction: async (_tenantId, operation) => operation(tx),
      })(tenantId, asOf);

      return summarizeCaseMetrics(
        result.rows.map((row) => row.item),
        asOf,
        boundary,
      );
    });
}
