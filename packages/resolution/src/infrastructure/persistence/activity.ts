import { createHash } from 'node:crypto';

import type { SqlTransaction, TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import type { ActivityStore } from '../../application/activity.js';
import type { ActivityEvent, ActivityQuery } from '../../domain/activity.js';
import { activityOutcomeRules } from '../../domain/activity-outcome.js';

const coverage =
  'Recorded decisions, execution, verification, issue resolutions and procurement changes. Owners and administrators also see connection changes. Older unrecorded changes and legacy playbook activation history are unavailable. Execution mode is shown only when recorded.';

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

// The subject filter compares against uuid::text, which is always lowercase and hyphenated,
// so only canonical UUID strings can match an issue, run or proposal ID.
const canonicalUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuids = (values: string[]) =>
  values.filter((value) => canonicalUuid.test(value));

// Subject reads scan only source rows whose exception or proposal can pass the final subject
// filter. Plain columns keep both arms index-backed under row-level security; the second arm
// skips rows the first arm already returned.
const linkedSources = `(SELECT * FROM workspace_activity_sources WHERE exception_id=ANY($16::uuid[])
  UNION ALL SELECT * FROM workspace_activity_sources
  WHERE proposal_id=ANY($17::uuid[]) AND (exception_id=ANY($16::uuid[])) IS NOT TRUE)`;

/**
 * Lists every exception and proposal ID through which a source row can reach the subject
 * filter: the given issues and runs, order-subject issues, proposals and runs of those issues,
 * proposals, runs and admission steps targeting the order, admission steps of the runs, and
 * proposals of audit or execution events correlated with a trigger run in the time window.
 * The result may include unrelated IDs; the final subject filter stays the exact check.
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
      UNION SELECT id FROM case_proposals WHERE tenant_id=$1 AND (exception_id IN (SELECT id FROM issues)
       OR (document->'target'->>'kind'='order' AND document->'target'->>'id'=ANY($4)))
      UNION SELECT id FROM playbook_runs WHERE tenant_id=$1 AND incident_id=ANY($2::uuid[]::text[])
      UNION SELECT id FROM playbook_runs WHERE tenant_id=$1 AND target_kind='order' AND target_id=ANY($4)
      UNION SELECT proposal_id FROM action_admission_steps WHERE tenant_id=$1 AND (run_id=ANY($3::uuid[])
       OR (document->'action'->'target'->>'kind'='order' AND document->'action'->'target'->>'id'=ANY($4)))
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

/** Reads canonical durable events without per-issue queries or raw payload exposure. */
export function createActivityStore(db: TenantDatabase): ActivityStore {
  return {
    list: (context, query) =>
      db.transaction(context.tenantId, async (tx) => {
        const key = createHash('sha256')
          .update(
            JSON.stringify([
              'activity-v3',
              context.tenantId,
              context.actor.role,
              query.from,
              query.to,
              query.q ?? '',
              query.system ?? '',
              query.connectionId ?? '',
              query.type ?? '',
              query.outcome ?? '',
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
        const linked = query.subjects
          ? await readLinkedKeys(tx, context.tenantId, query, query.subjects)
          : null;
        const result = await tx.query<{ item: ActivityEvent; at: string }>(
          `
      WITH enriched AS (
        SELECT s.*,COALESCE(s.exception_id,p.exception_id,(r.document->>'incidentId')::uuid) AS issue_id,
        COALESCE(s.connection_id,(s.doc->>'connectionId')::uuid,(p.document->>'connectionId')::uuid,(r.document->'action'->>'connectionId')::uuid) AS conn_id,
        COALESCE(s.doc->'details'->>'purchaseOrderId',p.document->'target'->>'id',r.document->'action'->'target'->>'id',a.document->'action'->'target'->>'id',e.document->'subject'->>'subjectId') AS resource,
        COALESCE(CASE WHEN s.doc->'details'->>'purchaseOrderId' IS NOT NULL THEN 'purchase_order' END,p.document->'target'->>'kind',r.document->'action'->'target'->>'kind',a.document->'action'->'target'->>'kind',e.document->'subject'->>'subjectKind') AS resource_kind,
        COALESCE(CASE WHEN s.doc->>'eventType' LIKE 'purchase_order.%' THEN s.doc->'details'->>'reason' END,p.document->>'capability',r.document->'action'->>'capability',a.document->'action'->>'capability') AS summary,
        CASE WHEN e.document->'subject'->>'subjectKind'='connection' THEN e.document->'subject'->>'subjectId' END AS subject_connection,
        COALESCE(r.definition_id,w.definition_id,s.doc->'details'->>'definitionId') AS playbook_id,COALESCE(v.document->'provenance'->>'kind',wv.document->'provenance'->>'kind') AS mode,
        COALESCE(s.doc->>'eventType','case.updated') AS action,
        w.id::text AS workflow_run_id,
        s.doc->'details' AS details
        FROM ${linked ? linkedSources : 'workspace_activity_sources'} s
        LEFT JOIN case_proposals p ON p.tenant_id=s.tenant_id AND p.id=s.proposal_id
        LEFT JOIN exceptions e ON e.tenant_id=s.tenant_id AND e.id=COALESCE(s.exception_id,p.exception_id)
        LEFT JOIN playbook_runs r ON r.tenant_id=s.tenant_id AND r.id=s.proposal_id
        LEFT JOIN playbook_versions v ON v.tenant_id=r.tenant_id AND v.definition_id=r.definition_id AND v.version=r.version
        LEFT JOIN action_admission_steps a ON a.tenant_id=s.tenant_id AND a.proposal_id=s.proposal_id
        LEFT JOIN workflow_trigger_runs w ON w.tenant_id=s.tenant_id AND w.id::text=COALESCE(a.run_id::text,s.doc->>'correlationId')
        LEFT JOIN playbook_versions wv ON wv.tenant_id=w.tenant_id AND wv.definition_id=w.definition_id AND wv.version=w.version
        WHERE s.tenant_id=$1 AND s.recorded_at >= $2::timestamptz AND s.recorded_at < $3::timestamptz
        AND (NOT s.restricted OR $4::boolean)
        AND ($5::timestamptz IS NULL OR (s.recorded_at,s.id)<($5::timestamptz,$6::text))
      ), classified AS (
        SELECT e.*,connections.items AS connections,
        connections.items->0->>'system' AS system,
        CASE WHEN action LIKE 'purchase_order.%' THEN 'procurement'
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
      )
      SELECT to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
      jsonb_build_object('id',id,'recordedAt',to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'occurredAt',to_char((doc->>'occurredAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'actorId',left(doc->'actor'->>'id',300),'actorKind',left(doc->'actor'->>'kind',40),
      'action',left(action,160),'type',type,'outcome',outcome,'exceptionId',issue_id,'proposalId',proposal_id,
      'attemptId',doc->>'attemptId','connectionId',COALESCE(conn_id,(connections->0->>'id')::uuid),'connections',COALESCE((SELECT jsonb_agg(value) FROM (SELECT value FROM jsonb_array_elements(connections) LIMIT 100) bounded),'[]'::jsonb),'system',left(system,100),'resource',left(resource,300),
      'playbookId',left(playbook_id,200),'mode',CASE WHEN mode IN ('simulation','shadow','pilot') THEN mode ELSE 'unrecorded' END,
      'executionState',left(details->>'state',100),'verificationPhase',left(details->>'phase',40),'failureCode',left(details->>'failureCode',100),'summary',left(summary,300),'dispatch',left(details->>'dispatch',100),'verification',left(details->>'verification',100),
      'evidenceRefs',COALESCE((SELECT jsonb_agg(left(ref,500)) FROM (SELECT value #>> '{}' AS ref FROM jsonb_array_elements(CASE WHEN jsonb_typeof(doc->'evidenceRefs')='array' THEN doc->'evidenceRefs' ELSE '[]'::jsonb END) WHERE jsonb_typeof(value)='string' LIMIT 100) refs),'[]'::jsonb)) AS item
      FROM classified WHERE ($7::text IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(connections) c WHERE c->>'system'=$7)) AND ($8::uuid IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(connections) c WHERE c->>'id'=$8::text))
      AND ($9::text IS NULL OR type=$9) AND ($10::text IS NULL OR outcome=$10)
      AND ($11::text='' OR position(lower($11) in lower(concat_ws(' ',issue_id::text,resource,action,doc->'actor'->>'id',workflow_run_id)))>0)
      AND ($13::text[] IS NULL OR issue_id::text=ANY($13) OR workflow_run_id=ANY($14) OR proposal_id::text=ANY($14)
        OR (resource_kind='order' AND resource=ANY($15)))
      ORDER BY recorded_at DESC,id DESC LIMIT $12`,
          [
            context.tenantId,
            query.from,
            query.to,
            ['owner', 'admin'].includes(context.actor.role),
            after?.at ?? null,
            after?.id ?? null,
            query.system ?? null,
            query.connectionId ?? null,
            query.type ?? null,
            query.outcome ?? null,
            query.q ?? '',
            query.limit + 1,
            query.subjects?.issueIds ?? null,
            query.subjects?.runIds ?? [],
            query.subjects?.orderRefs ?? [],
            ...(linked ? [linked.issueIds, linked.proposalIds] : []),
          ],
        );
        const rows = result.rows.slice(0, query.limit);
        const last = rows.at(-1);

        return {
          visibility: ['owner', 'admin'].includes(context.actor.role)
            ? 'admin'
            : 'member',
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
  };
}
