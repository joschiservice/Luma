import type { SqlTransaction } from '@luma/platform';

import type {
  PurchasingReadEvidence,
  PurchasingWriteReceipt,
} from '../application/purchasing-reads.js';

/** A reference a purchase order's records cite, and when the citing record was written. */
interface PurchaseOrderCitation {
  ref: string;
  citedAs: 'read' | 'write_receipt' | 'record';
  citedAt: string | null;
}

/** Stored evidence or a procurement record that a reference names. */
type PurchaseOrderEvidence =
  | {
      kind: 'read';
      id: string;
      provider: string;
      connectionId: string;
      record: { resource: string; externalId: string } | null;
      observedAt: string;
      sourceUpdatedAt: string | null;
      sourceRevision: string | null;
      adapterVersion: string | null;
      completeness: 'complete' | 'partial' | null;
      data: unknown;
    }
  | {
      kind: 'write_receipt';
      id: string;
      provider: string;
      connectionId: string;
      capability: string;
      acceptedAt: string;
      records: { resource: string; externalId: string }[];
      providerRequestId: string | null;
      adapterVersion: string | null;
    }
  | {
      kind: 'luma_record';
      id: string;
      record:
        | 'purchase_order'
        | 'purchasing_plan'
        | 'order_change'
        | 'submission'
        | 'commitment'
        | 'supplier_message'
        | 'follow_up'
        | 'policy_decision'
        | 'approval'
        | 'procurement_event'
        | 'stock_booking'
        | 'receipt_note';
      /** The record's ID when the reference is not it, such as a receipt note's commitment. */
      recordId?: string;
      at?: string | null;
      actorId?: string | null;
      detail?: {
        kind: 'procurement_event';
        event: 'created' | 'status_changed' | 'revised';
        from: string | null;
        to: string | null;
        revision: number | null;
      } | null;
    };

/** The purchasing plans in scope: an order's plans, or one plan. */
type PlanScope = { orderId: string } | { planId: string };

/** A plan's stored request, as evidence reads need it. */
type PlanRow = {
  id: string;
  created_at: Date;
  action_id: string | null;
  decision_id: string | null;
  order_id: string | null;
  source_order_id: string | null;
  refs: unknown;
};

/** The purchasing actions of one order: its plans, revisions and submissions. */
const orderActions = `
  SELECT (document->>'actionId')::uuid AS id FROM procurement_purchasing_plans
   WHERE tenant_id=$1 AND document->'order'->>'id'=$2::text
  UNION SELECT (document->>'actionId')::uuid FROM procurement_order_changes
   WHERE tenant_id=$1 AND purchase_order_id=$2::uuid
  UNION SELECT (document->>'actionId')::uuid FROM procurement_submissions
   WHERE tenant_id=$1 AND purchase_order_id=$2::uuid`;

/** Stock bookings of the order's receipts, which the inventory owner's corrections record. */
const stockActions = `
  SELECT (document->'action'->>'id')::uuid AS id FROM shopify_inventory_corrections
   WHERE tenant_id=$1 AND document->'target'->'receipt'->>'purchaseOrderId'=$2::text`;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const strings = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];

async function plans(tx: SqlTransaction, tenantId: string, scope: PlanScope) {
  const byOrder = 'orderId' in scope;

  return (
    await tx.query<PlanRow>(
      `SELECT id::text,created_at,document->>'actionId' AS action_id,document->>'decisionId' AS decision_id,
        document->'order'->>'id' AS order_id,document->'request'->>'sourceOrderId' AS source_order_id,
        (SELECT jsonb_agg(r) FROM jsonb_array_elements(document->'suggestions') s,
          jsonb_array_elements_text(s->'evidenceRefs') r) AS refs
       FROM procurement_purchasing_plans
       WHERE tenant_id=$1 AND ${byOrder ? "document->'order'->>'id'=$2::text" : 'id=$2::uuid'}
       ORDER BY created_at DESC LIMIT 20`,
      [tenantId, byOrder ? scope.orderId : scope.planId],
    )
  ).rows;
}

/**
 * The commitments of the orders plans reorder a shortfall of, among `refs`. A plan that
 * reorders a shortfall cites the source order and its commitment as records, not reads.
 */
