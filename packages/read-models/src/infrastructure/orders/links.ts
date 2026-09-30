import type { SqlTransaction } from '@luma/platform';

import type { OrderDetail } from '../../application/orders.js';
import { iso } from './values.js';

// Each lookup starts from the order's own identities and reaches linked records through the
// generated subject and target columns (migration 0039), so its cost follows the order's
// links rather than table size. Keep conditions on those plain columns: row security stops
// PostgreSQL from using indexes on JSON expressions.

/** Identities that other records use to refer to one order. */
export interface OrderReferences {
  orderId: string;
  /** The Luma order ID followed by every source order ID. */
  orderRefs: string[];
  fulfillmentIds: string[];
  skuIds: string[];
}

/** Lists Resolution runs targeting the order and trigger runs whose subject is the order. */
export async function readDirectRunIds(
  tx: SqlTransaction,
  tenantId: string,
  refs: OrderReferences,
) {
  const result = await tx.query<{ id: string }>(
    `SELECT id::text FROM playbook_runs WHERE tenant_id=$1 AND target_kind='order' AND target_id=ANY($2)
     UNION SELECT id::text FROM workflow_trigger_runs WHERE tenant_id=$1
      AND subject_kind='order' AND subject_id=ANY($2)`,
    [tenantId, refs.orderRefs],
  );

  return result.rows.map((row) => row.id);
}

/**
 * Lists up to 50 issues about the order, its fulfillments, its ordered SKUs or its workflow
 * runs. Issues may name a record by Luma ID or by source ID within a connection scope.
 */
export async function readIssues(
  tx: SqlTransaction,
  tenantId: string,
  refs: OrderReferences,
  runIds: string[],
  needsYou: Set<string>,
): Promise<OrderDetail['issues']> {
  const result = await tx.query<{
    id: string;
    class: string | null;
    state: string;
    severity: string | null;
    lastDetectedAt: string | null;
    subjectKind: string;
  }>(
    `WITH subjects(kind,subject_id,scope) AS (
      SELECT 'order',$2::text,NULL::text
      UNION ALL SELECT 'order',m.external_id,m.connection_id::text FROM connector_source_mappings m
       WHERE m.tenant_id=$1 AND m.resource='order' AND m.canonical_id=$2::uuid
      UNION ALL SELECT 'fulfillment',m.external_id,m.connection_id::text FROM connector_source_mappings m
       WHERE m.tenant_id=$1 AND m.resource='fulfillment' AND m.scope_key='' AND m.canonical_id=ANY($3::uuid[])
      UNION ALL SELECT 'sku',id,NULL FROM unnest($4::text[]) id
      UNION ALL SELECT 'sku',m.external_id,NULL FROM connector_source_mappings m
       WHERE m.tenant_id=$1 AND m.resource='sku' AND m.canonical_id=ANY($4::uuid[])
      UNION ALL SELECT 'workflow_run',id,NULL FROM unnest($5::text[]) id
     ), linked AS (
      SELECT DISTINCT e.id FROM subjects JOIN exceptions e ON e.tenant_id=$1
       AND e.subject_kind=subjects.kind AND e.subject_id=subjects.subject_id
       AND (subjects.scope IS NULL OR e.document->'subject'->'scope'->>0=subjects.scope)
     )
     SELECT e.id,e.document->>'exceptionClass' AS class,e.state,e.document->>'severity' AS severity,
     e.document->>'lastDetectedAt' AS "lastDetectedAt",e.subject_kind AS "subjectKind"
     FROM linked JOIN exceptions e ON e.tenant_id=$1 AND e.id=linked.id
     ORDER BY e.state='resolved',e.document->>'lastDetectedAt' DESC,e.id LIMIT 50`,
    [tenantId, refs.orderId, refs.fulfillmentIds, refs.skuIds, runIds],
  );

  return result.rows.map((row) => ({
    id: row.id,
    class: row.class ?? 'unknown',
    state: row.state,
    severity: row.severity,
    relationship:
      row.subjectKind === 'sku'
        ? 'sku'
        : row.subjectKind === 'order'
          ? 'order'
          : 'fulfillment',
    needsYou: needsYou.has(row.id),
    lastDetectedAt: iso(row.lastDetectedAt),
  }));
}

