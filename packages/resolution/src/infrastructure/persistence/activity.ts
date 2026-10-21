import { createHash } from 'node:crypto';

import { hasPermission } from '@luma/identity';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import type { ActivityStore } from '../../application/activity.js';
import type {
  ActivityCounts,
  ActivityEvent,
  ActivityQuery,
} from '../../domain/activity.js';
import {
  activityAttentionOutcomes,
  activityOutcomeRules,
} from '../../domain/activity-outcome.js';
import { actorSql, personSql, uuidPattern } from './actors.js';

const coverage =
  'Recorded decisions, execution, verification, issue resolutions and procurement changes. People who can view restricted activity also see connection changes and changes to members, invitations, roles and workspace settings. Older unrecorded changes and legacy playbook activation history are unavailable. Execution mode is shown only when recorded.';

// Only static domain rules enter this SQL expression; request values remain parameters.
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const outcomeSql =
  'CASE ' +
  activityOutcomeRules
    .map(
      (rule) =>
        `WHEN ${rule.field === 'action' ? 'action' : `details->>${literal(rule.field)}`} IN (${rule.values.map(literal).join(',')}) THEN ${literal(rule.outcome)}`,
    )
    .join(' ') +
  " ELSE 'recorded' END";

// Access events carry bounded role, member, invitation and API app values. Summaries name the
// role, setting or API app that changed, the app and route that read personal data, the member
// a support view showed, or the path it read;
// e-mail addresses, permission lists, invitation secrets and tokens stay out.
const accessRole = (value: string) =>
  `COALESCE(${value}->>'roleName',CASE WHEN jsonb_typeof(${value}->'role')='string' THEN ${value}->>'role' END)`;
const accessSummarySql = `CASE
  WHEN event_type='role.app_permissions_removed' THEN 'App '||(after_value->'cause'->>'appId')||' uninstalled'
  WHEN event_type LIKE 'role.%' THEN COALESCE(after_value->>'name',before_value->>'name')
  WHEN event_type='member.update' THEN NULLIF(concat_ws(' → ',${accessRole('before_value')},${accessRole('after_value')}),'')
  WHEN event_type LIKE 'member.%' OR event_type LIKE 'invitation.%' THEN COALESCE(${accessRole('after_value')},${accessRole('before_value')})
  WHEN event_type='policy.updated' THEN CASE after_value->>'required' WHEN 'true' THEN 'Approval always required' WHEN 'false' THEN 'Approval follows the workspace policy' END
  WHEN event_type='workspace.updated' THEN after_value->>'name'
  WHEN event_type='api_app.personal_data_read' THEN concat_ws(' · ',after_value->>'name',after_value->>'path')
  WHEN event_type LIKE 'api_app.%' THEN COALESCE(after_value->>'name',before_value->>'name')
  WHEN event_type='support_view.read' THEN after_value->>'path'
  WHEN event_type LIKE 'support_view.%' THEN subject.subject_name
END`;

/**
 * Keeps events whose built actor matches the actor filter: a person by user ID ($16, null
 * without a filter), Luma and Luma support ($17) or any workflow run ($18). It reads the
 * response actor, so it agrees with what the row shows, and it only narrows rows that the
 * visibility rules already admitted.
 */
const actorMatchSql = (item: string) =>
  `($16::text[] IS NULL OR (${item}->'actor'->>'kind' IN ('member','former_member') AND ${item}->'actor'->>'id'=ANY($16::text[]))
    OR ($17::boolean AND (${item}->'actor'->>'kind' IN ('luma','support') OR jsonb_typeof(${item}->'actor'->'workflow')='object'))
    OR ($18::boolean AND jsonb_typeof(${item}->'actor'->'workflow')='object'))`;

/**
 * Restricted access events from `workspace_access_events`, read through the index on
 * (tenant_id, created_at DESC, id DESC). They have no issue, connection or order subject, so
 * system, connection and subject filters exclude them.
 */