async function sourceCommitments(
  tx: SqlTransaction,
  tenantId: string,
  rows: PlanRow[],
  refs: string[],
) {
  const sources = [
    ...new Set(rows.flatMap((row) => row.source_order_id ?? [])),
  ];
  if (!sources.length || !refs.length) return new Set<string>();

  return new Set(
    (
      await tx.query<{ id: string }>(
        `SELECT id::text FROM procurement_commitments
         WHERE tenant_id=$1 AND purchase_order_id=ANY($2::uuid[]) AND id::text=ANY($3::text[])`,
        [tenantId, sources, refs],
      )
    ).rows.map((row) => row.id),
  );
}

/**
 * What purchasing plans cite: the plan and its policy decision as records, the stock, demand and
 * ledger reads behind each suggestion as reads, and the shortfall a reorder answers as records.
 */
async function planCitations(
  tx: SqlTransaction,
  tenantId: string,
  rows: PlanRow[],
): Promise<PurchaseOrderCitation[]> {
  const records = await sourceCommitments(
    tx,
    tenantId,
    rows,
    rows.flatMap((row) => strings(row.refs)),
  );

  return rows.flatMap((row) => {
    const citedAt = row.created_at.toISOString();
    const record = (ref: string) => ({
      ref,
      citedAs: 'record' as const,
      citedAt,
    });

    return [
      record(row.id),
      ...(row.decision_id ? [record(row.decision_id)] : []),
      ...[...new Set(strings(row.refs))].map((ref) =>
        ref === row.source_order_id || records.has(ref)
          ? record(ref)
          : { ref, citedAs: 'read' as const, citedAt },
      ),
    ];
  });
}

/**
 * Reads what a purchasing plan cites, for the evidence view: its action, whose execution
 * attempt verifies the draft, the plan and its policy decision, and the reads and shortfall
 * behind its suggestions. Returns null when the tenant has no such plan.
 */
export async function purchasingPlanCitations(
  tx: SqlTransaction,
  tenantId: string,
  planId: string,
): Promise<{ actionIds: string[]; citations: PurchaseOrderCitation[] } | null> {
  const rows = await plans(tx, tenantId, { planId });
  if (!rows.length) return null;

  return {
    actionIds: rows.flatMap((row) => row.action_id ?? []),
    citations: await planCitations(tx, tenantId, rows),
  };
}

/**
 * Reads what a purchase order cites, for the evidence view: the purchasing actions whose
 * execution attempts belong to it, the reads its verified revisions cite and what the plans that
 * drafted it cite. With `stock`, for readers with inventory access, also the stock bookings of
 * its receipts. Returns null when the tenant has no such order.
 */
export async function purchaseOrderCitations(
  tx: SqlTransaction,
  tenantId: string,
  purchaseOrderId: string,
  options: { stock: boolean },
): Promise<{ actionIds: string[]; citations: PurchaseOrderCitation[] } | null> {
  const order = await tx.query(
    'SELECT 1 FROM procurement_purchase_orders WHERE tenant_id=$1 AND id=$2',
    [tenantId, purchaseOrderId],
  );
  if (!order.rowCount) return null;
  const actions = await tx.query<{ id: string }>(
    `SELECT id::text FROM (${orderActions}${options.stock ? ` UNION ${stockActions}` : ''}) a
     WHERE id IS NOT NULL LIMIT 200`,
    [tenantId, purchaseOrderId],
  );
  const revisions = await tx.query<{
    refs: unknown;
    verified_at: string | null;
  }>(
    `SELECT document->'observationRefs' AS refs,document->>'verifiedAt' AS verified_at
     FROM procurement_order_changes WHERE tenant_id=$1 AND purchase_order_id=$2::uuid
     ORDER BY document->>'requestedAt' DESC LIMIT 100`,
    [tenantId, purchaseOrderId],
  );

  const drafts = await planCitations(
    tx,
    tenantId,
    await plans(tx, tenantId, { orderId: purchaseOrderId }),
  );

  return {
    actionIds: actions.rows.map((row) => row.id),
    citations: [
      ...drafts,
      ...revisions.rows.flatMap((row) =>
        Array.isArray(row.refs)
          ? row.refs
              .filter((ref): ref is string => typeof ref === 'string')
              .map((ref) => ({
                ref,
                citedAs: 'read' as const,
                citedAt: row.verified_at,
              }))
          : [],
      ),
    ],
  };
}

type EventRow = {
  id: string;
  type: string;
  at: string | null;
  actor_id: string | null;
  from_status: string | null;
  to_status: string | null;
  revision: string | null;
};

