import type { ExecutionRecord } from '@luma/execution';
import type { SqlTransaction } from '@luma/platform';
import type { Approval, PolicyDecision } from '@luma/policies';

import type { PurchaseOrderChange } from '../domain/purchase-order-changes.js';
import type { PurchasingPlan } from '../domain/purchasing.js';
import {
  purchasingExecutionVerified,
  type PurchasingTimelineEntry,
} from '../domain/purchasing-timeline.js';

/** Reads only this order's stored purchasing actions, policy responses and independent execution proof. */
export async function readPurchasingActionTimeline(
  tx: SqlTransaction,
  tenantId: string,
  orderId: string,
  includeStock: boolean,
) {
  const entries: PurchasingTimelineEntry[] = [];
  const add = (
    entry: Pick<
      PurchasingTimelineEntry,
      'id' | 'kind' | 'stage' | 'at' | 'source'
    > &
      Partial<
        Omit<PurchasingTimelineEntry, 'id' | 'kind' | 'stage' | 'at' | 'source'>
      >,
  ) =>
    entries.push({
      actorId: null,
      reason: null,
      evidenceRefs: [],
      quantity: null,
      unit: null,
      revision: null,
      detail: null,
      ...entry,
    });
  const plans = (
    await tx.query<{ document: PurchasingPlan }>(
      "SELECT document FROM procurement_purchasing_plans WHERE tenant_id=$1 AND document->'order'->>'id'=$2 ORDER BY created_at DESC LIMIT 501",
      [tenantId, orderId],
    )
  ).rows.map((row) => row.document);
  const changes = (
    await tx.query<{ document: PurchaseOrderChange }>(
      "SELECT document FROM procurement_order_changes WHERE tenant_id=$1 AND purchase_order_id=$2 ORDER BY document->>'requestedAt' DESC LIMIT 501",
      [tenantId, orderId],
    )
  ).rows.map((row) => row.document);
  const submissions = (
    await tx.query<{ id: string; action_id: string; channel: string }>(
      `SELECT id,document->>'actionId' AS action_id,COALESCE(document->>'channel','purchasing_system') AS channel FROM procurement_submissions WHERE tenant_id=$1 AND purchase_order_id=$2 ORDER BY created_at DESC LIMIT 501`,
      [tenantId, orderId],
    )
  ).rows;
  const actions = new Map<
    string,
    {
      kind: PurchasingTimelineEntry['kind'];
      id: string;
      revision: number | null;
      quantity: number | null;
      channel?: string;
    }
  >();
  for (const plan of plans) {
    const quantity = plan.order.lines.reduce(
      (sum, line) => sum + line.quantity,
      0,
    );
    actions.set(plan.actionId, {
      kind: 'draft',
      id: plan.id,
      revision: 1,
      quantity,
    });
    add({
      id: `plan:${plan.id}:requested`,
      kind: 'draft',
      stage: 'recorded',
      at: plan.createdAt,
      source: 'luma',
      actorId: plan.requestedBy,
      reason: plan.request.reason,
      evidenceRefs: [
        plan.id,
        ...plan.suggestions.flatMap((suggestion) => suggestion.evidenceRefs),
      ],
      quantity,
      revision: 1,
    });
  }
  for (const change of changes) {
    const quantity = change.proposed.lines.reduce(
      (sum, line) => sum + line.quantity,
      0,
    );
    actions.set(change.actionId, {
      kind: 'revision',
      id: change.id,
      revision: change.proposed.revision,
      quantity,
    });
    add({
      id: `revision:${change.id}:requested`,
      kind: 'revision',
      stage: 'recorded',
      at: change.requestedAt,
      source: 'luma',
      actorId: change.requestedBy,
      reason: change.request.reason,
      evidenceRefs: [change.id],
      quantity,
      revision: change.proposed.revision,
      detail: change.request.operation.kind,
    });
    if (change.verifiedAt)
      add({
        id: `revision:${change.id}:verified`,
        kind: 'revision',
        stage: 'verified',
        at: change.verifiedAt,
        source: 'purchasing_system',
        reason: change.request.reason,
        evidenceRefs: change.observationRefs,
        quantity,
        revision: change.proposed.revision,
      });
  }
  for (const submission of submissions)
    actions.set(submission.action_id, {
      kind: 'submission',
      id: submission.id,
      revision: null,
      quantity: null,
      channel: submission.channel,
    });
  if (includeStock) {
    const corrections = (
      await tx.query<{
        id: string;
        created_at: Date;
        action_id: string;
        actor_id: string | null;
        quantity: string;
        unit: string | null;
      }>(
        `SELECT r.id,r.created_at,r.document->'action'->>'id' AS action_id,r.document->'action'->'proposedBy'->>'id' AS actor_id,r.document->'target'->'receipt'->>'quantity' AS quantity,s.document->'data'->>'unit' AS unit FROM shopify_inventory_corrections r LEFT JOIN inventory_projections p ON p.tenant_id=r.tenant_id AND p.entity_id=r.position_id AND p.connection_id=r.connection_id LEFT JOIN inventory_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id WHERE r.tenant_id=$1 AND r.document->'target'->'receipt'->>'purchaseOrderId'=$2 ORDER BY r.created_at DESC LIMIT 501`,
        [tenantId, orderId],
      )
    ).rows;
    for (const correction of corrections) {
      const quantity = Number(correction.quantity);
      actions.set(correction.action_id, {
        kind: 'stock_booking',
        id: correction.id,
        revision: null,
        quantity: Number.isFinite(quantity) ? quantity : null,
      });
      add({
        id: `stock:${correction.id}:requested`,
        kind: 'stock_booking',
        stage: 'recorded',
        at: correction.created_at.toISOString(),
        source: 'inventory',
        actorId: correction.actor_id,
        evidenceRefs: [correction.id],
        quantity: Number.isFinite(quantity) ? quantity : null,
        unit: correction.unit,
      });
    }
  }
  const ids = [...actions.keys()];
  if (ids.length) {
    const decisions = (
      await tx.query<{ document: PolicyDecision }>(
        'SELECT document FROM policy_decisions WHERE tenant_id=$1 AND proposal_id=ANY($2::uuid[]) ORDER BY created_at DESC LIMIT 501',
        [tenantId, ids],
      )
    ).rows;
    for (const { document: decision } of decisions) {
      const action = actions.get(decision.proposalId);
      if (!action || decision.outcome === 'allowed') continue;
      add({
        id: `policy:${decision.id}`,
        kind: action.kind,
        stage:
          decision.outcome === 'approval_required'
            ? 'approval_required'
            : 'failed',
        at: decision.evaluatedAt,
        source: 'luma',
        actorId: decision.actorId,
        evidenceRefs: [decision.id, action.id],
        quantity: action.quantity,
        revision: action.revision,
      });
    }
    const approvals = (
      await tx.query<{ document: Approval }>(
        'SELECT document FROM policy_approvals WHERE tenant_id=$1 AND proposal_id=ANY($2::uuid[]) ORDER BY created_at DESC LIMIT 501',
        [tenantId, ids],
      )
    ).rows;
    for (const { document: approval } of approvals) {
      const action = actions.get(approval.proposalId);
      if (!action) continue;
      add({
        id: `approval:${approval.id}`,
        kind: action.kind,
        stage: approval.outcome === 'approved' ? 'approved' : 'rejected',
        at: approval.createdAt,
        source: 'luma',
        actorId: approval.approverId,
        evidenceRefs: [approval.id, approval.decisionId, action.id],
        quantity: action.quantity,
        revision: action.revision,
      });
    }
    const executions = (
      await tx.query<{ document: ExecutionRecord }>(
        'SELECT document FROM executed_actions WHERE tenant_id=$1 AND proposal_id=ANY($2::uuid[]) ORDER BY updated_at DESC LIMIT 501',
        [tenantId, ids],
      )
    ).rows;
    for (const { document: execution } of executions) {
      const action = actions.get(execution.proposalId);
      if (!action) continue;
      if (
        action.kind === 'revision' ||
        (action.kind === 'submission' && action.channel === 'email')
      )
        continue;
      const proof = execution.attempt.verification;
      const verified = purchasingExecutionVerified(execution.attempt);
      if (action.kind === 'submission' && !verified) continue;
      add({
        id:
          action.kind === 'submission'
            ? `submission:${action.id}:verified`
            : `execution:${execution.id}`,
        kind: action.kind,
        stage: verified
          ? 'verified'
          : execution.state === 'failed'
            ? 'failed'
            : 'uncertain',
        at:
          proof?.observedAt ??
          execution.attempt.finishedAt ??
          execution.attempt.startedAt,
        source:
          action.kind === 'stock_booking'
            ? 'inventory'
            : action.kind === 'submission'
              ? 'purchasing_system'
              : 'luma',
        evidenceRefs:
          proof?.observationRefs ?? execution.attempt.effectEvidenceRefs ?? [],
        quantity: action.quantity,
        revision: action.revision,
      });
    }
  }

  return entries;
}
