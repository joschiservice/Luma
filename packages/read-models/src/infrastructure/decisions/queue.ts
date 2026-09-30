import { createHash } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import { IdentityError, requireTenant } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import type {
  DecisionCandidate,
  DecisionItem,
  DecisionList,
  DecisionProvider,
  DecisionQuery,
  DecisionQueue,
} from '../../application/decisions.js';
import {
  type CaseDecisionFacts,
  evidenceState,
  expiringWindowMinutes,
  presentCase,
  urgencies,
} from '../../domain/decisions.js';

const cursorSchema = z
  .object({
    context: z.string(),
    asOf: z.string().datetime({ offset: true }),
    rank: z.number().int().min(0).max(2),
    deadline: z.string().min(1).max(64),
    requestedAt: z.string().min(1).max(64),
    id: z.string().min(1).max(200),
  })
  .strict();

type Cursor = z.infer<typeof cursorSchema>;

type PageRow = {
  id: string;
  rank: 0 | 1 | 2;
  deadlineKey: string;
  requestedAt: string;
  facts: CaseDecisionFacts | null;
  assignment: DecisionItem['assignment'];
  record: DecisionItem['record'];
};

const emptyCounts = <K extends string>(keys: readonly K[]) =>
  Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;

const views = ['all', 'mine', 'unassigned'] as const;
const domains = [
  'orders',
  'fulfillment',
  'inventory',
  'procurement',
  'operations',
] as const;
const reasons = [
  'approval',
  'run',
  'recovery',
  'manual_intervention',
  'uncertainty',
] as const;