const accessEventsSql = `SELECT * FROM (SELECT x.created_at AS sort_at,x.sort_id,
      to_char(x.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
      jsonb_build_object('id',x.sort_id,'recordedAt',to_char(x.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'occurredAt',to_char(x.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'actor',${actorSql({ row: 'x', kind: "'user'", id: 'x.actor_id::text', luma: 'false', workflow: 'NULL', support: "x.actor_kind='staff'" })},
      'action',left(x.event_type,160),'type','access','outcome','recorded','exceptionId',NULL,'proposalId',NULL,
      'attemptId',NULL,'connectionId',NULL,'connections','[]'::jsonb,'system',NULL,'resource',left(x.target_id,300),
      'playbookId',NULL,'mode','unrecorded','executionState',NULL,'verificationPhase',NULL,'failureCode',NULL,
      'summary',left(x.summary,300),'dispatch',NULL,'verification',NULL,'evidenceRefs','[]'::jsonb) AS item
      FROM (
        SELECT e.id,e.created_at,e.actor_id,e.actor_kind,e.event_type,e.target_id,'access:'||e.id::text AS sort_id,${accessSummarySql} AS summary,
        person.actor_name,person.actor_email,person.actor_member
        FROM workspace_access_events e
        ${personSql('person', 'e.tenant_id', 'e.actor_id::text')}
        LEFT JOIN LATERAL (SELECT name AS subject_name FROM workspace_people WHERE tenant_id=e.tenant_id
          AND e.event_type LIKE 'support_view.%'
          AND user_id=CASE WHEN e.after_value->>'userId' ~ ${uuidPattern} THEN (e.after_value->>'userId')::uuid END) subject ON true
        WHERE $4::boolean AND e.tenant_id=$1 AND e.created_at>=$2::timestamptz AND e.created_at<$3::timestamptz
        AND $7::text IS NULL AND $8::uuid IS NULL AND $13::text[] IS NULL
        AND ($9::text IS NULL OR $9::text='access') AND ($10::text[] IS NULL OR 'recorded'=ANY($10::text[]))
        AND ($5::timestamptz IS NULL OR (e.created_at<=$5::timestamptz AND (e.created_at,'access:'||e.id::text)<($5::timestamptz,$6::text)))
      ) x
      WHERE ($11::text='' OR position(lower($11) in lower(concat_ws(' ',x.event_type,x.target_id,x.actor_id::text,x.actor_name,x.actor_email,x.summary)))>0)
      ) a WHERE ${actorMatchSql('a.item')}
      ORDER BY a.sort_at DESC,a.sort_id DESC LIMIT $12`;

// The subject filter compares against uuid::text, which is always lowercase and hyphenated,
// so only canonical UUID strings can match an issue, run or proposal ID.
const canonicalUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuids = (values: string[]) =>
  values.filter((value) => canonicalUuid.test(value));

// Subject reads scan only source rows whose exception or proposal can pass the final subject
// filter. Plain columns keep both arms index-backed under row-level security; the second arm
// skips rows the first arm already returned.
const linkedSources = `(SELECT * FROM workspace_activity_sources WHERE exception_id=ANY($21::uuid[])
  UNION ALL SELECT * FROM workspace_activity_sources
  WHERE proposal_id=ANY($22::uuid[]) AND (exception_id=ANY($21::uuid[])) IS NOT TRUE)`;

/**
 * Lists every exception and proposal ID through which a source row can reach the subject
 * filter: the given issues and runs, order-subject issues, proposals and runs of those issues,
 * proposals, runs and admission steps targeting the order, admission steps of the runs, and
 * proposals of audit or execution events correlated with a trigger run in the time window.
 * The result may include unrelated IDs; the final subject filter stays the exact check.
 * Each branch filters one plain or generated column, so every lookup stays index-backed under
 * row-level security; an OR across them, or a JSON expression, would scan the tenant's rows.
 */
