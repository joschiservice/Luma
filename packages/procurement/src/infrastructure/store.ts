import type { AuditLog } from '@luma/audit';
import type { TenantDatabase } from '@luma/platform';

import type { SupplierFilter, SupplierSort } from '../application/lists.js';
import type { ProcurementStore } from '../application/procurement.js';
import type {
  Commitment,
  FollowUp,
  Submission,
} from '../domain/commitments.js';
import type { PurchaseOrder, Supplier } from '../domain/procurement.js';
import { skuCandidateIdsSql } from '../domain/sku-candidates.js';
import {
  effectiveSupplierTerms,
  type SupplierTermsVersion,
} from '../domain/supplier-terms.js';
import {
  customFieldSql,
  customSortSql,
  readCustomFieldDefinitions,
} from './custom-fields.js';
import {
  type BindParameter,
  likePattern,
  type StoredFieldSql,
  storedWhereSql,
} from './list-sql.js';

/** Matches the supplier name or an external reference system or ID; binds `$2` and `$3`. */
const supplierSearch = `($2='' OR s.document->>'name' ILIKE $3 OR EXISTS(SELECT 1
 FROM jsonb_array_elements(COALESCE(s.document->'externalReferences','[]'::jsonb)) r
 WHERE r->>'system' ILIKE $3 OR r->>'externalId' ILIKE $3))`;

/** Binds parameters after the ones already in `values`. */
const binder =
  (values: unknown[]): BindParameter =>
  (value, cast) => {
    values.push(value);

    return `$${values.length}::${cast}`;
  };

/** The supplier list row's record type and ID, for custom field values. */
const supplierRow = { type: 'supplier', id: 's.id' } as const;

/**
 * Supplier search and catalog conditions over `s`, binding `$2`, `$3` and further values
 * after those already in `values`.
 */
function supplierFilterSql(filter: SupplierFilter, values: unknown[]) {
  const bind = binder(values);
  const fields: Record<string, StoredFieldSql> = {
    ...customFieldSql(
      supplierRow,
      filter.customFields ?? [],
      filter.conditions,
      bind,
    ),
    created: {
      kind: 'value',
      sql: "(s.document->>'createdAt')::timestamptz",
      cast: 'timestamptz',
    },
    hasOpenOrders: {
      kind: 'flag',
      sql: `EXISTS(SELECT 1 FROM procurement_purchase_orders p WHERE p.tenant_id=s.tenant_id
        AND p.supplier_id=s.id AND p.document->>'status'='open')`,
    },
  };
  if (filter.confirmationOverdue)
    fields.confirmationOverdue = {
      kind: 'flag',
      sql: `s.id=ANY(${bind(filter.confirmationOverdue, 'uuid[]')})`,
    };

  return `${supplierSearch} AND ${storedWhereSql(filter.conditions, fields, bind)}`;
}

/** Sort values of supplier `s` with order counts `c`; every supplier has one. */
const supplierSorts = {
  name: { sql: "lower(s.document->>'name')", type: 'text' },
  created: {
    sql: "(s.document->>'createdAt')::timestamptz",
    type: 'timestamptz',
  },
  orders: { sql: 'COALESCE(c.orders,0)', type: 'bigint' },
} as const;

function isNativeSort(sort: string): sort is keyof typeof supplierSorts {
  return Object.hasOwn(supplierSorts, sort);
}

/**
 * The sort value of `s` and its type. Custom fields come from `filter` and may be unset
 * (NULL); every supplier has a value for the other sorts.
 */
function supplierSort(
  sort: SupplierSort,
  filter: SupplierFilter,
  bind: BindParameter,
): { sql: string; type: string; optional: boolean } {
  if (isNativeSort(sort)) return { ...supplierSorts[sort], optional: false };
  const field = filter.customFields?.find(
    (item) => `custom:${item.id}` === sort,
  );
  if (!field) throw new Error('The sorted custom field was not loaded');

  return { ...customSortSql(supplierRow, field, bind), optional: true };
}

