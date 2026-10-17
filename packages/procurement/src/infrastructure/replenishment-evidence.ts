import type { SqlTransaction } from '@luma/platform';

import { replenishmentSource } from '../domain/replenishment.js';
import { lifecycleEvents } from './purchase-order-evidence.js';

/** A reference a replenishment run cites, and when the citing step or record was written. */
interface RunCitation {
  ref: string;
  citedAs: 'read' | 'record';
  citedAt: string | null;
}

/** A procurement or policy record that a run's reference names. */
interface RunRecord {
  kind: 'luma_record';
  id: string;
  record:
    | 'replenishment_rule'
    | 'replenishment_proposal'
    | 'supplier'
    | 'purchase_order'
    | 'policy_decision'
    | 'approval';
}

type StepRow = {
  step_id: string;
  state: string;
  refs: unknown;
  at: string | null;
};

type RunRow = {
  activation_id: string | null;
  supplier_id: string | null;
  proposal_id: string | null;
  draft_id: string | null;
  admitted_at: Date | null;
  context: {
    recordedAt?: unknown;
    dailySales?: unknown;
    demandEvidenceRefs?: unknown;
    openOrders?: unknown;
  } | null;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const strings = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];

/** The run, its rule and supplier, its admitted proposal and the facts frozen for its review. */
async function run(tx: SqlTransaction, tenantId: string, runId: string) {
  return (
    await tx.query<RunRow>(
      `SELECT r.document->'context'->'inputs'->>'activationId' AS activation_id,
        a.document->>'supplierId' AS supplier_id,s.proposal_id::text,
        s.document->'action'->'target'->>'id' AS draft_id,s.created_at AS admitted_at,c.document AS context
       FROM workflow_trigger_runs r
       LEFT JOIN replenishment_activations a ON a.tenant_id=r.tenant_id
        AND a.id::text=r.document->'context'->'inputs'->>'activationId'
       LEFT JOIN action_admission_steps s ON s.tenant_id=r.tenant_id AND s.run_id=r.id AND s.step_id='create-order'
       LEFT JOIN replenishment_approval_contexts c ON c.tenant_id=r.tenant_id AND c.run_id=r.id
       WHERE r.tenant_id=$1 AND r.id=$2::uuid AND r.definition_id=$3`,
      [tenantId, runId, replenishmentSource.definition.id],
    )
  ).rows[0];
}

/**
 * Reads what a replenishment run cites, for the evidence view of its decision: the stock read
 * the inventory step took, the proposal step's stock read, supplier and existing orders, the
 * policy decision the approval waits on, the order reads behind the demand estimate and the
 * orders its review counted, the rule and the admitted proposal, and the drafted order's events
 * that verified it. The proposal's execution belongs to the run. A review context frozen with a
 * known demand estimate before Luma recorded its order reads relies on reads it cannot cite;
 * those are reported as uncited. Returns null when the tenant has no such replenishment run.
 */