async function readLinkedKeys(
  tx: SqlTransaction,
  tenantId: string,
  query: ActivityQuery,
  subjects: NonNullable<ActivityQuery['subjects']>,
) {
  const result = await tx.query<{ issueIds: string[]; proposalIds: string[] }>(
    `WITH issues AS (
      SELECT unnest($2::uuid[]) AS id
      UNION SELECT id FROM exceptions WHERE tenant_id=$1 AND subject_kind='order' AND subject_id=ANY($4)
    ), trigger_runs AS (
      SELECT id::text FROM workflow_trigger_runs WHERE tenant_id=$1 AND id=ANY($3::uuid[])
    ), proposals AS (
      SELECT unnest($3::uuid[]) AS id
      UNION SELECT id FROM case_proposals WHERE tenant_id=$1 AND exception_id IN (SELECT id FROM issues)
      UNION SELECT id FROM case_proposals WHERE tenant_id=$1 AND target_kind='order' AND target_id=ANY($4)
      UNION SELECT id FROM playbook_runs WHERE tenant_id=$1 AND incident_id=ANY($2::uuid[]::text[])
      UNION SELECT id FROM playbook_runs WHERE tenant_id=$1 AND target_kind='order' AND target_id=ANY($4)
      UNION SELECT proposal_id FROM action_admission_steps WHERE tenant_id=$1 AND run_id=ANY($3::uuid[])
      UNION SELECT proposal_id FROM action_admission_steps WHERE tenant_id=$1 AND target_kind='order' AND target_id=ANY($4)
      UNION SELECT proposal_id FROM action_admission_steps WHERE tenant_id=$1 AND subject_kind='order' AND subject_id=ANY($4)
      UNION SELECT proposal_id FROM audit_entries WHERE tenant_id=$1 AND EXISTS(SELECT 1 FROM trigger_runs)
       AND created_at>=$5::timestamptz AND created_at<$6::timestamptz
       AND document->>'correlationId' IN (SELECT id FROM trigger_runs)
      UNION SELECT proposal_id FROM execution_outbox WHERE tenant_id=$1 AND EXISTS(SELECT 1 FROM trigger_runs)
       AND created_at>=$5::timestamptz AND created_at<$6::timestamptz
       AND document->>'correlationId' IN (SELECT id FROM trigger_runs)
    )
    SELECT ARRAY(SELECT id::text FROM issues) AS "issueIds",ARRAY(SELECT id::text FROM proposals) AS "proposalIds"`,
    [
      tenantId,
      uuids(subjects.issueIds),
      uuids(subjects.runIds),
      subjects.orderRefs,
      query.from,
      query.to,
    ],
  );

  return result.rows[0]!;
}

/** What one read of the activity events returns. */
type ActivityRead =
  | { kind: 'page'; after: { at: string; id: string } | null }
  | { kind: 'event'; id: string }
  | { kind: 'counts' };

/** The steps of the selected group, oldest first, when the reader asked for them. */
const itemSql = (query: ActivityQuery) =>
  `CASE WHEN $19::boolean AND ${query.detail === 'steps' ? 'true' : 'false'} THEN item || jsonb_build_object('steps',
        COALESCE((SELECT jsonb_agg(step.item ORDER BY step.sort_at,step.sort_id) FROM
          (SELECT e.item,e.sort_at,e.sort_id FROM events e WHERE e.group_key=ranked.group_key AND e.sort_id<>ranked.sort_id ORDER BY e.sort_at DESC,e.sort_id DESC LIMIT 100) step),'[]'::jsonb)) ELSE item END`;

// Each read ends differently: a page after the cursor, the group holding one event, or the
// number of groups per outcome. Groups only list when one of their events is meaningful. A
// lookup or count passes its value as the last parameter.
const finalSql = (query: ActivityQuery, read: ActivityRead, last: number) =>
  read.kind === 'page'
    ? `SELECT at, ${itemSql(query)} AS item
      FROM ranked WHERE position=1 AND meaningful AND ($5::timestamptz IS NULL OR (sort_at,sort_id)<($5::timestamptz,$6::text))
      ORDER BY sort_at DESC,sort_id DESC LIMIT $12`
    : read.kind === 'event'
      ? `SELECT at, ${itemSql(query)} AS item
      FROM ranked WHERE position=1 AND meaningful AND group_key IN (SELECT group_key FROM events WHERE sort_id=$${last}::text) LIMIT 1`
      : `SELECT
        (SELECT count(DISTINCT group_key) FROM events WHERE meaningful)::int AS total,
        (SELECT count(DISTINCT group_key) FROM events WHERE meaningful AND item->>'outcome'=ANY($${last}::text[]))::int AS attention,
        COALESCE((SELECT jsonb_object_agg(outcome,groups) FROM (SELECT item->>'outcome' AS outcome,count(DISTINCT group_key)::int AS groups
          FROM events WHERE meaningful GROUP BY 1) c),'{}'::jsonb) AS outcomes`;

