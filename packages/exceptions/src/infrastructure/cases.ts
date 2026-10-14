import { createHash } from 'node:crypto';

import type { TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import type {
  CaseDetail,
  CaseEvidencePage,
  CaseGroup,
  CaseListPage,
  CaseReader,
} from '../application/cases.js';
import type { Incident } from '../application/detection.js';
import type { Diagnosis, DiagnosisInput } from '../domain/diagnosis.js';
import type { Configuration } from '../domain/facts.js';
import { inventorySources } from '../domain/inventory-sources.js';
import {
  type CaseMetricItem,
  summarizeCaseMetrics,
} from '../domain/metrics.js';
import {
  afterPosition,
  atOrBefore,
  boundGroupKey,
  caseCursorContext,
  caseFilter,
  caseGroupFields,
  caseListError,
  CaseListParameters,
  type CasePosition,
  decodeCaseCursor,
  encodeCaseCursor,
  sortColumns,
  sortOrder,
} from './case-list.js';

type Row = {
  subject_label?: string | null;
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
 SELECT COALESCE(
 (SELECT c.document->>'label' FROM connector_installations c WHERE c.tenant_id=e.tenant_id AND c.id::text=e.document->'subject'->>'subjectId'),
 (SELECT COALESCE((SELECT code FROM inventory_product_skus sku WHERE sku.tenant_id=k.tenant_id AND sku.sku_id=k.id AND sku.code_key IS NOT NULL ORDER BY sku.connection_id LIMIT 1),CASE WHEN left(k.reconciliation_key,10)='["source",' THEN k.reconciliation_key::jsonb->>4 ELSE k.reconciliation_key END) FROM inventory_entities k WHERE k.tenant_id=e.tenant_id AND k.id::text=e.document->'subject'->>'subjectId'),
 CASE WHEN e.document->'subject'->>'subjectId' !~* '^[0-9a-f-]{36}$' THEN e.document->'subject'->>'subjectId' END) AS subject_label,e.document,e.version,owner.document || jsonb_build_object('name',person.name) AS owner,d.document AS diagnosis${columns},
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
  o.document->>'exceptionClass' AS class,o.document->>'state' AS state,o.document->'subject' || jsonb_build_object('label',o.subject_label) AS subject,
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

/** The summary of an issue whose investigation can't be shown, by class. */
const fallbackSummaries: Readonly<Record<string, string>> = {
  inventory_mismatch: 'Inventory quantities differ across mapped sources.',
  order_quantity_mismatch: 'Order line quantities differ between systems.',
  sync_failure: 'A connection read failed.',
  stuck_fulfillment: 'Fulfillment progress needs investigation.',
  workflow_failure: 'A workflow did not reach its expected outcome.',
};

const fallbackSummary = 'An operation needs investigation.';

/** Investigations show at most this many evidence references; more withhold their findings. */
const evidenceDisplayLimit = 100;

const withheldSummary =
  'The full evidence must be reviewed before drawing conclusions.';

const sqlText = (text: string) => `'${text.replaceAll("'", "''")}'`;

/**
 * The `listed` relation: every case of `ordered` with the values the list filters, sorts,
 * groups and searches, computed exactly as `project` presents them at `$2`. Stale or missing
 * investigation validity is never fresh.
 */
const listedCte = `listed AS (
 SELECT o.*,o.document->>'id' AS id,o.document->>'exceptionClass' AS class,o.document->>'state' AS state,
  o.document->>'severity' AS severity,o.document->'subject'->>'subjectKind' AS subject_kind,
  o.document->'subject'->>'subjectId' AS subject_id,(o.owner->>'userId')::uuid AS owner_id,o.owner->>'name' AS owner_name,
  ARRAY(SELECT DISTINCT e.value->'source'->>'provider'
   FROM jsonb_array_elements(COALESCE(o.diagnosis->'provenance'->'evidence','[]'::jsonb)) WITH ORDINALITY AS e(value,position)
   WHERE e.position<=${evidenceDisplayLimit} AND e.value->'source'->>'provider' IS NOT NULL) AS sources,
  CASE WHEN d.valid_until IS NULL THEN 'unknown' WHEN d.valid_until<$2::timestamptz THEN 'stale' ELSE 'fresh' END AS freshness,
  CASE WHEN o.diagnosis IS NULL THEN 'pending'
   WHEN d.valid_until<$2::timestamptz THEN 'insufficient_evidence'
   WHEN o.diagnosis->>'status'='pending' THEN 'pending'
   WHEN d.evidence>${evidenceDisplayLimit} THEN 'insufficient_evidence'
   ELSE o.diagnosis->>'status' END AS diagnosis_status,
  CASE WHEN jsonb_typeof(o.document->'resolution')='object' THEN
   CASE WHEN o.document->'resolution'->>'kind'='verification' THEN 'verified' ELSE 'human_disposition' END END AS resolution,
  CASE WHEN o.diagnosis IS NOT NULL AND o.diagnosis->>'status'<>'pending' AND NOT COALESCE(d.valid_until<$2::timestamptz,false)
   THEN CASE WHEN d.evidence>${evidenceDisplayLimit} THEN ${sqlText(withheldSummary)} ELSE o.diagnosis->>'summary' END
   ELSE CASE o.document->>'exceptionClass' ${Object.entries(fallbackSummaries)
     .map(([key, text]) => `WHEN ${sqlText(key)} THEN ${sqlText(text)}`)
     .join(' ')} ELSE ${sqlText(fallbackSummary)} END END AS summary,
  CASE WHEN o.document->>'firstDetectedAt' ~ '^\\d{4}-\\d{2}-\\d{2}T' THEN (o.document->>'firstDetectedAt')::timestamptz END AS detected_at,
  o.activity::timestamptz AS last_activity,
  CASE WHEN o.attention_reason IS NOT NULL THEN o.attention_at::timestamptz END AS waiting_since
 FROM ordered o CROSS JOIN LATERAL (SELECT (o.diagnosis->'provenance'->>'validUntil')::timestamptz AS valid_until,
  jsonb_array_length(COALESCE(o.diagnosis->'provenance'->'evidence','[]'::jsonb)) AS evidence) d
)`;

const groupFields = caseGroupFields();

/** Groups a grouped read returns at most; `groupsTruncated` says when more match. */
const maxGroups = 50;

type ListRow = Row & {
  id: string;
  sort_missing: number;
  sort_rank: number;
  sort_key: string;
};

const position = (row: {
  sort_missing: number;
  sort_rank: number;
  sort_key: string;
  id: string;
}): CasePosition => ({
  missing: row.sort_missing,
  rank: row.sort_rank,
  at: row.sort_key,
  id: row.id,
});

function zoneOf(timeZone: string | undefined) {
  const zone = timeZone ?? 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
  } catch {
    throw caseListError('Use an IANA time zone, such as Europe/Berlin.');
  }

  return zone;
}

function project(row: Row, now: Date): CaseDetail {
  const incident = row.document;
  const diagnosis = row.diagnosis ? structuredClone(row.diagnosis) : null;
  if (
    diagnosis &&
    diagnosis.provenance.evidence.length > evidenceDisplayLimit
  ) {
    const count = diagnosis.provenance.evidence.length;
    // Pending snapshots bypass diagnosis validation. Bound the read without deleting
    // persisted evidence or presenting conclusions supported by an incomplete set.
    diagnosis.provenance.evidence = diagnosis.provenance.evidence.slice(
      0,
      evidenceDisplayLimit,
    );
    diagnosis.provenance.mappingVersions =
      diagnosis.provenance.mappingVersions.slice(0, evidenceDisplayLimit);
    diagnosis.status =
      diagnosis.status === 'pending' ? 'pending' : 'insufficient_evidence';
    diagnosis.reason = 'evidence_display_limit';
    diagnosis.summary = withheldSummary;
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
        : (fallbackSummaries[incident.exceptionClass] ?? fallbackSummary),
    subject: {
      label: row.subject_label ?? undefined,
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
    overview: (tenantId, start, end, readAt = end) =>
      db.transaction(tenantId, async (tx) => {
        // Counts and the bounded queue share one database snapshot and attention projection.
        const result = await tx.query<{
          attention_count: number;
          active_count: number;
          verified_resolutions: number;
          verified_cases: Row[];
          decisions: Row[];
        }>(
          `${projection}
        SELECT
          (SELECT count(*)::integer FROM ordered WHERE attention_reason IS NOT NULL) AS attention_count,
          (SELECT count(*)::integer FROM ordered WHERE document->>'state'<>'resolved') AS active_count,
          (SELECT count(*)::integer FROM ordered WHERE document->>'state'='resolved'
            AND document->'resolution'->>'kind'='verification'
            AND (document->'resolution'->>'at')::timestamptz >= $3::timestamptz
            AND (document->'resolution'->>'at')::timestamptz < $4::timestamptz) AS verified_resolutions,
          COALESCE((SELECT jsonb_agg(q) FROM (SELECT * FROM ordered WHERE document->>'state'='resolved'
            AND document->'resolution'->>'kind'='verification'
            AND (document->'resolution'->>'at')::timestamptz >= $3::timestamptz
            AND (document->'resolution'->>'at')::timestamptz < $4::timestamptz
            ORDER BY (document->'resolution'->>'at')::timestamptz DESC,document->>'id' LIMIT 5) q),'[]'::jsonb) AS verified_cases,
          COALESCE((SELECT jsonb_agg(q) FROM (SELECT * FROM ordered WHERE attention_reason IS NOT NULL
            ORDER BY rank,sort_at::timestamptz,document->>'id' LIMIT 5) q),'[]'::jsonb) AS decisions`,
          [tenantId, readAt, start, end],
        );
        const row = result.rows[0]!;

        return {
          attentionCount: row.attention_count,
          activeCount: row.active_count,
          verifiedResolutions: row.verified_resolutions,
          verifiedCases: row.verified_cases.map((value) => {
            const { diagnosis, ...summary } = project(value, new Date(readAt));
            void diagnosis;

            return summary;
          }),
          prioritizedDecisions: row.decisions.map((value) => {
            const { diagnosis, ...summary } = project(value, new Date(readAt));
            void diagnosis;

            return summary;
          }),
        };
      }),
    list: (tenantId, query, actorId) =>
      db.transaction(tenantId, async (tx): Promise<CaseListPage> => {
        const clock = now();
        if (query.groupKey !== undefined && !query.group)
          throw caseListError('Choose a grouping to read one group.');
        const groupField =
          query.group && Object.hasOwn(groupFields, query.group.field)
            ? groupFields[query.group.field]
            : undefined;
        if (query.group && (!groupField || query.group.granularity))
          throw caseListError('This field cannot be grouped');
        const grouped = !!groupField && query.groupKey === undefined;
        if (grouped && query.cursor)
          throw caseListError(
            'Use a group’s page link together with its group key.',
          );
        const context = caseCursorContext(
          tenantId,
          actorId,
          query,
          query.groupKey,
        );
        const cursor = query.cursor
          ? decodeCaseCursor(query.cursor, context)
          : undefined;
        const parameters = new CaseListParameters([
          tenantId,
          clock.toISOString(),
        ]);
        const timeZone = zoneOf(query.timeZone);
        let zone: string | undefined;
        const compile = {
          parameters,
          now: '$2::timestamptz',
          // Bound on first use: PostgreSQL rejects parameters a query never reads.
          get zone() {
            zone ??= parameters.bind(timeZone, 'text');

            return zone;
          },
          actorId,
        };
        let filter = caseFilter(query, compile);
        if (groupField && query.groupKey !== undefined) {
          const key = boundGroupKey(groupField, query.groupKey, parameters);
          filter += ` AND ${key === null ? groupField.empty : groupField.member(key)}`;
        }
        const base = `${projection}, ${listedCte},
        filtered AS (SELECT l.*,${sortColumns(query)} FROM listed l WHERE ${filter})`;
        const coverage = async () =>
          (
            await tx.query<{ observed: boolean }>(
              'SELECT EXISTS(SELECT 1 FROM exception_sources WHERE tenant_id=$1) AS observed',
              [tenantId],
            )
          ).rows[0]?.observed
            ? ('observed' as const)
            : ('unobserved' as const);
        const summary = (row: ListRow) => {
          const { diagnosis, ...item } = project(row, clock);
          void diagnosis;

          return item;
        };

        if (grouped && groupField) {
          const perGroup = parameters.bind(
            Math.min(Math.max(query.groupLimit ?? 10, 1), 50),
            'integer',
          );
          const result = await tx.query<{
            total_count: number;
            groups: {
              key: string | null;
              count: number;
              head: {
                id: string;
                sort_missing: number;
                sort_rank: number;
                sort_key: string;
              }[];
            }[];
            truncated: boolean;
            items: ListRow[];
          }>(
            `${base},
        keyed AS (SELECT l.*,k.key FROM filtered l CROSS JOIN LATERAL (${groupField.keys}) k),
        group_list AS (SELECT g.key,count(*)::integer AS count,
          row_number() OVER (ORDER BY g.key IS NULL,${groupField.order(parameters)}) AS position
          FROM keyed g GROUP BY g.key ORDER BY position LIMIT ${maxGroups + 1}),
        heads AS (SELECT h.* FROM (SELECT g.*,row_number() OVER (PARTITION BY g.key ORDER BY ${sortOrder(query, 'g')}) AS n FROM keyed g) h
          JOIN group_list gl ON gl.key IS NOT DISTINCT FROM h.key AND gl.position<=${maxGroups} WHERE h.n<=${perGroup})
        SELECT (SELECT count(*)::integer FROM filtered) AS total_count,
        (SELECT count(*)>${maxGroups} FROM group_list) AS truncated,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('key',gl.key,'count',gl.count,
          'head',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',h.id,'sort_missing',h.sort_missing,'sort_rank',h.sort_rank,'sort_key',h.sort_key)
            ORDER BY h.n) FROM heads h WHERE h.key IS NOT DISTINCT FROM gl.key),'[]'::jsonb)) ORDER BY gl.position)
          FROM group_list gl WHERE gl.position<=${maxGroups}),'[]'::jsonb) AS groups,
        COALESCE((SELECT jsonb_agg(d) FROM (SELECT DISTINCT ON (h.id) h.* FROM heads h ORDER BY h.id) d),'[]'::jsonb) AS items`,
            parameters.values,
          );
          const row = result.rows[0]!;
          const groups: CaseGroup[] = row.groups.map((group) => {
            const last = group.head.at(-1);

            return {
              key: group.key,
              count: group.count,
              complete: true,
              itemIds: group.head.map((item) => item.id),
              nextCursor:
                last && group.count > group.head.length
                  ? encodeCaseCursor(
                      caseCursorContext(tenantId, actorId, query, group.key),
                      position(last),
                    )
                  : null,
              sums: [],
            };
          });

          return {
            totalCount: row.total_count,
            offset: 0,
            items: row.items.map(summary),
            nextCursor: null,
            coverage: await coverage(),
            groups,
            groupsTruncated: row.truncated,
          };
        }

        const after = afterPosition(query, 'f', cursor, parameters);
        const before = cursor
          ? atOrBefore(query, 'f', cursor, parameters)
          : 'false';
        const limit = parameters.bind(query.limit + 1, 'integer');
        const result = await tx.query<{
          items: ListRow[];
          total_count: number;
          offset: number;
        }>(
          `${base},
        page AS (SELECT * FROM filtered f WHERE ${after} ORDER BY ${sortOrder(query, 'f')} LIMIT ${limit})
        SELECT (SELECT count(*)::integer FROM filtered) AS total_count,
        (SELECT count(*)::integer FROM filtered f WHERE ${before}) AS offset,
        COALESCE((SELECT jsonb_agg(p ORDER BY ${sortOrder(query, 'p')}) FROM page p), '[]'::jsonb) AS items`,
          parameters.values,
        );
        const page = result.rows[0]!;
        const rows = page.items.slice(0, query.limit);
        const last = rows.at(-1);
        const nextCursor =
          page.items.length > query.limit && last
            ? encodeCaseCursor(context, position(last))
            : null;

        return {
          totalCount: page.total_count,
          offset: page.offset,
          items: rows.map(summary),
          nextCursor,
          coverage: await coverage(),
          ...(query.groupKey !== undefined
            ? {
                groups: [
                  {
                    key: query.groupKey,
                    count: page.total_count,
                    complete: true,
                    itemIds: rows.map((row) => row.id),
                    nextCursor,
                    sums: [],
                  },
                ],
              }
            : {}),
        };
      }),
    get: (tenantId, id) =>
      db.transaction(tenantId, async (tx) => {
        const clock = now();
        const result = await tx.query<
          Row & {
            configuration: Configuration | null;
            diagnosis_snapshot: DiagnosisInput | null;
          }
        >(
          `${projection} SELECT ordered.*, (SELECT document FROM exception_configurations WHERE tenant_id=$1 AND version=ordered.document->>'configVersion') AS configuration, (SELECT d.snapshot FROM exception_diagnoses d
            WHERE d.tenant_id=$1 AND d.exception_id=$3::text::uuid AND d.revision=(ordered.diagnosis->>'revision')::integer) AS diagnosis_snapshot
            FROM ordered WHERE document->>'id'=$3`,
          [tenantId, clock.toISOString(), id],
        );

        const row = result.rows[0];

        return row
          ? {
              ...project(row, clock),
              inventorySources: inventorySources(row.diagnosis_snapshot),
              ...(row.configuration
                ? {
                    detectionLimits: {
                      inventoryTolerance: row.configuration.inventoryTolerance,
                      propagationSeconds:
                        row.configuration.thresholds.propagationSeconds,
                      oversellPropagationSeconds:
                        row.configuration.thresholds
                          .oversellPropagationSeconds ??
                        row.configuration.thresholds.propagationSeconds,
                      stuckSeconds: row.configuration.thresholds.stuckSeconds,
                    },
                  }
                : {}),
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