export async function replenishmentRunCitations(
  tx: SqlTransaction,
  tenantId: string,
  runId: string,
): Promise<{
  actionIds: string[];
  citations: RunCitation[];
  uncited: { evidence: 'demand_reads'; recordedAt: string }[];
} | null> {
  if (!uuid.test(runId)) return null;
  const row = await run(tx, tenantId, runId);
  if (!row) return null;
  const steps = (
    await tx.query<StepRow>(
      `SELECT step_id,state,document->'evidenceRefs' AS refs,
        COALESCE(document->>'observedAt',document->>'recordedAt') AS at
       FROM workflow_process_steps WHERE tenant_id=$1 AND run_id=$2::uuid ORDER BY sequence`,
      [tenantId, runId],
    )
  ).rows;
  const stock = new Set(
    steps.flatMap((step) =>
      step.step_id === 'inventory' ? strings(step.refs) : [],
    ),
  );
  const cite = (
    ref: string,
    citedAs: RunCitation['citedAs'],
    citedAt: string | null,
  ) => ({ ref, citedAs, citedAt });
  const citations: RunCitation[] = steps.flatMap((step) => {
    const refs = strings(step.refs).filter(
      (ref) => !ref.startsWith('temporal:'),
    );
    switch (step.step_id) {
      case 'inventory':
        return refs.map((ref) => cite(ref, 'read', step.at));
      case 'proposal':
        // The stock read again, then the supplier and the orders that already cover the SKU.
        return refs.map((ref) =>
          cite(ref, stock.has(ref) ? 'read' : 'record', step.at),
        );
      case 'create-order':
        // The policy decision an approval waits on, or the proposal that was not sent. A
        // completed step names the execution attempt, whose receipts the run's action cites.
        return step.state === 'completed'
          ? []
          : refs.map((ref) => cite(ref, 'record', step.at));
      case 'verify-order':
        // The drafted order's lifecycle events that the independent read found.
        return refs.map((ref) => cite(ref, 'record', step.at));
      default:
        return [];
    }
  });
  const admittedAt = row.admitted_at?.toISOString() ?? null;
  const reviewedAt =
    typeof row.context?.recordedAt === 'string' ? row.context.recordedAt : null;
  const openOrders = Array.isArray(row.context?.openOrders)
    ? row.context.openOrders.flatMap((order: unknown) =>
        order &&
        typeof order === 'object' &&
        'id' in order &&
        typeof order.id === 'string'
          ? [order.id]
          : [],
      )
    : [];

  // Contexts frozen since Luma recorded demand reads always have the field, empty when demand
  // was unknown, so a known estimate without it rests on reads that weren't kept.
  const demandUncited =
    typeof row.context?.dailySales === 'number' &&
    !Array.isArray(row.context.demandEvidenceRefs);

  return {
    actionIds: row.proposal_id ? [row.proposal_id] : [],
    uncited:
      demandUncited && reviewedAt
        ? [{ evidence: 'demand_reads', recordedAt: reviewedAt }]
        : [],
    citations: [
      ...(row.activation_id ? [cite(row.activation_id, 'record', null)] : []),
      ...(row.proposal_id ? [cite(row.proposal_id, 'record', admittedAt)] : []),
      ...citations,
      ...strings(row.context?.demandEvidenceRefs).map((ref) =>
        cite(ref, 'read', reviewedAt),
      ),
      ...openOrders.map((ref) => cite(ref, 'record', reviewedAt)),
    ],
  };
}

/**
 * Finds the records a replenishment run's references name: its rule, its admitted proposal with
 * the proposal's policy decisions and approvals, the rule's supplier, the orders the run cites or
 * drafted, and the drafted order's lifecycle events. Every query is scoped to the run, so a
 * reference from another run resolves to nothing. Stock and demand reads belong to the
 * inventory and orders owners.
 */
export async function replenishmentRunEvidence(
  tx: SqlTransaction,
  tenantId: string,
  runId: string,
  refs: { uuids: string[] },
) {
  if (!refs.uuids.length || !uuid.test(runId)) return [];
  const row = await run(tx, tenantId, runId);
  const cited = await replenishmentRunCitations(tx, tenantId, runId);
  if (!row || !cited) return [];
  const orders = [
    ...cited.citations.flatMap((c) => (c.citedAs === 'record' ? [c.ref] : [])),
    ...(row.draft_id ? [row.draft_id] : []),
  ].filter((id) => uuid.test(id));
  const ids = (value: string | null) =>
    value && uuid.test(value) ? [value] : [];
  const { rows } = await tx.query<{ id: string; record: RunRecord['record'] }>(
    `SELECT id::text,'replenishment_rule' AS record FROM replenishment_activations
      WHERE tenant_id=$1 AND id=ANY($3::uuid[]) AND id=ANY($2::uuid[])
     UNION ALL SELECT proposal_id::text,'replenishment_proposal' FROM action_admission_steps
      WHERE tenant_id=$1 AND proposal_id=ANY($4::uuid[]) AND proposal_id=ANY($2::uuid[])
     UNION ALL SELECT id::text,'policy_decision' FROM policy_decisions
      WHERE tenant_id=$1 AND proposal_id=ANY($4::uuid[]) AND id=ANY($2::uuid[])
     UNION ALL SELECT id::text,'approval' FROM policy_approvals
      WHERE tenant_id=$1 AND proposal_id=ANY($4::uuid[]) AND id=ANY($2::uuid[])
     UNION ALL SELECT id::text,'supplier' FROM procurement_suppliers
      WHERE tenant_id=$1 AND id=ANY($5::uuid[]) AND id=ANY($2::uuid[])
     UNION ALL SELECT id::text,'purchase_order' FROM procurement_purchase_orders
      WHERE tenant_id=$1 AND id=ANY($6::uuid[]) AND id=ANY($2::uuid[])`,
    [
      tenantId,
      refs.uuids,
      ids(row.activation_id),
      ids(row.proposal_id),
      ids(row.supplier_id),
      orders,
    ],
  );

  return [
    ...rows.map((record): RunRecord => ({
      kind: 'luma_record',
      id: record.id,
      record: record.record,
    })),
    ...(await lifecycleEvents(tx, tenantId, ids(row.draft_id), refs.uuids)),
  ];
}