/** Most rows one read may consider: an export, or the access events a count or lookup scans. */
const readCap = 100_000;

/**
 * Reads activity events under the reader's visibility and filters. Pages read one more event than
 * asked, so the caller knows whether another page follows; lookups and counts consider every
 * event in the date range.
 */
async function readActivity<Row extends Record<string, unknown>>(
  tx: SqlTransaction,
  context: Parameters<ActivityStore['list']>[0],
  query: ActivityQuery,
  read: ActivityRead,
) {
  const restricted = hasPermission(context, 'activity.read_restricted');
  const outcomes = query.outcome?.length
    ? [...new Set(query.outcome)].sort()
    : null;
  const linked = query.subjects
    ? await readLinkedKeys(tx, context.tenantId, query, query.subjects)
    : null;
  const actors = query.actor
    ? {
        people: query.actor.filter(
          (value) => value !== 'luma' && value !== 'workflow',
        ),
        luma: query.actor.includes('luma'),
        workflows: query.actor.includes('workflow'),
      }
    : null;
  const after = read.kind === 'page' ? read.after : null;

  return tx.query<Row>(
    `
      WITH enriched AS (
        SELECT s.*,COALESCE(eo.document->'automation',eo.document->'resolution'->'automation') AS actor_automation,COALESCE(s.exception_id,p.exception_id,(r.document->>'incidentId')::uuid) AS issue_id,
        COALESCE(s.connection_id,(s.doc->>'connectionId')::uuid,(p.document->>'connectionId')::uuid,(r.document->'action'->>'connectionId')::uuid) AS conn_id,
        COALESCE(s.doc->'details'->>'purchaseOrderId',CASE WHEN a.subject_kind='order' THEN a.subject_id END,p.document->'target'->>'id',r.document->'action'->'target'->>'id',a.document->'action'->'target'->>'id',e.document->'subject'->>'subjectId') AS resource,
        COALESCE(CASE WHEN s.doc->'details'->>'purchaseOrderId' IS NOT NULL THEN 'purchase_order' END,CASE WHEN a.subject_kind='order' THEN 'order' END,p.document->'target'->>'kind',r.document->'action'->'target'->>'kind',a.document->'action'->'target'->>'kind',e.document->'subject'->>'subjectKind') AS resource_kind,
        COALESCE(CASE WHEN s.doc->>'eventType' LIKE 'purchase_order.%' THEN s.doc->'details'->>'reason'
          -- Erasure counts only; the entry never holds the customer's identifiers.
          WHEN s.doc->>'eventType'='customers.erased' THEN concat_ws(',',s.doc->'details'->>'profiles',s.doc->'details'->>'messages',s.doc->'details'->>'threads',s.doc->'details'->>'replies',s.doc->'details'->>'rules') END,p.document->>'capability',r.document->'action'->>'capability',a.document->'action'->>'capability') AS summary,
        CASE WHEN e.document->'subject'->>'subjectKind'='connection' THEN e.document->'subject'->>'subjectId' END AS subject_connection,
        COALESCE(r.definition_id,w.definition_id,s.doc->'details'->>'definitionId') AS playbook_id,COALESCE(v.document->'provenance'->>'kind',wv.document->'provenance'->>'kind') AS mode,
        COALESCE(s.doc->>'eventType','case.updated') AS action,
        w.id::text AS workflow_run_id,
        CASE WHEN r.id IS NOT NULL OR w.id IS NOT NULL THEN COALESCE(r.definition_id,w.definition_id) END AS workflow_id,
        COALESCE(v.document->'definition'->>'name',wv.document->'definition'->>'name') AS workflow_name,
        s.doc->'details' AS details,
        e.document->>'exceptionClass' AS issue_class
        FROM ${linked ? linkedSources : 'workspace_activity_sources'} s
        LEFT JOIN exception_outbox eo ON eo.tenant_id=s.tenant_id AND eo.id::text=s.id AND s.doc->>'eventType' LIKE 'exception.%'
        LEFT JOIN case_proposals p ON p.tenant_id=s.tenant_id AND p.id=s.proposal_id
        LEFT JOIN exceptions e ON e.tenant_id=s.tenant_id AND e.id=COALESCE(s.exception_id,p.exception_id)
        LEFT JOIN playbook_runs r ON r.tenant_id=s.tenant_id AND r.id=s.proposal_id
        LEFT JOIN playbook_versions v ON v.tenant_id=r.tenant_id AND v.definition_id=r.definition_id AND v.version=r.version
        LEFT JOIN action_admission_steps a ON a.tenant_id=s.tenant_id AND a.proposal_id=s.proposal_id
        LEFT JOIN workflow_trigger_runs w ON w.tenant_id=s.tenant_id AND w.id::text=COALESCE(a.run_id::text,s.doc->>'correlationId',COALESCE(eo.document->'automation'->>'id',eo.document->'resolution'->'automation'->>'id'))
        LEFT JOIN playbook_versions wv ON wv.tenant_id=w.tenant_id AND wv.definition_id=w.definition_id AND wv.version=w.version
        WHERE s.tenant_id=$1 AND s.recorded_at >= $2::timestamptz AND s.recorded_at < $3::timestamptz
        AND (NOT s.restricted OR $4::boolean)

      ), classified AS (
        SELECT e.*,connections.items AS connections,
        person.actor_name,person.actor_email,person.actor_member,
        connections.items->0->>'system' AS system,
        CASE WHEN action LIKE 'purchase_order.%' THEN 'procurement'
          WHEN action LIKE 'customers.%' THEN 'privacy'
          WHEN action LIKE 'connection.%' THEN 'connection'
          WHEN details->>'resolution' IS NOT NULL THEN 'resolution'
          WHEN action LIKE '%verification%' OR details->>'verification' IS NOT NULL THEN 'verification'
          WHEN action LIKE 'execution.%' THEN 'execution'
          WHEN action LIKE 'workflow.%' OR action LIKE 'policy.%' OR action IN ('case.approve','case.reject','case.escalate') THEN 'decision'
          ELSE 'issue' END AS type,
        ${outcomeSql} AS outcome
        FROM enriched e
        LEFT JOIN LATERAL (
          SELECT COALESCE(jsonb_agg(jsonb_build_object('id',c.id,'system',c.document->'target'->>'kind') ORDER BY c.id),'[]'::jsonb) AS items
          FROM connector_installations c
          WHERE c.tenant_id=e.tenant_id AND c.id IN (
            SELECT e.conn_id WHERE e.conn_id IS NOT NULL
            UNION SELECT e.subject_connection::uuid WHERE e.conn_id IS NULL AND e.subject_connection IS NOT NULL
            UNION
            SELECT (source.document->>'connectionId')::uuid
            FROM exception_evidence ev JOIN exception_sources source ON source.tenant_id=ev.tenant_id AND source.evidence_key=ev.evidence_key
            WHERE e.conn_id IS NULL AND ev.tenant_id=e.tenant_id AND ev.exception_id=e.issue_id
            UNION
            SELECT (p.document->>'connectionId')::uuid FROM case_proposals p
            WHERE e.conn_id IS NULL AND p.tenant_id=e.tenant_id AND p.exception_id=e.issue_id
          )
        ) connections ON true
        ${personSql('person', 'e.tenant_id', "CASE WHEN e.doc->'actor'->>'kind'='user' THEN e.doc->'actor'->>'id' END")}
      ), operational AS (
      SELECT * FROM (SELECT recorded_at AS sort_at,id AS sort_id,to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
      jsonb_build_object('id',id,'recordedAt',to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'occurredAt',to_char((doc->>'occurredAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'actor',${actorSql(
        {
          row: 'classified',
          kind: "doc->'actor'->>'kind'",
          id: "doc->'actor'->>'id'",
          luma: "action LIKE 'exception.%'",
          workflow: `CASE WHEN action IN ('approval.responded','case.approve','case.reject','workflow.human_task_answered') THEN NULL WHEN workflow_id IS NOT NULL THEN jsonb_build_object('id',left(workflow_id,200),'name',left(workflow_name,200)) ELSE actor_automation END`,
        },
      )},
      'action',left(action,160),'type',type,'outcome',outcome,'exceptionId',issue_id,'proposalId',proposal_id,
      'attemptId',doc->>'attemptId','connectionId',COALESCE(conn_id,(connections->0->>'id')::uuid),'connections',COALESCE((SELECT jsonb_agg(value) FROM (SELECT value FROM jsonb_array_elements(connections) LIMIT 100) bounded),'[]'::jsonb),'system',left(system,100),'resource',left(resource,300),
      'workflowRunId',workflow_run_id,'resourceKind',resource_kind,'issueClass',left(issue_class,100),'playbookId',left(playbook_id,200),'mode',CASE WHEN mode IN ('simulation','shadow','pilot') THEN mode ELSE 'unrecorded' END,
      'executionState',left(details->>'state',100),'verificationPhase',left(details->>'phase',40),'failureCode',left(details->>'failureCode',100),'summary',left(summary,300),'dispatch',left(details->>'dispatch',100),'verification',left(details->>'verification',100),
      'evidenceRefs',COALESCE((SELECT jsonb_agg(left(ref,500)) FROM (SELECT value #>> '{}' AS ref FROM jsonb_array_elements(CASE WHEN jsonb_typeof(doc->'evidenceRefs')='array' THEN doc->'evidenceRefs' ELSE '[]'::jsonb END) WHERE jsonb_typeof(value)='string' LIMIT 100) refs),'[]'::jsonb)) AS item
      FROM classified WHERE ($7::text IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(connections) c WHERE c->>'system'=$7)) AND ($8::uuid IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(connections) c WHERE c->>'id'=$8::text))
      AND ($9::text IS NULL OR type=$9) AND ($10::text[] IS NULL OR outcome=ANY($10::text[]))
      AND ($11::text='' OR position(lower($11) in lower(concat_ws(' ',issue_id::text,resource,action,doc->'actor'->>'id',actor_name,actor_email,workflow_name,workflow_run_id,replace(issue_class,'_',' '))))>0
        OR issue_class=ANY($20::text[]))
      AND ($13::text[] IS NULL OR issue_id::text=ANY($13) OR workflow_run_id=ANY($14) OR proposal_id::text=ANY($14)
        OR (resource_kind='order' AND resource=ANY($15)))
      ) o WHERE ${actorMatchSql('o.item')}
      ), access AS (${accessEventsSql}), events AS (
        SELECT *, CASE WHEN $19::boolean THEN COALESCE(item->>'exceptionId',item->>'workflowRunId',item->>'proposalId',sort_id) ELSE sort_id END AS group_key,
          NOT $19::boolean OR ((item->>'action' NOT IN ('workflow.step_recorded','policy.evaluated','execution.verification_pending','exception.verification_attempt') OR (item->>'action'='policy.evaluated' AND item->>'outcome'='failed')) AND item->>'verificationPhase' IS DISTINCT FROM 'pending') AS meaningful
        FROM (SELECT * FROM operational UNION ALL SELECT * FROM access) all_events
      ), ranked AS (
        SELECT *, row_number() OVER (PARTITION BY group_key ORDER BY meaningful DESC,sort_at DESC,sort_id DESC) AS position FROM events
      )
      ${finalSql(query, read, linked ? 23 : 21)}`,
    [
      context.tenantId,
      query.from,
      query.to,
      restricted,
      after?.at ?? null,
      after?.id ?? null,
      query.system ?? null,
      query.connectionId ?? null,
      query.type ?? null,
      outcomes,
      query.q ?? '',
      read.kind === 'page' ? query.limit + 1 : readCap,
      query.subjects?.issueIds ?? null,
      query.subjects?.runIds ?? [],
      query.subjects?.orderRefs ?? [],
      actors ? actors.people : null,
      actors?.luma ?? false,
      actors?.workflows ?? false,
      read.kind === 'counts' || query.view === 'business',
      query.searchIssueClasses?.length ? [...query.searchIssueClasses] : [],
      ...(linked ? [linked.issueIds, linked.proposalIds] : []),
      ...(read.kind === 'event'
        ? [read.id]
        : read.kind === 'counts'
          ? [[...activityAttentionOutcomes]]
          : []),
    ],
  );
}