/** Lists up to 50 workflow runs about the order or one of its issues, newest first. */
export async function readWorkflowRuns(
  tx: SqlTransaction,
  tenantId: string,
  refs: OrderReferences,
  issueIds: string[],
): Promise<OrderDetail['workflows']> {
  const result = await tx.query<{
    id: string;
    definitionId: string;
    name: string | null;
    version: string;
    createdAt: string | null;
    state: string;
    relationship: 'order' | 'issue';
  }>(
    `WITH direct AS (
      SELECT id FROM playbook_runs WHERE tenant_id=$1 AND target_kind='order' AND target_id=ANY($2)
     ), via_issue AS (
      SELECT id FROM playbook_runs WHERE tenant_id=$1 AND incident_id=ANY($3)
     )
     SELECT * FROM (
      SELECT r.id,r.definition_id AS "definitionId",d.document->>'name' AS name,r.version,
      r.document->>'createdAt' AS "createdAt",COALESCE(o.document->>'state','recorded') AS state,
      CASE WHEN r.id IN (SELECT id FROM direct) THEN 'order' ELSE 'issue' END AS relationship
      FROM playbook_runs r
      LEFT JOIN playbook_definitions d ON d.tenant_id=r.tenant_id AND d.id=r.definition_id
      LEFT JOIN LATERAL (SELECT document FROM playbook_outcomes WHERE tenant_id=r.tenant_id AND run_id=r.id
       ORDER BY sequence DESC LIMIT 1) o ON true
      WHERE r.tenant_id=$1 AND r.id IN (SELECT id FROM direct UNION SELECT id FROM via_issue)
      UNION ALL
      SELECT w.id,w.definition_id,d.document->>'name',w.version,
      COALESCE(w.document->>'createdAt',w.triggered_at::text),w.state,'order'
      FROM workflow_trigger_runs w
      LEFT JOIN playbook_definitions d ON d.tenant_id=w.tenant_id AND d.id=w.definition_id
      WHERE w.tenant_id=$1 AND w.subject_kind='order' AND w.subject_id=ANY($2)
     ) runs ORDER BY "createdAt" DESC NULLS LAST,id LIMIT 50`,
    [tenantId, refs.orderRefs, issueIds],
  );

  return result.rows.map((row) => ({ ...row, createdAt: iso(row.createdAt) }));
}

/**
 * Lists up to 100 observed snapshots of the order and its fulfillments, returns and refunds,
 * newest first. Refunds have no status; they are reported as `recorded`.
 */
export async function readHistory(
  tx: SqlTransaction,
  tenantId: string,
  orderId: string,
): Promise<OrderDetail['history']> {
  const result = await tx.query<{
    snapshotId: string;
    entityKind: 'order' | 'fulfillment' | 'return' | 'refund';
    entityId: string;
    connectionId: string;
    status: string | null;
    paymentStatus: string | null;
    deleted: boolean;
    current: boolean;
    observedAt: Date;
    sourceUpdatedAt: Date | null;
  }>(
    `SELECT s.id AS "snapshotId",s.kind AS "entityKind",s.entity_id AS "entityId",s.connection_id AS "connectionId",
     s.status,s.payment_status AS "paymentStatus",(s.document->>'deleted')::boolean AS deleted,
     EXISTS (SELECT 1 FROM orders_projections p WHERE p.tenant_id=s.tenant_id AND p.entity_id=s.entity_id
      AND p.connection_id=s.connection_id AND p.snapshot_id=s.id) AS current,
     s.observed_at AS "observedAt",s.source_updated_at AS "sourceUpdatedAt"
     FROM orders_snapshots s
     WHERE s.tenant_id=$1 AND (s.entity_id=$2 OR s.entity_id IN (
      SELECT child_id FROM orders_relationships WHERE tenant_id=$1 AND order_id=$2))
     ORDER BY s.observed_at DESC,s.created_at DESC,s.id DESC LIMIT 101`,
    [tenantId, orderId],
  );

  return {
    entries: result.rows.slice(0, 100).map((row) => ({
      ...row,
      status:
        row.status ?? (row.entityKind === 'refund' ? 'recorded' : 'unknown'),
      observedAt: row.observedAt.toISOString(),
      sourceUpdatedAt: iso(row.sourceUpdatedAt),
    })),
    truncated: result.rows.length > 100,
  };
}