/** Persists procurement records and audit in the same tenant transaction. */
export function createProcurementStore(
  db: TenantDatabase,
  audit: (db: TenantDatabase) => AuditLog,
): ProcurementStore {
  return {
    transaction: (tenantId, write, operation) =>
      db.transaction(tenantId, async (tx) => {
        // Readers share a lock so order revisions and audit history cannot straddle a write.
        await tx.query(
          write
            ? 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))'
            : 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',
          [`procurement:${tenantId}`],
        );
        const scoped: TenantDatabase = {
          transaction: async (_tenant, fn) => fn(tx),
        };
        const log = audit(scoped);

        return operation({
          suppliers: async () =>
            (
              await tx.query<{ document: Supplier }>(
                "SELECT document FROM procurement_suppliers WHERE tenant_id=$1 ORDER BY document->>'name',id",
                [tenantId],
              )
            ).rows.map((r) => r.document),
          orders: async () =>
            (
              await tx.query<{ document: PurchaseOrder }>(
                'SELECT document FROM procurement_purchase_orders WHERE tenant_id=$1 ORDER BY created_at DESC,id',
                [tenantId],
              )
            ).rows.map((r) => r.document),
          supplierPage: async (filter, order, limit) => {
            const direction = order.direction === 'asc' ? 'ASC' : 'DESC';
            const op = order.direction === 'asc' ? '>' : '<';
            const values: unknown[] = [
              tenantId,
              filter.q,
              likePattern(filter.q),
              limit,
            ];
            const bind = binder(values);
            const where = supplierFilterSql(filter, values);
            const { sql, type, optional } = supplierSort(
              order.sort,
              filter,
              bind,
            );
            // Suppliers without a value follow all others in both directions, by ID.
            const missing = `(${sql}) IS NULL`;
            let after = 'true';
            if (order.after) {
              const id = bind(order.after.id, 'uuid');
              after =
                order.after.rank === 1
                  ? `(${missing} AND s.id ${op} ${id})`
                  : `${optional ? `(${missing} OR ` : '('}(${sql},s.id) ${op} (${bind(order.after.keys?.[0] ?? null, type)},${id}))`;
            }
            const rows = await tx.query<{
              document: Supplier;
              orders: number;
              key: string | null;
            }>(
              `SELECT s.document,COALESCE(c.orders,0)::int AS orders,(${sql})::text AS key
               FROM procurement_suppliers s
               LEFT JOIN (SELECT supplier_id,count(*) AS orders FROM procurement_purchase_orders
                WHERE tenant_id=$1 GROUP BY supplier_id) c ON c.supplier_id=s.id
               WHERE s.tenant_id=$1 AND ${where} AND ${after}
               ORDER BY ${optional ? `${missing},` : ''}${sql} ${direction},s.id ${direction} LIMIT $4`,
              values,
            );

            return rows.rows.map((row) => ({
              record: { ...row.document, orderCount: row.orders },
              position:
                row.key === null
                  ? { rank: 1, keys: null, id: row.document.id }
                  : { rank: 0, keys: [row.key], id: row.document.id },
            }));
          },
          customFields: (recordType, ids) =>
            readCustomFieldDefinitions(tx, tenantId, recordType, ids),
          countSuppliers: async (filter) => {
            const values: unknown[] = [
              tenantId,
              filter.q,
              likePattern(filter.q),
            ];
            const where = supplierFilterSql(filter, values);

            return (
              await tx.query<{ count: number }>(
                `SELECT count(*)::int AS count FROM procurement_suppliers s WHERE s.tenant_id=$1 AND ${where}`,
                values,
              )
            ).rows[0]!.count;
          },
          supplier: async (id) =>
            (
              await tx.query<{ document: Supplier }>(
                'SELECT document FROM procurement_suppliers WHERE tenant_id=$1 AND id=$2',
                [tenantId, id],
              )
            ).rows[0]?.document ?? null,
          order: async (id) =>
            (
              await tx.query<{ document: PurchaseOrder }>(
                'SELECT document FROM procurement_purchase_orders WHERE tenant_id=$1 AND id=$2',
                [tenantId, id],
              )
            ).rows[0]?.document ?? null,
          shortfallState: async (orderId) => {
            const order = (
              await tx.query<{ document: PurchaseOrder }>(
                'SELECT document FROM procurement_purchase_orders WHERE tenant_id=$1 AND id=$2',
                [tenantId, orderId],
              )
            ).rows[0]?.document;
            if (!order) return null;
            const commitments = (
              await tx.query<{ document: Commitment }>(
                'SELECT document FROM procurement_commitments WHERE tenant_id=$1 AND purchase_order_id=$2 ORDER BY recorded_at,id',
                [tenantId, orderId],
              )
            ).rows.map((row) => row.document);
            const followUps = (
              await tx.query<{ document: FollowUp }>(
                'SELECT document FROM procurement_follow_ups WHERE tenant_id=$1 AND purchase_order_id=$2 ORDER BY responded_at,id',
                [tenantId, orderId],
              )
            ).rows.map((row) => row.document);
            const submission =
              (
                await tx.query<{ document: Submission }>(
                  'SELECT document FROM procurement_submissions WHERE tenant_id=$1 AND purchase_order_id=$2 ORDER BY created_at DESC,id LIMIT 1',
                  [tenantId, orderId],
                )
              ).rows[0]?.document ?? null;

            return { order, commitments, followUps, submission };
          },
          submittedNativeOrder: async (orderId) =>
            (
              await tx.query(
                "SELECT 1 FROM procurement_submissions WHERE tenant_id=$1 AND purchase_order_id=$2 AND COALESCE(document->>'channel','purchasing_system')='purchasing_system' AND state IN ('submitting','uncertain','submitted') LIMIT 1",
                [tenantId, orderId],
              )
            ).rows.length > 0,
          pendingOrderChange: async (orderId) =>
            (
              await tx.query(
                "SELECT 1 FROM procurement_order_changes WHERE tenant_id=$1 AND purchase_order_id=$2 AND state IN ('preparing','approval_required','approved','submitting','uncertain') LIMIT 1",
                [tenantId, orderId],
              )
            ).rows.length > 0,
          termSnapshots: async (supplierId, sku) => {
            const rows = (
              await tx.query<{ document: SupplierTermsVersion }>(
                `WITH candidates AS (SELECT e.id AS sku_id FROM inventory_entities e WHERE e.tenant_id=$1 AND e.kind='sku' AND e.id IN (${skuCandidateIdsSql('$1', '$3::text')}))
               SELECT t.document FROM procurement_supplier_terms t JOIN candidates c ON c.sku_id=t.sku_id
               WHERE t.tenant_id=$1 AND t.supplier_id=$2 AND (SELECT count(*) FROM candidates)=1 ORDER BY t.revision`,
                [tenantId, supplierId, sku],
              )
            ).rows;
            const values = effectiveSupplierTerms(
              rows.map((row) => row.document),
              new Date().toISOString().slice(0, 10),
            ).effective;

            return {
              ...(values.unitPrice?.currency
                ? {
                    unitPrice: {
                      amount: values.unitPrice.amount,
                      currency: values.unitPrice.currency,
                    },
                  }
                : {}),
              ...(values.supplierArticleNumber
                ? { supplierArticleNumber: values.supplierArticleNumber }
                : {}),
            };
          },
          updateSupplier: async (s) => {
            await tx.query(
              'UPDATE procurement_suppliers SET document=$3 WHERE tenant_id=$1 AND id=$2',
              [tenantId, s.id, s],
            );
          },
          insertSupplier: async (s) => {
            await tx.query(
              'INSERT INTO procurement_suppliers(tenant_id,id,document) VALUES($1,$2,$3)',
              [tenantId, s.id, s],
            );
          },
          insertOrder: async (o) => {
            await tx.query(
              'INSERT INTO procurement_purchase_orders(tenant_id,id,supplier_id,document,created_at) VALUES($1,$2,$3,$4,$5)',
              [tenantId, o.id, o.supplierId, o, o.createdAt],
            );
          },
          updateOrder: async (o) => {
            await tx.query(
              `UPDATE procurement_purchase_orders SET document=jsonb_set(jsonb_set(jsonb_set(document,'{status}',$3::jsonb),'{revision}',$4::jsonb),'{updatedAt}',$5::jsonb) WHERE tenant_id=$1 AND id=$2`,
              [
                tenantId,
                o.id,
                JSON.stringify(o.status),
                JSON.stringify(o.revision),
                JSON.stringify(o.updatedAt),
              ],
            );
          },
          command: async (id) =>
            (
              await tx.query<{
                digest: string;
                result: PurchaseOrder | Supplier;
              }>(
                'SELECT digest,result FROM procurement_commands WHERE tenant_id=$1 AND id=$2',
                [tenantId, id],
              )
            ).rows[0] ?? null,
          saveCommand: async (id, digest, result) => {
            await tx.query(
              'INSERT INTO procurement_commands(tenant_id,id,digest,result) VALUES($1,$2,$3,$4)',
              [tenantId, id, digest, result],
            );
          },
          audit: (entry) => log.append(entry),
          history: async (id) =>
            (await log.list(tenantId, id))
              .filter((e) =>
                [
                  'purchase_order.created',
                  'purchase_order.status_changed',
                  'purchase_order.revised',
                ].includes(e.eventType),
              )
              .map((e) => ({
                id: e.id,
                commandId: e.details.commandId,
                occurredAt: e.occurredAt,
                actorId: e.actor.id,
                from: (e.details.from || null) as
                  PurchaseOrder['status'] | null,
                to: e.details.to as PurchaseOrder['status'],
                revision: Number(e.details.revision),
                reason: e.details.reason!,
              }))
              .sort((a, b) => a.revision - b.revision),
        });
      }),
  };
}
