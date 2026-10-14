import { createHash } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import { hasPermission, IdentityError, requireTenant } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import { canReadRecord } from '../../application/access.js';
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
  type DecisionReader,
  evidenceState,
  expiringWindowMinutes,
  presentCase,
  urgencies,
} from '../../domain/decisions.js';
import { createActionDiffReader } from '../action-diffs.js';
import { collectionQueryError } from '../collection/parameters.js';
import {
  compareKeys,
  decisionGroupKey,
  decisionKeys,
  filterDecisions,
  groupDecisions,
  type RankedDecision,
} from './list.js';

const cursorSchema = z
  .object({
    context: z.string(),
    asOf: z.string().datetime({ offset: true }),
    keys: z.array(z.union([z.string().max(200), z.number()])).max(6),
  })
  .strict();

type Cursor = z.infer<typeof cursorSchema>;

type QueueRow = {
  id: string;
  rank: 0 | 1 | 2;
  deadlineKey: string;
  requestedAt: string;
  facts: CaseDecisionFacts | null;
  assignment: DecisionItem['assignment'];
  /** The record lookup columns; `kind` is null when the decision affects no record. */
  record: {
    kind: string | null;
    id: string | null;
    connection: string | null;
    external: string | null;
  };
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
// $4 expiring window minutes, $5 view, $6 reader, $7 domain, $8 reason, $9 one item ID, $10 whether
// the reader may read issues. Returns every decision of the view; the queue is bounded to work
// waiting on a person, and conditions, search, sorting and paging run on the presented items.
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
   to_jsonb(c) AS facts,
   CASE WHEN to_jsonb(c)->'owner'->>'userId' IS NOT NULL THEN jsonb_build_object('assigneeId',to_jsonb(c)->'owner'->'userId','assignedBy',to_jsonb(c)->'owner'->'assignedBy','assignedAt',to_jsonb(c)->'owner'->'assignedAt','revision',to_jsonb(c)->'owner'->'revision') END AS owner_assignment
  FROM case_rows c WHERE $10::boolean),
 external AS (
  SELECT x.id,x.reason,x.domain,x.impact,x.requested_at,x.deadline,x.record_kind,x.record_id,
   x.record_connection,x.record_external,NULL::jsonb AS facts,x.owner_assignment
  FROM jsonb_to_recordset($3::jsonb) AS x(id text,reason text,domain text,impact text,requested_at timestamptz,
   deadline timestamptz,record_kind text,record_id text,record_connection text,record_external text,owner_assignment jsonb)),
 ranked AS (
  SELECT c.*,CASE WHEN c.facts IS NOT NULL THEN (c.owner_assignment->>'assigneeId')::uuid ELSE COALESCE((c.owner_assignment->>'assigneeId')::uuid,a.assignee_id) END AS assignee_id,CASE WHEN c.facts IS NOT NULL THEN (c.owner_assignment->>'assignedBy')::uuid ELSE COALESCE((c.owner_assignment->>'assignedBy')::uuid,a.assigned_by) END AS assigned_by,CASE WHEN c.facts IS NOT NULL THEN (c.owner_assignment->>'assignedAt')::timestamptz ELSE COALESCE((c.owner_assignment->>'assignedAt')::timestamptz,a.assigned_at) END AS assigned_at,CASE WHEN c.facts IS NOT NULL THEN (c.owner_assignment->>'revision')::integer ELSE COALESCE((c.owner_assignment->>'revision')::integer,a.revision) END AS revision,
   CASE WHEN c.deadline IS NOT NULL AND c.deadline<=$2::timestamptz+make_interval(mins=>$4::integer) THEN 0
    WHEN c.impact='high' THEN 1 ELSE 2 END AS rank,
   COALESCE(c.deadline,'infinity'::timestamptz) AS deadline_key
  FROM (SELECT * FROM cases UNION ALL SELECT * FROM external) c
  LEFT JOIN decision_assignments a ON a.tenant_id=$1 AND a.decision_id=c.id
  WHERE $9::text IS NULL OR c.id=$9),
 in_view AS (SELECT * FROM ranked WHERE $5='all' OR ($5='mine' AND assignee_id=$6::uuid)
  OR ($5='unassigned' AND assignee_id IS NULL)),
 filtered AS (SELECT * FROM in_view WHERE ($7::text IS NULL OR domain=$7) AND ($8::text IS NULL OR reason=$8))
 SELECT (SELECT jsonb_build_object('all',count(*),'mine',count(*) FILTER (WHERE assignee_id=$6::uuid),
   'unassigned',count(*) FILTER (WHERE assignee_id IS NULL)) FROM ranked) AS views,
  (SELECT COALESCE(jsonb_object_agg(domain,n),'{}'::jsonb) FROM (SELECT domain,count(*) AS n FROM in_view
   WHERE $8::text IS NULL OR reason=$8 GROUP BY domain) d) AS domains,
  (SELECT COALESCE(jsonb_object_agg(reason,n),'{}'::jsonb) FROM (SELECT reason,count(*) AS n FROM in_view
   WHERE $7::text IS NULL OR domain=$7 GROUP BY reason) r) AS reasons,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'rank',p.rank,'deadlineKey',p.deadline_key,
   'requestedAt',p.requested_at,'facts',p.facts,
   'assignment',CASE WHEN p.revision IS NULL THEN NULL ELSE jsonb_build_object('assigneeId',p.assignee_id,
    'assignedBy',p.assigned_by,'assignedAt',p.assigned_at,'revision',p.revision) END,
   'record',jsonb_build_object('kind',p.record_kind,'id',p.record_id,'connection',p.record_connection,'external',p.record_external))
   ORDER BY p.rank,p.deadline_key,p.requested_at,p.id)
   FROM filtered p),
  '[]'::jsonb) AS items`;
}

// Resolves the canonical records of the decisions a page shows. Binds: $1 tenant, $2 rows.
const recordSql = `SELECT x.id,x.kind,COALESCE(x.record_id,mapped.id::text) AS record_id
 FROM jsonb_to_recordset($2::jsonb) AS x(id text,kind text,record_id text,connection text,external text)
 LEFT JOIN LATERAL (SELECT m.canonical_id AS id FROM connector_source_mappings m
  WHERE x.record_id IS NULL AND m.tenant_id=$1 AND m.resource=x.kind AND m.external_id=x.external
  AND m.connection_id::text=x.connection AND m.scope_key='' ORDER BY m.canonical_id LIMIT 1) mapped ON true
 WHERE x.kind IS NOT NULL`;

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

// Decisions whose diff compares against the evidence they were proposed on.
const diffObservedKinds = new Set<string>([
  'case',
  'replenishment',
  'inventory_correction',
  'fulfillment_recovery',
  'order_edit',
  'shipment_publication',
]);

/**
 * Creates the Needs you queue over the exceptions owner's case attention rules and the owners'
 * decision providers. Reads run in one repeatable-read snapshot under tenant row security;
 * providers answer for the refreshed reader before it starts. A failing provider is reported
 * as unavailable instead of failing the whole queue. Cases need `issues.read` and providers their
 * declared permission; otherwise they are skipped before ranking and counting.
 */
export function createDecisionQueue(
  db: TenantDatabase,
  deps: {
    /** The exceptions owner's `caseDecisionQuery`. */
    cases: string;
    providers: readonly DecisionProvider[];
    refreshContext(context: TenantContext): Promise<TenantContext>;
    /** Release only; owner read permissions still determine every included proposal. */
    diffEnabled?(tenantId: string): Promise<boolean>;
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
    if (query.groupKey !== undefined && !query.group)
      throw collectionQueryError('Choose a grouping to read one group.');
    if (query.group?.granularity)
      throw collectionQueryError('This field cannot be grouped');
    const groupOf = query.group
      ? decisionGroupKey(query.group.field)
      : undefined;
    const grouped = !!groupOf && query.groupKey === undefined;
    if (grouped && query.cursor)
      throw collectionQueryError(
        'Use a group’s page link together with its group key.',
      );
    const timeZone = query.timeZone ?? 'UTC';
    try {
      new Intl.DateTimeFormat('en', { timeZone });
    } catch {
      throw collectionQueryError(
        'Use an IANA time zone, such as Europe/Berlin.',
      );
    }
    const sort = query.sort ?? 'urgency';
    const direction = query.direction ?? 'asc';
    // A page link continues only the same reader's view, conditions, search, sort and grouping;
    // within one group it leaves out page sizes, so a group's first rows and pages may differ.
    const scope = (groupKey: DecisionQuery['groupKey']) =>
      createHash('sha256')
        .update(
          JSON.stringify([
            'decisions-v2',
            fresh.tenantId,
            fresh.actor.id,
            query.view,
            query.domain ?? null,
            query.reason ?? null,
            query.q?.trim() ?? '',
            query.where ?? null,
            query.group ?? null,
            timeZone,
            sort,
            direction,
            groupKey === undefined
              ? ['page', query.limit]
              : ['group', groupKey],
          ]),
        )
        .digest('hex');
    const cursor = query.cursor
      ? decode(query.cursor, scope(query.groupKey))
      : null;
    // Keep one ranking time across pages so expiring items don't move between them.
    const asOf = cursor?.asOf ?? now().toISOString();

    const reader: DecisionReader = {
      id: fresh.actor.id,
      can: (permission) => hasPermission(fresh, permission),
    };
    const readsCases = hasPermission(fresh, 'issues.read');
    // Owners whose area the reader can't read aren't asked, so their items and counts stay hidden.
    const providers = deps.providers.filter(
      (provider) =>
        !provider.permission || hasPermission(fresh, provider.permission),
    );
    const answers = await Promise.allSettled(
      providers.map((provider) => provider.pending(fresh)),
    );
    // Groups are incomplete while an owner's decisions are missing.
    const complete = answers.every((answer) => answer.status === 'fulfilled');
    const external = new Map<string, DecisionCandidate>();
    answers.forEach((answer) => {
      if (answer.status === 'fulfilled')
        for (const item of answer.value) external.set(item.id, item);
    });
    const rows = [...external.values()].map((item) => ({
      id: item.id,
      owner_assignment: item.ownerAssignment ?? null,
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

    return db.transaction(
      fresh.tenantId,
      async (tx) => {
        await tx.query("SET LOCAL statement_timeout = '4000ms'");
        await tx.query('SET LOCAL jit = off');
        const result = (
          await tx.query<{
            views: Record<string, number>;
            domains: Record<string, number>;
            reasons: Record<string, number>;
            items: QueueRow[];
          }>(sql, [
            fresh.tenantId,
            asOf,
            JSON.stringify(rows),
            expiringWindowMinutes,
            query.view,
            fresh.actor.id,
            query.domain ?? null,
            query.reason ?? null,
            only,
            readsCases,
          ])
        ).rows[0]!;

        const references = new Map<
          string,
          NonNullable<DecisionCandidate['actionReference']>
        >();
        const queue = result.items.flatMap(
          (row): (RankedDecision & { row: QueueRow })[] => {
            const candidate = row.facts
              ? presentCase(row.facts, reader, asOf)
              : external.get(row.id);
            if (!candidate) return [];
            const { actionReference, ...visible } = candidate;
            if (actionReference) references.set(row.id, actionReference);

            return [
              {
                row,
                rank: row.rank,
                deadlineKey: row.deadlineKey,
                item: {
                  ...visible,
                  urgency: urgencies[row.rank],
                  evidence: {
                    ...candidate.evidence,
                    state: evidenceState(candidate.evidence.validUntil, asOf),
                  },
                  assignment: row.assignment,
                  record: null,
                },
              },
            ];
          },
        );
        const matching = filterDecisions(queue, query.where, query.q, {
          readerId: fresh.actor.id,
          now: new Date(asOf),
          timeZone,
        });
        const keys = (decision: RankedDecision) => decisionKeys(decision, sort);
        const sorted = matching.sort((left, right) =>
          compareKeys(keys(left), keys(right), direction),
        );

        /** Presents decisions with the records the reader may open. */
        const present = async (shown: readonly (typeof queue)[number][]) => {
          const lookups = shown.flatMap(({ row }) =>
            row.record.kind
              ? [
                  {
                    id: row.id,
                    kind: row.record.kind,
                    record_id: row.record.id,
                    connection: row.record.connection,
                    external: row.record.external,
                  },
                ]
              : [],
          );
          const records = new Map(
            lookups.length
              ? (
                  await tx.query<{
                    id: string;
                    kind: NonNullable<DecisionItem['record']>['kind'];
                    record_id: string | null;
                  }>(recordSql, [fresh.tenantId, JSON.stringify(lookups)])
                ).rows.flatMap((record) =>
                  record.record_id
                    ? [[record.id, { kind: record.kind, id: record.record_id }]]
                    : [],
                )
              : [],
          );

          const items = shown.map(({ item }): DecisionItem => {
            const record = records.get(item.id);

            return {
              ...item,
              record:
                record && canReadRecord(fresh, record.kind) ? record : null,
            };
          });
          const reviewed = items.flatMap((item) => {
            const reference = references.get(item.id);

            return reference ? [{ item, reference }] : [];
          });
          if (reviewed.length && (await deps.diffEnabled?.(fresh.tenantId))) {
            const reviews = await createActionDiffReader(db)(
              fresh,
              reviewed.map(({ item, reference }) => ({
                id: item.id,
                reference,
                observedAt:
                  (item.owner.kind === 'workflow_run' &&
                    item.owner.followUpProposalId) ||
                  diffObservedKinds.has(item.kind)
                    ? item.evidence.observedAt
                    : null,
                canonical: item.record,
                ...(item.owner.kind === 'case'
                  ? {
                      evidenceLink: `/app/${fresh.tenantId}/exceptions/${item.owner.exceptionId}/detail`,
                    }
                  : {}),
              })),
            );
            for (const item of items) item.diff = reviews.get(item.id) ?? null;
          }

          return items;
        };
        const base = {
          schemaVersion: 1 as const,
          asOf,
          counts: {
            views: { ...emptyCounts(views), ...result.views },
            domains: { ...emptyCounts(domains), ...result.domains },
            reasons: { ...emptyCounts(reasons), ...result.reasons },
          },
          sources: [
            ...(readsCases
              ? [{ id: 'cases', label: 'Issues', state: 'available' as const }]
              : []),
            ...providers.map((provider, index) => ({
              id: provider.id,
              label: provider.label,
              state:
                answers[index]!.status === 'fulfilled'
                  ? ('available' as const)
                  : ('unavailable' as const),
            })),
          ],
        };

        if (grouped && query.group) {
          const grouping = groupDecisions(
            sorted,
            query.group.field,
            { domain: domains, reason: reasons },
            Math.min(Math.max(query.groupLimit ?? 10, 1), 50),
            complete,
            (key, last) =>
              encode({ context: scope(key), asOf, keys: keys(last) }),
          );
          const shown = new Set(grouping.shown.map(({ item }) => item.id));

          return {
            ...base,
            items: await present(
              sorted.filter(({ item }) => shown.has(item.id)),
            ),
            nextCursor: null,
            totalCount: matching.length,
            offset: 0,
            groups: grouping.groups,
            groupsTruncated: grouping.truncated,
          };
        }

        const members = groupOf
          ? sorted.filter(
              ({ item }) => groupOf(item) === (query.groupKey ?? null),
            )
          : sorted;
        const after = cursor
          ? members.filter(
              (decision) =>
                compareKeys(keys(decision), cursor.keys, direction) > 0,
            )
          : members;
        const page = after.slice(0, query.limit);
        const last = page.at(-1);
        const nextCursor =
          after.length > query.limit && last
            ? encode({
                context: scope(query.groupKey),
                asOf,
                keys: keys(last),
              })
            : null;
        const items = await present(page);

        return {
          ...base,
          items,
          nextCursor,
          totalCount: members.length,
          offset: members.length - after.length,
          ...(groupOf
            ? {
                groups: [
                  {
                    key: query.groupKey ?? null,
                    count: members.length,
                    complete,
                    itemIds: items.map((item) => item.id),
                    nextCursor,
                    sums: [],
                  },
                ],
              }
            : {}),
        };
      },
      { readOnlySnapshot: true },
    );
  }

  return {
    list: (context, query) => read(context, query, query.id ?? null),
    async find(context, id) {
      const result = await read(context, { view: 'all', limit: 1 }, id);

      return result.items[0] ?? null;
    },
  };
}
