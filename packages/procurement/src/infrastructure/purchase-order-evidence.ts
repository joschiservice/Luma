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
        | 'approval';
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

/**
 * Reads what a purchase order cites, for the evidence view: the purchasing actions whose
 * execution attempts belong to it and the reads its verified revisions cite. With `stock`, for
 * readers with inventory access, also the stock bookings of its receipts. Returns null when the
 * tenant has no such order.
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

  return {
    actionIds: actions.rows.map((row) => row.id),
    citations: revisions.rows.flatMap((row) =>
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
  };
}

/**
 * Finds the purchasing-system reads and write receipts procurement stored for this order, and
 * the procurement and policy records of the order that the references name. Every query is
 * scoped to the order, so a reference from another order resolves to nothing.
 */
export async function purchaseOrderEvidence(
  tx: SqlTransaction,
  tenantId: string,
  purchaseOrderId: string,
  refs: { uuids: string[] },
): Promise<PurchaseOrderEvidence[]> {
  if (!refs.uuids.length) return [];
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
    `WITH actions AS (${orderActions})
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
      WHERE tenant_id=$1 AND id=ANY($3::uuid[]) AND proposal_id IN (SELECT id FROM actions)`,
    [tenantId, purchaseOrderId, refs.uuids],
  );

  return [
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