const events = {
  'purchase_order.created': 'created',
  'purchase_order.status_changed': 'status_changed',
  'purchase_order.revised': 'revised',
} as const;

function isEvent(type: string): type is keyof typeof events {
  return Object.hasOwn(events, type);
}

/**
 * The lifecycle events of `orderIds` among the references, with their time, actor and the
 * status change or revision they recorded.
 */
async function lifecycleEvents(
  tx: SqlTransaction,
  tenantId: string,
  orderIds: string[],
  uuids: string[],
): Promise<PurchaseOrderEvidence[]> {
  if (!orderIds.length || !uuids.length) return [];
  const { rows } = await tx.query<EventRow>(
    `SELECT id::text,document->>'eventType' AS type,document->>'occurredAt' AS at,
      document->'actor'->>'id' AS actor_id,NULLIF(document->'details'->>'from','') AS from_status,
      NULLIF(document->'details'->>'to','') AS to_status,document->'details'->>'revision' AS revision
     FROM audit_entries WHERE tenant_id=$1 AND proposal_id=ANY($2::uuid[]) AND id=ANY($3::uuid[])
      AND document->>'eventType'=ANY($4::text[])`,
    [tenantId, orderIds, uuids, Object.keys(events)],
  );

  return rows.flatMap((row): PurchaseOrderEvidence[] => {
    if (!isEvent(row.type)) return [];
    const revision = Number(row.revision);

    return [
      {
        kind: 'luma_record',
        id: row.id,
        record: 'procurement_event',
        at: row.at && Number.isFinite(Date.parse(row.at)) ? row.at : null,
        actorId: row.actor_id,
        detail: {
          kind: 'procurement_event',
          event: events[row.type],
          from: row.from_status,
          to: row.to_status,
          revision:
            row.revision !== null && Number.isInteger(revision)
              ? revision
              : null,
        },
      },
    ];
  });
}

/**
 * The records plans cite among the references: the plans, their policy decisions and approvals,
 * the orders they drafted and the shortfall a reorder answers, and the drafted orders' lifecycle
 * events, which draft verification cites.
 */
async function planRecords(
  tx: SqlTransaction,
  tenantId: string,
  rows: PlanRow[],
  uuids: string[],
): Promise<PurchaseOrderEvidence[]> {
  if (!rows.length || !uuids.length) return [];
  const orders = [
    ...new Set(rows.flatMap((row) => [row.order_id, row.source_order_id])),
  ].filter((id): id is string => !!id && uuid.test(id));
  const { rows: records } = await tx.query<{
    id: string;
    record:
      | 'purchasing_plan'
      | 'purchase_order'
      | 'commitment'
      | 'policy_decision'
      | 'approval';
  }>(
    `SELECT id::text,'purchasing_plan' AS record FROM procurement_purchasing_plans
      WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND id=ANY($3::uuid[])
     UNION ALL SELECT id::text,'purchase_order' FROM procurement_purchase_orders
      WHERE tenant_id=$1 AND id=ANY($4::uuid[]) AND id=ANY($3::uuid[])
     UNION ALL SELECT id::text,'commitment' FROM procurement_commitments
      WHERE tenant_id=$1 AND purchase_order_id=ANY($5::uuid[]) AND id=ANY($3::uuid[])
     UNION ALL SELECT id::text,'policy_decision' FROM policy_decisions
      WHERE tenant_id=$1 AND proposal_id=ANY($6::uuid[]) AND id=ANY($3::uuid[])
     UNION ALL SELECT id::text,'approval' FROM policy_approvals
      WHERE tenant_id=$1 AND proposal_id=ANY($6::uuid[]) AND id=ANY($3::uuid[])`,
    [
      tenantId,
      rows.map((row) => row.id),
      uuids,
      orders,
      rows.flatMap((row) =>
        row.source_order_id && uuid.test(row.source_order_id)
          ? [row.source_order_id]
          : [],
      ),
      rows.flatMap((row) =>
        row.action_id && uuid.test(row.action_id) ? [row.action_id] : [],
      ),
    ],
  );

  return [
    ...records.map((row) => ({
      kind: 'luma_record' as const,
      id: row.id,
      record: row.record,
    })),
    ...(await lifecycleEvents(
      tx,
      tenantId,
      rows.flatMap((row) =>
        row.order_id && uuid.test(row.order_id) ? [row.order_id] : [],
      ),
      uuids,
    )),
  ];
}