/** Reads canonical durable events without per-issue queries or raw payload exposure. */
export function createActivityStore(db: TenantDatabase): ActivityStore {
  return {
    list: (context, query) =>
      db.transaction(context.tenantId, async (tx) => {
        // Cursors bind to the visibility they were minted with, so a page link stops working
        // once restricted access is removed.
        const restricted = hasPermission(context, 'activity.read_restricted');
        // Sorted and deduplicated, so the same outcomes in another order share cursors.
        const outcomes = query.outcome?.length
          ? [...new Set(query.outcome)].sort()
          : null;
        const key = createHash('sha256')
          .update(
            JSON.stringify([
              'activity-v9',
              query.view ?? 'events',
              query.detail ?? 'summary',
              context.tenantId,
              restricted,
              query.from,
              query.to,
              query.q ?? '',
              query.searchIssueClasses ?? null,
              query.system ?? '',
              query.connectionId ?? '',
              query.type ?? '',
              outcomes,
              query.actor ?? null,
              query.limit,
              query.subjects ?? null,
            ]),
          )
          .digest('hex');
        let after: { at: string; id: string } | null = null;
        if (query.cursor) {
          try {
            const bytes = Buffer.from(query.cursor, 'base64url');
            if (bytes.toString('base64url') !== query.cursor)
              throw new Error('Encoding');
            const value = z
              .object({
                context: z.string(),
                at: z.string().datetime(),
                id: z.string().min(1).max(200),
              })
              .strict()
              .parse(JSON.parse(bytes.toString()));
            if (value.context !== key) throw new Error('Context');
            after = value;
          } catch {
            throw Object.assign(
              new Error(
                'This page link no longer matches the activity filters. Start from the first page.',
              ),
              { statusCode: 400, expose: true },
            );
          }
        }
        if (query.event) {
          const found = await readActivity<{ item: ActivityEvent; at: string }>(
            tx,
            context,
            query,
            { kind: 'event', id: query.event },
          );

          return {
            visibility: restricted ? 'admin' : 'member',
            items: found.rows.map((row) => row.item),
            coverage,
            nextCursor: null,
          };
        }
        const result = await readActivity<{ item: ActivityEvent; at: string }>(
          tx,
          context,
          query,
          { kind: 'page', after },
        );
        const rows = result.rows.slice(0, query.limit);
        const last = rows.at(-1);

        return {
          visibility: restricted ? 'admin' : 'member',
          items: rows.map((r) => r.item),
          coverage,
          nextCursor:
            result.rows.length > query.limit && last
              ? Buffer.from(
                  JSON.stringify({
                    context: key,
                    at: last.at,
                    id: last.item.id,
                  }),
                ).toString('base64url')
              : null,
        };
      }),
    counts: (context, query) =>
      db.transaction(context.tenantId, async (tx) => {
        const result = await readActivity<ActivityCounts>(
          tx,
          context,
          { ...query, outcome: undefined, event: undefined },
          { kind: 'counts' },
        );
        const row = result.rows[0];

        return {
          total: row?.total ?? 0,
          attention: row?.attention ?? 0,
          outcomes: row?.outcomes ?? {},
        };
      }),
  };
}
