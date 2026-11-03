import { hasPermission, type TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { sqlUuid } from '@luma/platform';

import type { DecisionItem } from '../../application/decisions.js';

type History = {
  purchaseOrderId: string | null;
  runId: string | null;
  requestedAt: string;
  requesterId: string;
  label: string | null;
  owner: DecisionItem['owner'];
  record: DecisionItem['record'];
  approval: {
    outcome: 'approved' | 'rejected';
    approverId: string;
    createdAt: string;
  } | null;
  expiresAt: string;
  execution: {
    state: string;
    attempt: { verification?: { outcome: string } };
  } | null;
  definitionId: string | null;
  actorName: string | null;
  actorEmail: string | null;
};

/** Reads the outcome of an owner-recorded decision after it leaves the queue; never recreates approval authority. */
export async function readDecisionHistory(
  db: TenantDatabase,
  context: TenantContext,
  id: string,
): Promise<DecisionItem | null> {
  const replenishment = id.startsWith('replenishment:');
  const stock = id.startsWith('shopify:inventory_correction:');
  const submission = id.startsWith('supplier:submission_approval:');
  const issue = id.startsWith('case:');
  if (!replenishment && !stock && !submission && !issue) return null;
  const prefix = replenishment
    ? 'replenishment:'
    : stock
      ? 'shopify:inventory_correction:'
      : submission
        ? 'supplier:submission_approval:'
        : 'case:';
  const [sourceId, connectionId, ...extra] = id.slice(prefix.length).split(':');
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    !sourceId ||
    !uuid.test(sourceId) ||
    extra.length ||
    (connectionId !== undefined && (!stock || !uuid.test(connectionId)))
  )
    return null;
  if (
    !hasPermission(
      context,
      issue ? 'issues.read' : stock ? 'inventory.read' : 'procurement.read',
    )
  )
    return null;
  if (stock && !context.permissions.has('shopify:inventory_corrections.apply'))
    return null;
  const source = replenishment
    ? `SELECT p.id AS purchase_order_id,r.id AS run_id,a.document->'action' AS action,r.definition_id,
       jsonb_build_object('kind','workflow_run','definitionId',r.definition_id,'runId',r.id) AS owner,
       NULL::jsonb AS record,COALESCE(p.document->>'reference',a.document->'action'->'parameters'->>'reference') AS label
       FROM workflow_trigger_runs r JOIN action_admission_steps a ON a.tenant_id=r.tenant_id AND a.run_id=r.id AND a.step_id='create-order'
       LEFT JOIN LATERAL (SELECT o.id,o.document FROM procurement_purchase_orders o WHERE o.tenant_id=r.tenant_id AND o.id=${sqlUuid('a.target_id')} LIMIT 1) p ON true
       WHERE r.tenant_id=$1 AND r.id=$2::uuid`
    : submission
      ? `SELECT c.purchase_order_id,NULL::uuid AS run_id,a.document->'action' AS action,NULL::text AS definition_id,
       jsonb_build_object('kind','purchase_order','purchaseOrderId',c.purchase_order_id) AS owner,NULL::jsonb AS record,p.document->>'reference' AS label
       FROM procurement_submissions c JOIN action_admission_steps a ON a.tenant_id=c.tenant_id AND a.proposal_id=(c.document->>'actionId')::uuid
       JOIN procurement_purchase_orders p ON p.tenant_id=c.tenant_id AND p.id=c.purchase_order_id
       WHERE c.tenant_id=$1 AND c.id=$2::uuid`
      : issue
        ? `SELECT NULL::uuid AS purchase_order_id,NULL::uuid AS run_id,p.document AS action,NULL::text AS definition_id,
       jsonb_build_object('kind','case','exceptionId',e.id) AS owner,NULL::jsonb AS record,'Issue decision'::text AS label
       FROM exceptions e JOIN case_proposals p ON p.tenant_id=e.tenant_id AND p.exception_id=e.id
       WHERE e.tenant_id=$1 AND e.id=$2::uuid ORDER BY p.created_at DESC,p.id DESC LIMIT 1`
        : `SELECT NULL::uuid AS purchase_order_id,r.id AS run_id,c.document->'action' AS action,r.definition_id,
       jsonb_build_object('kind','app_inventory','appId','shopify','positionId',c.position_id) AS owner,
       jsonb_build_object('kind','position','id',c.position_id) AS record,
       COALESCE(c.document->'before'->'product'->>'sku',c.document->'before'->'product'->>'title','Shopify stock correction') AS label
       FROM shopify_inventory_corrections c
       LEFT JOIN LATERAL (SELECT s.tenant_id,s.run_id FROM action_admission_steps s WHERE s.tenant_id=c.tenant_id AND s.proposal_id=${sqlUuid("c.document->'action'->>'id'")} LIMIT 1) a ON true
       CROSS JOIN LATERAL (SELECT ${sqlUuid("COALESCE(c.document->>'workflowRunId',a.run_id::text)")} AS id OFFSET 0) run
       LEFT JOIN workflow_trigger_runs r ON r.tenant_id=a.tenant_id AND r.id=run.id
       WHERE c.tenant_id=$1 AND (c.position_id=$2::uuid OR c.id=$2::uuid) AND ($3::uuid IS NULL OR c.connection_id=$3::uuid)
       ORDER BY c.created_at DESC LIMIT 1`;
  const row = await db.transaction(
    context.tenantId,
    async (tx) =>
      (
        await tx.query<History>(
          `WITH source AS (${source}) SELECT s.purchase_order_id AS "purchaseOrderId",s.run_id AS "runId",s.owner,s.record,s.label,s.definition_id AS "definitionId",
     s.action->'proposedBy'->>'id' AS "requesterId",COALESCE((SELECT min(document->>'evaluatedAt') FROM policy_decisions WHERE tenant_id=$1 AND proposal_id=(s.action->>'id')::uuid),s.action->'preconditions'->>'validUntil') AS "requestedAt",
     s.action->>'expiresAt' AS "expiresAt",g.document AS approval,x.document AS execution,
     person.name AS "actorName",person.email AS "actorEmail"
     FROM source s
     LEFT JOIN LATERAL (SELECT document FROM policy_approvals WHERE tenant_id=$1 AND proposal_id=(s.action->>'id')::uuid ORDER BY created_at DESC LIMIT 1) g ON true
     LEFT JOIN LATERAL (SELECT document FROM executed_actions WHERE tenant_id=$1 AND proposal_id=(s.action->>'id')::uuid ORDER BY created_at DESC LIMIT 1) x ON true
     CROSS JOIN LATERAL (SELECT ${sqlUuid("g.document->>'approverId'")} AS id OFFSET 0) approver
     LEFT JOIN workspace_people person ON person.tenant_id=$1 AND person.user_id=approver.id`,
          stock
            ? [context.tenantId, sourceId, connectionId ?? null]
            : [context.tenantId, sourceId],
        )
      ).rows[0],
  );
  if (!row || (!row.approval && Date.parse(row.expiresAt) > Date.now()))
    return null;
  const outcome: NonNullable<DecisionItem['outcome']> = {
    state: row.approval?.outcome ?? 'expired',
    at: row.approval?.createdAt ?? row.expiresAt,
    actorId: row.approval?.approverId ?? null,
    actorName: row.actorName,
    actorEmail: row.actorEmail,
    next:
      row.execution?.attempt.verification?.outcome === 'passed'
        ? 'verified'
        : row.execution?.state === 'failed'
          ? 'failed'
          : row.execution?.state === 'unknown'
            ? 'uncertain'
            : row.execution?.state === 'prepared'
              ? 'running'
              : 'pending',
    workflow: replenishment || submission || !!row.definitionId,
    ...(row.purchaseOrderId ? { purchaseOrderId: row.purchaseOrderId } : {}),
    ...(row.runId && row.definitionId
      ? { runId: row.runId, definitionId: row.definitionId }
      : {}),
  };

  return {
    id,
    kind: replenishment
      ? 'replenishment'
      : submission
        ? 'supplier_commitment'
        : issue
          ? 'case'
          : 'inventory_correction',
    domain: issue ? 'operations' : stock ? 'inventory' : 'procurement',
    reason: 'approval',
    title:
      row.label ??
      (replenishment
        ? 'Replenishment purchase order'
        : 'Shopify stock correction'),
    why: '',
    consequences: [],
    change: [],
    impact: { level: 'unknown', text: null },
    urgency: 'normal',
    requestedAt: row.requestedAt,
    requesterId: row.requesterId,
    deadline: null,
    evidence: { observedAt: null, validUntil: null, state: 'unknown' },
    response: 'view_only',
    assignment: null,
    subject: { label: row.label ?? '', detail: null },
    record: row.record,
    owner: row.owner,
    group: { key: 'answered', label: 'Answered' },
    outcome,
  };
}