/**
 * Finds the records a purchasing plan's references name: the plan, its policy decision and
 * approvals, the order it drafted with that order's lifecycle events, and the shortfall it
 * answers. Provider reads behind its suggestions belong to the inventory and orders owners.
 */
export async function purchasingPlanEvidence(
  tx: SqlTransaction,
  tenantId: string,
  planId: string,
  refs: { uuids: string[] },
): Promise<PurchaseOrderEvidence[]> {
  return planRecords(
    tx,
    tenantId,
    await plans(tx, tenantId, { planId }),
    refs.uuids,
  );
}

/**
 * The stored mailbox messages among the references that the order's email submissions sent.
 * Messaging owns the messages; this only says which of them the order cites.
 */
export async function purchaseOrderMessageRefs(
  tx: SqlTransaction,
  tenantId: string,
  purchaseOrderId: string,
  uuids: string[],
): Promise<string[]> {
  if (!uuids.length) return [];

  return (
    await tx.query<{ id: string }>(
      `SELECT DISTINCT document->'outgoing'->>'sentMessageId' AS id FROM procurement_submissions
       WHERE tenant_id=$1 AND purchase_order_id=$2::uuid
        AND document->'outgoing'->>'sentMessageId'=ANY($3::text[])`,
      [tenantId, purchaseOrderId, uuids],
    )
  ).rows.map((row) => row.id);
}

/**
 * Finds the purchasing-system reads and write receipts procurement stored for this order, and
 * the procurement and policy records of the order that the references name: its lifecycle
 * events with their time, actor and status change, what the plans that drafted it cite, and the
 * notes people recorded with manual receipts. With `stock`, also the stock bookings of its
 * receipts and their policy records. Every query is scoped to the order, so a reference from
 * another order resolves to nothing.
 */