// Case facts come from the exceptions owner's attention rules; external rows are presented by
// their owners before this query and only contribute ranking and record lookup columns.
// Rank 0: the deadline falls within the expiring window; 1: high impact; 2: the rest. Unknown
// impact is not ranked below known low impact. Binds: $1 tenant, $2 evaluation time, $3 external rows,
// $4 expiring window minutes, $5 view, $6 reader, $7 domain, $8 reason, $9-$12 cursor,
// $13 page size + 1, $14 one item ID.
function queueSql(cases: string) {
  return `WITH case_rows AS (${cases}),
 cases AS (
  SELECT 'case:'||c.exception_id AS id,c.reason,
   CASE WHEN c.subject->>'subjectKind' IN ('sku','inventory_position','position','product') OR c.class='inventory_mismatch' THEN 'inventory'
    WHEN c.subject->>'subjectKind'='fulfillment' OR c.class='stuck_fulfillment' THEN 'fulfillment'
    WHEN c.subject->>'subjectKind'='order' THEN 'orders'
    WHEN c.subject->>'subjectKind' IN ('supplier','purchase_order','invoice') THEN 'procurement'
    ELSE 'operations' END AS domain,
   CASE WHEN c.severity IN ('high','medium','low') THEN c.severity ELSE 'unknown' END AS impact,
   c.requested_at,
   CASE WHEN c.reason='approval' AND c.proposal IS NOT NULL THEN LEAST((c.proposal->>'expiresAt')::timestamptz,
    (c.proposal->'preconditions'->>'validUntil')::timestamptz,c.valid_until) END AS deadline,
   CASE WHEN c.subject->>'subjectKind' IN ('order','fulfillment','sku','product') THEN c.subject->>'subjectKind' END AS record_kind,
   NULL::text AS record_id,c.subject->'scope'->>0 AS record_connection,c.subject->>'subjectId' AS record_external,
   to_jsonb(c) AS facts
  FROM case_rows c),
 external AS (
  SELECT x.id,x.reason,x.domain,x.impact,x.requested_at,x.deadline,x.record_kind,x.record_id,
   x.record_connection,x.record_external,NULL::jsonb AS facts
  FROM jsonb_to_recordset($3::jsonb) AS x(id text,reason text,domain text,impact text,requested_at timestamptz,
   deadline timestamptz,record_kind text,record_id text,record_connection text,record_external text)),
 ranked AS (
  SELECT c.*,a.assignee_id,a.assigned_by,a.assigned_at,a.revision,
   CASE WHEN c.deadline IS NOT NULL AND c.deadline<=$2::timestamptz+make_interval(mins=>$4::integer) THEN 0
    WHEN c.impact='high' THEN 1 ELSE 2 END AS rank,
   COALESCE(c.deadline,'infinity'::timestamptz) AS deadline_key
  FROM (SELECT * FROM cases UNION ALL SELECT * FROM external) c
  LEFT JOIN decision_assignments a ON a.tenant_id=$1 AND a.decision_id=c.id
  WHERE $14::text IS NULL OR c.id=$14),
 in_view AS (SELECT * FROM ranked WHERE $5='all' OR ($5='mine' AND assignee_id=$6::uuid)
  OR ($5='unassigned' AND assignee_id IS NULL)),
 filtered AS (SELECT * FROM in_view WHERE ($7::text IS NULL OR domain=$7) AND ($8::text IS NULL OR reason=$8)),
 page AS (SELECT * FROM filtered
  WHERE $9::integer IS NULL OR (rank,deadline_key,requested_at,id)>($9,$10::timestamptz,$11::timestamptz,$12::text)
  ORDER BY rank,deadline_key,requested_at,id LIMIT $13)
 SELECT (SELECT count(*)::integer FROM filtered) AS total_count,
  (SELECT count(*)::integer FROM filtered WHERE $9::integer IS NOT NULL
   AND (rank,deadline_key,requested_at,id)<=($9,$10::timestamptz,$11::timestamptz,$12::text)) AS offset,
  (SELECT jsonb_build_object('all',count(*),'mine',count(*) FILTER (WHERE assignee_id=$6::uuid),
   'unassigned',count(*) FILTER (WHERE assignee_id IS NULL)) FROM ranked) AS views,
  (SELECT COALESCE(jsonb_object_agg(domain,n),'{}'::jsonb) FROM (SELECT domain,count(*) AS n FROM in_view
   WHERE $8::text IS NULL OR reason=$8 GROUP BY domain) d) AS domains,
  (SELECT COALESCE(jsonb_object_agg(reason,n),'{}'::jsonb) FROM (SELECT reason,count(*) AS n FROM in_view
   WHERE $7::text IS NULL OR domain=$7 GROUP BY reason) r) AS reasons,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'rank',p.rank,'deadlineKey',p.deadline_key,
   'requestedAt',p.requested_at,'facts',p.facts,
   'assignment',CASE WHEN p.revision IS NULL THEN NULL ELSE jsonb_build_object('assigneeId',p.assignee_id,
    'assignedBy',p.assigned_by,'assignedAt',p.assigned_at,'revision',p.revision) END,
   'record',CASE WHEN p.record_kind IS NOT NULL AND COALESCE(p.record_id,mapped.id::text) IS NOT NULL
    THEN jsonb_build_object('kind',p.record_kind,'id',COALESCE(p.record_id,mapped.id::text)) END)
   ORDER BY p.rank,p.deadline_key,p.requested_at,p.id)
   FROM page p
   LEFT JOIN LATERAL (SELECT m.canonical_id AS id FROM connector_source_mappings m
    WHERE p.record_id IS NULL AND m.tenant_id=$1 AND m.resource=p.record_kind AND m.external_id=p.record_external
    AND m.connection_id::text=p.record_connection AND m.scope_key='' ORDER BY m.canonical_id LIMIT 1) mapped ON true),
  '[]'::jsonb) AS items`;
}

const encode = (cursor: Cursor) =>
  Buffer.from(JSON.stringify(cursor)).toString('base64url');

function decode(value: string, context: string): Cursor {
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error('Encoding');
    const cursor = cursorSchema.parse(JSON.parse(bytes.toString()));
    if (cursor.context !== context) throw new Error('Context');

    return cursor;
  } catch {
    throw Object.assign(
      new Error(
        'This page link no longer matches the Needs you filters. Start from the first page.',
      ),
      { statusCode: 400, expose: true },
    );
  }
}

/**
 * Creates the Needs you queue over the exceptions owner's case attention rules and the owners'
 * decision providers. Reads run in one repeatable-read snapshot under tenant row security;
 * providers answer for the refreshed reader before it starts. A failing provider is reported
 * as unavailable instead of failing the whole queue.
 */
