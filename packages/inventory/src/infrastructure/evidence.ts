import type { SqlTransaction } from '@luma/platform';

/** A stored inventory read or ledger record, in the shape the evidence view reads. */
type InventoryEvidence =
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
      completeness: null;
      data: unknown;
    }
  | {
      kind: 'luma_record';
      id: string;
      record:
        'stock_receipt_review' | 'ledger_entry' | 'stock_ownership_change';
      at: string | null;
      actorId: string | null;
      detail:
        | {
            kind: 'stock_receipt_review';
            state: 'pending' | 'approved' | 'rejected';
            quantity: string | null;
            unit: string | null;
          }
        | {
            kind: 'ledger_entry';
            purpose: string;
            reversed: boolean;
            postings: {
              state: string;
              unit: string;
              quantity: string;
              balanceAfter: string;
              version: number;
            }[];
          }
        | null;
    };

/** Purchase receipt reviews in scope: those of an order, or one review. */
type ReceiptScope = { purchaseOrderId: string } | { reviewId: string };

/** Ledger quantities as stored, without trailing zeros: `12.500000` reads as `12.5`. */
function quantity(value: string) {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

/**
 * Finds the stored provider reads of stock positions with these observation IDs: the immutable
 * snapshot the read produced, with the source record, read and source-update times, revision and
 * adapter version of the observation behind it. Callers pass only IDs a record cites. The
 * normalized stock (available, reserved, unit) is returned for the evidence view's allowlist.
 */
export async function stockReadEvidence(
  tx: SqlTransaction,
  tenantId: string,
  ids: string[],
): Promise<InventoryEvidence[]> {
  if (!ids.length) return [];
  const { rows } = await tx.query<{
    id: string;
    connection_id: string;
    provider: string | null;
    resource: string | null;
    external_id: string | null;
    observed_at: Date;
    source_updated_at: Date | null;
    source_revision: string | null;
    adapter_version: string | null;
    data: unknown;
  }>(
    `SELECT DISTINCT ON (s.observation_id) s.observation_id::text AS id,s.connection_id::text,
      COALESCE(o.document->'observation'->'source'->>'provider',c.document->>'provider',c.document->'target'->>'kind') AS provider,
      o.document->'observation'->'source'->>'resource' AS resource,
      o.document->'observation'->'source'->>'externalId' AS external_id,
      s.observed_at,s.source_updated_at,o.document->'observation'->>'sourceRevision' AS source_revision,
      COALESCE(o.document->'observation'->>'adapterVersion',s.normalizer_version) AS adapter_version,
      s.document->'data' AS data
     FROM inventory_snapshots s
     LEFT JOIN connector_observations o ON o.tenant_id=s.tenant_id AND o.connection_id=s.connection_id AND o.id=s.observation_id
     LEFT JOIN connector_installations c ON c.tenant_id=s.tenant_id AND c.id=s.connection_id
     WHERE s.tenant_id=$1 AND s.kind='position' AND s.observation_id=ANY($2::uuid[])
     ORDER BY s.observation_id,s.created_at DESC`,
    [tenantId, ids],
  );

  return rows.flatMap((row): InventoryEvidence[] =>
    row.provider
      ? [
          {
            kind: 'read',
            id: row.id,
            provider: row.provider,
            connectionId: row.connection_id,
            record:
              row.resource && row.external_id
                ? { resource: row.resource, externalId: row.external_id }
                : null,
            observedAt: row.observed_at.toISOString(),
            sourceUpdatedAt: row.source_updated_at?.toISOString() ?? null,
            sourceRevision: row.source_revision,
            adapterVersion: row.adapter_version,
            // Snapshots record one position each; Luma doesn't record a scan's completeness.
            completeness: null,
            data: row.data,
          },
        ]
      : [],
  );
}

/**
 * Finds committed stock ledger entries and stock ownership changes with these IDs: each entry
 * with its purpose, actor, recording time, whether it was reversed, and what it posted to each
 * account with the balance and version after. Callers pass only IDs a record cites.
 */
export async function ledgerEvidence(
  tx: SqlTransaction,
  tenantId: string,
  ids: string[],
): Promise<InventoryEvidence[]> {
  if (!ids.length) return [];
  const entries = await tx.query<{
    id: string;
    purpose: string;
    actor_id: string;
    recorded_at: Date;
    reversed: boolean;
    postings: {
      state: string;
      unit: string;
      quantity: string;
      balanceAfter: string;
      version: number;
    }[];
  }>(
    `SELECT e.id::text,e.purpose,e.actor_id,e.recorded_at,
      EXISTS(SELECT 1 FROM inventory_ledger_entries r WHERE r.tenant_id=e.tenant_id AND r.reversal_of=e.id) AS reversed,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('state',a.state,'unit',p.unit,'quantity',p.quantity::text,
          'balanceAfter',p.balance_after::text,'version',p.account_version) ORDER BY a.state,p.account_id)
        FROM inventory_ledger_postings p JOIN inventory_ledger_accounts a ON a.tenant_id=p.tenant_id AND a.id=p.account_id
        WHERE p.tenant_id=e.tenant_id AND p.entry_id=e.id),'[]'::jsonb) AS postings
     FROM inventory_ledger_entries e WHERE e.tenant_id=$1 AND e.id=ANY($2::uuid[])`,
    [tenantId, ids],
  );
  const transitions = await tx.query<{
    id: string;
    reviewer_id: string;
    recorded_at: Date;
  }>(
    `SELECT id::text,reviewer_id,recorded_at FROM inventory_stock_ownership_transitions
     WHERE tenant_id=$1 AND id=ANY($2::uuid[])`,
    [tenantId, ids],
  );

  return [
    ...entries.rows.map((row): InventoryEvidence => ({
      kind: 'luma_record',
      id: row.id,
      record: 'ledger_entry',
      at: row.recorded_at.toISOString(),
      actorId: row.actor_id,
      detail: {
        kind: 'ledger_entry',
        purpose: row.purpose,
        reversed: row.reversed,
        postings: row.postings.slice(0, 20).map((posting) => ({
          ...posting,
          quantity: quantity(posting.quantity),
          balanceAfter: quantity(posting.balanceAfter),
          version: Number(posting.version),
        })),
      },
    })),
    ...transitions.rows.map((row): InventoryEvidence => ({
      kind: 'luma_record',
      id: row.id,
      record: 'stock_ownership_change',
      at: row.recorded_at.toISOString(),
      actorId: row.reviewer_id,
      detail: null,
    })),
  ];
}

const receiptScope = (scope: ReceiptScope) =>
  'reviewId' in scope
    ? { sql: 'r.id=$2::uuid', value: scope.reviewId }
    : {
        sql: "r.command_document->'purchaseReceipt'->>'purchaseOrderId'=$2::text",
        value: scope.purchaseOrderId,
      };

/**
 * Reads what a native stock receipt review cites, for the evidence view: the review, the
 * supplier commitments it books and the ledger entry that booked it, if any. Returns null when
 * the tenant has no such purchase receipt review.
 */
export async function purchaseReceiptCitations(
  tx: SqlTransaction,
  tenantId: string,
  reviewId: string,
): Promise<{
  purchaseOrderId: string;
  citations: {
    ref: string;
    citedAs: 'record';
    citedAt: string;
  }[];
} | null> {
  const row = (
    await tx.query<{
      purchase_order_id: string;
      commitment_id: string | null;
      damaged_commitment_id: string | null;
      entry_id: string | null;
      created_at: Date;
      reviewed_at: Date | null;
    }>(
      `SELECT r.command_document->'purchaseReceipt'->>'purchaseOrderId' AS purchase_order_id,
        r.command_document->'purchaseReceipt'->>'commitmentId' AS commitment_id,
        r.command_document->'purchaseReceipt'->>'damagedCommitmentId' AS damaged_commitment_id,
        (SELECT e.id::text FROM inventory_ledger_entries e WHERE e.tenant_id=r.tenant_id
          AND (e.review_id=r.id OR e.command_key=r.command_key) LIMIT 1) AS entry_id,
        r.created_at,r.reviewed_at
       FROM inventory_ledger_reviews r
       WHERE r.tenant_id=$1 AND r.id=$2::uuid AND r.command_document ? 'purchaseReceipt'`,
      [tenantId, reviewId],
    )
  ).rows[0];
  if (!row) return null;
  const citedAt = row.created_at.toISOString();

  return {
    purchaseOrderId: row.purchase_order_id,
    citations: [
      reviewId,
      row.commitment_id,
      row.damaged_commitment_id,
      row.entry_id,
    ]
      .filter((ref): ref is string => !!ref)
      .map((ref) => ({
        ref,
        citedAs: 'record' as const,
        citedAt:
          ref === row.entry_id
            ? (row.reviewed_at?.toISOString() ?? citedAt)
            : citedAt,
      })),
  };
}

/**
 * Finds native stock receipt reviews in scope and the ledger entries that booked them among the
 * references: each review with its state, booked quantity, reviewer or preparer and time, and
 * each entry with its postings. Every query is scoped to the order's or the one review's
 * receipts, so a reference to another receipt resolves to nothing.
 */
export async function purchaseReceiptEvidence(
  tx: SqlTransaction,
  tenantId: string,
  scope: ReceiptScope,
  uuids: string[],
): Promise<InventoryEvidence[]> {
  if (!uuids.length) return [];
  const where = receiptScope(scope);
  const reviews = await tx.query<{
    id: string;
    state: 'pending' | 'approved' | 'rejected';
    actor_id: string;
    at: Date;
    quantity: string | null;
    unit: string | null;
  }>(
    `SELECT r.id::text,r.state,COALESCE(r.reviewed_by,r.prepared_by) AS actor_id,COALESCE(r.reviewed_at,r.created_at) AS at,
      r.command_document->'purchaseReceipt'->>'cumulativeGood' AS quantity,
      (SELECT p->'account'->>'unit' FROM jsonb_array_elements(r.command_document->'postings') p
        WHERE p->'account'->>'state'='available' LIMIT 1) AS unit
     FROM inventory_ledger_reviews r
     WHERE r.tenant_id=$1 AND ${where.sql} AND r.command_document ? 'purchaseReceipt' AND r.id=ANY($3::uuid[])`,
    [tenantId, where.value, uuids],
  );
  const entries = await tx.query<{ id: string }>(
    `SELECT e.id::text FROM inventory_ledger_reviews r
     JOIN inventory_ledger_entries e ON e.tenant_id=r.tenant_id AND (e.review_id=r.id OR e.command_key=r.command_key)
     WHERE r.tenant_id=$1 AND ${where.sql} AND r.command_document ? 'purchaseReceipt' AND e.id=ANY($3::uuid[])`,
    [tenantId, where.value, uuids],
  );

  return [
    ...reviews.rows.map((row): InventoryEvidence => ({
      kind: 'luma_record',
      id: row.id,
      record: 'stock_receipt_review',
      at: row.at.toISOString(),
      actorId: row.actor_id,
      detail: {
        kind: 'stock_receipt_review',
        state: row.state,
        quantity: row.quantity === null ? null : quantity(row.quantity),
        unit: row.unit,
      },
    })),
    ...(await ledgerEvidence(
      tx,
      tenantId,
      entries.rows.map((row) => row.id),
    )),
  ];
}