export async function purchaseOrderEvidence(
  tx: SqlTransaction,
  tenantId: string,
  purchaseOrderId: string,
  refs: { all: string[]; uuids: string[] },
  options: { stock: boolean } = { stock: false },
): Promise<PurchaseOrderEvidence[]> {
  // Notes people recorded as evidence with a manual receipt are free text, not IDs.
  const notes = (
    await tx.query<{ note: string; id: string }>(
      `SELECT e AS note,c.id::text FROM procurement_commitments c,
        jsonb_array_elements_text(c.document->'source'->'evidence') e
       WHERE c.tenant_id=$1 AND c.purchase_order_id=$2::uuid
        AND c.document->'source'->>'kind'='manual_receipt' AND e=ANY($3::text[])`,
      [tenantId, purchaseOrderId, refs.all],
    )
  ).rows.map((row): PurchaseOrderEvidence => ({
    kind: 'luma_record',
    id: row.note,
    record: 'receipt_note',
    recordId: row.id,
  }));
  if (!refs.uuids.length) return notes;
  const stored = await tx.query<
    | { kind: 'read'; document: PurchasingReadEvidence }
    | { kind: 'write_receipt'; document: PurchasingWriteReceipt }
  >(
    `SELECT kind,document FROM procurement_read_evidence
     WHERE tenant_id=$1 AND purchase_order_id=$2::uuid AND id=ANY($3::uuid[])`,
    [tenantId, purchaseOrderId, refs.uuids],
  );
  // Purchasing-system reads of the order that commitment facts cite. They predate the read
  // evidence table and record no completeness, revision or adapter version.
  const observations = await tx.query<{
    id: string;
    connection_id: string;
    provider: string | null;
    external_id: string;
    observed_at: Date;
    document: {
      status?: string;
      orderNumber?: string | null;
      confirmed?: boolean | null;
      lines?: unknown[];
    };
  }>(
    `SELECT o.id::text,o.connection_id::text,
      COALESCE(c.document->>'provider',c.document->'target'->>'kind') AS provider,
      o.document->>'externalId' AS external_id,o.observed_at,o.document
     FROM procurement_observations o
     LEFT JOIN connector_installations c ON c.tenant_id=o.tenant_id AND c.id=o.connection_id
     WHERE o.tenant_id=$1 AND o.purchase_order_id=$2::uuid AND o.id=ANY($3::uuid[])`,
    [tenantId, purchaseOrderId, refs.uuids],
  );
  const records = await tx.query<{
    id: string;
    record: Extract<PurchaseOrderEvidence, { kind: 'luma_record' }>['record'];
  }>(
    `WITH actions AS (${orderActions}${options.stock ? ` UNION ${stockActions}` : ''})
     SELECT id::text,'purchase_order' AS record FROM procurement_purchase_orders
      WHERE tenant_id=$1 AND id=$2::uuid AND id=ANY($3::uuid[])
     UNION ALL SELECT id::text,'purchasing_plan' FROM procurement_purchasing_plans
      WHERE tenant_id=$1 AND document->'order'->>'id'=$2::text AND id=ANY($3::uuid[])
     UNION ALL SELECT id::text,'order_change' FROM procurement_order_changes
      WHERE tenant_id=$1 AND purchase_order_id=$2::uuid AND id=ANY($3::uuid[])
     UNION ALL SELECT id::text,'submission' FROM procurement_submissions
      WHERE tenant_id=$1 AND purchase_order_id=$2::uuid AND id=ANY($3::uuid[])
     UNION ALL SELECT id::text,'commitment' FROM procurement_commitments
      WHERE tenant_id=$1 AND purchase_order_id=$2::uuid AND id=ANY($3::uuid[])
     UNION ALL SELECT id::text,'supplier_message' FROM procurement_communications
      WHERE tenant_id=$1 AND purchase_order_id=$2::uuid AND id=ANY($3::uuid[])
     UNION ALL SELECT id::text,'follow_up' FROM procurement_follow_ups
      WHERE tenant_id=$1 AND purchase_order_id=$2::uuid AND id=ANY($3::uuid[])
     UNION ALL SELECT id::text,'policy_decision' FROM policy_decisions
      WHERE tenant_id=$1 AND id=ANY($3::uuid[]) AND proposal_id IN (SELECT id FROM actions)
     UNION ALL SELECT id::text,'approval' FROM policy_approvals
      WHERE tenant_id=$1 AND id=ANY($3::uuid[]) AND proposal_id IN (SELECT id FROM actions)${
        options.stock
          ? `
     UNION ALL SELECT id::text,'stock_booking' FROM shopify_inventory_corrections
      WHERE tenant_id=$1 AND id=ANY($3::uuid[]) AND document->'target'->'receipt'->>'purchaseOrderId'=$2::text`
          : ''
      }`,
    [tenantId, purchaseOrderId, refs.uuids],
  );

  const drafts = await planRecords(
    tx,
    tenantId,
    await plans(tx, tenantId, { orderId: purchaseOrderId }),
    refs.uuids,
  );

  return [
    ...notes,
    ...drafts,
    ...(await lifecycleEvents(tx, tenantId, [purchaseOrderId], refs.uuids)),
    ...stored.rows.map((row): PurchaseOrderEvidence => {
      if (row.kind === 'write_receipt') {
        const receipt = row.document;

        return {
          kind: 'write_receipt',
          id: receipt.id,
          provider: receipt.source.provider,
          connectionId: receipt.source.connectionId,
          capability: receipt.capability,
          acceptedAt: receipt.observedAt,
          records: receipt.records,
          providerRequestId: receipt.providerRequestId,
          adapterVersion: receipt.adapterVersion ?? null,
        };
      }
      const read = row.document;

      return {
        kind: 'read',
        id: read.id,
        provider: read.source.provider,
        connectionId: read.source.connectionId,
        record: {
          resource: read.source.resource,
          externalId: read.source.externalId,
        },
        observedAt: read.observedAt,
        sourceUpdatedAt: read.sourceUpdatedAt,
        sourceRevision: read.sourceRevision,
        adapterVersion: read.adapterVersion,
        completeness: read.completeness,
        data: read.data,
      };
    }),
    ...observations.rows.flatMap((row): PurchaseOrderEvidence[] =>
      row.provider
        ? [
            {
              kind: 'read',
              id: row.id,
              provider: row.provider,
              connectionId: row.connection_id,
              record: {
                resource: 'purchase_order',
                externalId: row.external_id,
              },
              observedAt: row.observed_at.toISOString(),
              sourceUpdatedAt: null,
              sourceRevision: null,
              adapterVersion: null,
              completeness: null,
              data: {
                status: row.document.status,
                orderNumber: row.document.orderNumber,
                confirmed: row.document.confirmed,
                lines: row.document.lines,
              },
            },
          ]
        : [],
    ),
    ...records.rows.map((row) => ({
      kind: 'luma_record' as const,
      id: row.id,
      record: row.record,
    })),
  ];
}