export function createDecisionQueue(
  db: TenantDatabase,
  deps: {
    /** The exceptions owner's `caseDecisionQuery`. */
    cases: string;
    providers: readonly DecisionProvider[];
    refreshContext(context: TenantContext): Promise<TenantContext>;
    now?: () => Date;
  },
): DecisionQueue {
  const sql = queueSql(deps.cases);
  const now = deps.now ?? (() => new Date());

  async function read(
    context: TenantContext,
    query: DecisionQuery,
    only: string | null,
  ): Promise<DecisionList> {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Sign in again to continue.');
    const scope = createHash('sha256')
      .update(
        JSON.stringify([
          'decisions-v1',
          fresh.tenantId,
          fresh.actor.id,
          query.view,
          query.domain ?? null,
          query.reason ?? null,
          query.limit,
        ]),
      )
      .digest('hex');
    const cursor = query.cursor ? decode(query.cursor, scope) : null;
    // Keep one ranking time across pages so expiring items don't move between them.
    const asOf = cursor?.asOf ?? now().toISOString();

    const answers = await Promise.allSettled(
      deps.providers.map((provider) => provider.pending(fresh)),
    );
    const external = new Map<string, DecisionCandidate>();
    answers.forEach((answer) => {
      if (answer.status === 'fulfilled')
        for (const item of answer.value) external.set(item.id, item);
    });
    const rows = [...external.values()].map((item) => ({
      id: item.id,
      reason: item.reason,
      domain: item.domain,
      impact: item.impact.level,
      requested_at: item.requestedAt,
      deadline: item.deadline,
      record_kind: item.record?.kind ?? null,
      record_id: item.record && 'id' in item.record ? item.record.id : null,
      record_connection:
        item.record && 'source' in item.record
          ? item.record.source.connectionId
          : null,
      record_external:
        item.record && 'source' in item.record
          ? item.record.source.externalId
          : null,
    }));

    const result = await db.transaction(
      fresh.tenantId,
      async (tx) => {
        await tx.query("SET LOCAL statement_timeout = '4000ms'");
        await tx.query('SET LOCAL jit = off');

        return (
          await tx.query<{
            total_count: number;
            offset: number;
            views: Record<string, number>;
            domains: Record<string, number>;
            reasons: Record<string, number>;
            items: PageRow[];
          }>(sql, [
            fresh.tenantId,
            asOf,
            JSON.stringify(rows),
            expiringWindowMinutes,
            query.view,
            fresh.actor.id,
            query.domain ?? null,
            query.reason ?? null,
            cursor?.rank ?? null,
            cursor?.deadline ?? null,
            cursor?.requestedAt ?? null,
            cursor?.id ?? null,
            query.limit + 1,
            only,
          ])
        ).rows[0]!;
      },
      { readOnlySnapshot: true },
    );

    const reader = { id: fresh.actor.id, role: fresh.actor.role };
    const page = result.items.slice(0, query.limit);
    const items = page.flatMap((row): DecisionItem[] => {
      const candidate = row.facts
        ? presentCase(row.facts, reader, asOf)
        : external.get(row.id);
      if (!candidate) return [];

      return [
        {
          ...candidate,
          urgency: urgencies[row.rank],
          evidence: {
            ...candidate.evidence,
            state: evidenceState(candidate.evidence.validUntil, asOf),
          },
          assignment: row.assignment,
          record: row.record,
        },
      ];
    });
    const last = page.at(-1);

    return {
      schemaVersion: 1,
      asOf,
      items,
      nextCursor:
        result.items.length > query.limit && last
          ? encode({
              context: scope,
              asOf,
              rank: last.rank,
              deadline: last.deadlineKey,
              requestedAt: last.requestedAt,
              id: last.id,
            })
          : null,
      totalCount: result.total_count,
      offset: result.offset,
      counts: {
        views: { ...emptyCounts(views), ...result.views },
        domains: { ...emptyCounts(domains), ...result.domains },
        reasons: { ...emptyCounts(reasons), ...result.reasons },
      },
      sources: [
        { id: 'cases', label: 'Issues', state: 'available' },
        ...deps.providers.map((provider, index) => ({
          id: provider.id,
          label: provider.label,
          state:
            answers[index]!.status === 'fulfilled'
              ? ('available' as const)
              : ('unavailable' as const),
        })),
      ],
    };
  }

  return {
    list: (context, query) => read(context, query, query.id ?? null),
    async find(context, id) {
      const result = await read(context, { view: 'all', limit: 1 }, id);

      return result.items[0] ?? null;
    },
  };
}
