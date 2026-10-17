import type { AuditLog } from '@luma/audit';
import type { TenantDatabase } from '@luma/platform';

import type { CommitmentStore } from '../application/commitments.js';
import type {
  PurchaseOrderFilter,
  StoredPurchaseOrderSort,
} from '../application/lists.js';
import type { ProcurementEvent } from '../application/procurement.js';
import type {
  Commitment,
  Communication,
  Extraction,
  FollowUp,
  PurchasingObservation,
  Submission,
} from '../domain/commitments.js';
import type { PurchaseOrder, Supplier } from '../domain/procurement.js';
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
import { insertPurchasingRead } from './purchasing-reads.js';
import { readPurchasingActionTimeline } from './purchasing-timeline.js';

const live = ['approved', 'submitting', 'uncertain', 'submitted'];

/** Search, supplier, status and ID predicates over `o`; binds `$2` to `$6`. */
const orderFilterSql = `($2='' OR o.document->>'reference' ILIKE $3 OR o.document->>'supplierName' ILIKE $3
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(o.document->'lines') l WHERE l->>'sku' ILIKE $3))
 AND ($4::uuid IS NULL OR o.supplier_id=$4) AND ($5::text IS NULL OR o.document->>'status'=$5)
 AND ($6::uuid[] IS NULL OR o.id=ANY($6::uuid[]))`;

const orderFilterValues = (filter: PurchaseOrderFilter) => [
  filter.q,
  likePattern(filter.q),
  filter.supplierId ?? null,
  filter.status ?? null,
  filter.ids ?? null,
];

const lines = "o.document->'lines'";

/** Stored purchase-order list fields of `o`, for catalog conditions. */
const orderFields: Readonly<Record<string, StoredFieldSql>> = {
  reference: { kind: 'value', sql: "o.document->>'reference'", cast: 'text' },
  supplier: { kind: 'value', sql: 'o.supplier_id', cast: 'uuid' },
  status: { kind: 'value', sql: "o.document->>'status'", cast: 'text' },
  authority: { kind: 'value', sql: "o.document->>'authority'", cast: 'text' },
  created: { kind: 'value', sql: 'o.created_at', cast: 'timestamptz' },
  updated: {
    kind: 'value',
    sql: "(o.document->>'updatedAt')::timestamptz",
    cast: 'timestamptz',
  },
  sku: { kind: 'lines', from: lines, sql: "l->>'sku'" },
  location: { kind: 'lines', from: lines, sql: "lower(l->>'locationId')" },
};

/** Binds parameters after the ones already in `values`. */
const binder =
  (values: unknown[]): BindParameter =>
  (value, cast) => {
    values.push(value);

    return `$${values.length}::${cast}`;
  };

/** Sort values of `o`; every order has one. */
const orderSorts = {
  created: { sql: 'o.created_at', type: 'timestamptz' },
  updated: {
    sql: "(o.document->>'updatedAt')::timestamptz",
    type: 'timestamptz',
  },
  reference: { sql: "lower(o.document->>'reference')", type: 'text' },
  supplier: { sql: "lower(o.document->>'supplierName')", type: 'text' },
} as const;

function isNativeSort(sort: string): sort is keyof typeof orderSorts {
  return Object.hasOwn(orderSorts, sort);
}

/** Catalog and custom list fields of `o` for `filter`, binding custom field IDs. */
function orderFieldsFor(
  filter: PurchaseOrderFilter,
  bind: BindParameter,
): Readonly<Record<string, StoredFieldSql>> {
  return filter.customFields?.length
    ? {
        ...orderFields,
        ...customFieldSql(
          { type: 'purchase_order', id: 'o.id' },
          filter.customFields,
          filter.conditions,
          bind,
        ),
      }
    : orderFields;
}

/**
 * The sort value of `o` and its type. Custom fields come from `filter` and may be unset
 * (NULL); every order has a value for the other sorts.
 */
function orderSort(
  sort: StoredPurchaseOrderSort,
  filter: PurchaseOrderFilter,
  bind: BindParameter,
): { sql: string; type: string; optional: boolean } {
  if (isNativeSort(sort)) return { ...orderSorts[sort], optional: false };
  const field = filter.customFields?.find(
    (item) => `custom:${item.id}` === sort,
  );
  if (!field) throw new Error('The sorted custom field was not loaded');

  return {
    ...customSortSql({ type: 'purchase_order', id: 'o.id' }, field, bind),
    optional: true,
  };
}

/** Persists supplier commitments with procurement records and audit in one tenant transaction. */
export function createCommitmentStore(
  db: TenantDatabase,
  audit: (db: TenantDatabase) => AuditLog,
  observed?: (
    db: TenantDatabase,
    observation: PurchasingObservation,
  ) => Promise<void>,
): CommitmentStore {
  return {
    transaction: (tenantId, write, operation) =>
      db.transaction(tenantId, async (tx) => {
        // The same lock as procurement records keeps orders, submissions and audit consistent.
        await tx.query(
          write
            ? 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))'
            : 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',
          [`procurement:${tenantId}`],
        );
        const log = audit({ transaction: async (_tenant, fn) => fn(tx) });
        const documents = async <T>(sql: string, params: unknown[]) =>
          (await tx.query<{ document: T }>(sql, params)).rows.map(
            (r) => r.document,
          );

        return operation({
          order: async (id) =>
            (
              await documents<PurchaseOrder>(
                'SELECT document FROM procurement_purchase_orders WHERE tenant_id=$1 AND id=$2',
                [tenantId, id],
              )
            )[0] ?? null,
          orders: () =>
            documents<PurchaseOrder>(
              'SELECT document FROM procurement_purchase_orders WHERE tenant_id=$1 ORDER BY created_at DESC,id',
              [tenantId],
            ),
          purchaseOrders: async (filter, order, limit) => {
            const values: unknown[] = [tenantId, ...orderFilterValues(filter)];
            const bind = binder(values);
            const conditions = storedWhereSql(
              filter.conditions,
              orderFieldsFor(filter, bind),
              bind,
            );
            let sort = 'o.created_at DESC,o.id';
            let after = 'true';
            let key = 'NULL::text';
            if (order) {
              const { sql, type, optional } = orderSort(
                order.sort,
                filter,
                bind,
              );
              const direction = order.direction === 'asc' ? 'ASC' : 'DESC';
              const op = order.direction === 'asc' ? '>' : '<';
              // Orders without a value follow all others in both directions, by ID.
              const missing = `(${sql}) IS NULL`;
              sort = `${optional ? `${missing},` : ''}${sql} ${direction},o.id ${direction}`;
              key = `(${sql})::text`;
              if (order.after) {
                const id = bind(order.after.id, 'uuid');
                after =
                  order.after.rank === 1
                    ? `(${missing} AND o.id ${op} ${id})`
                    : `${optional ? `(${missing} OR ` : '('}(${sql},o.id) ${op} (${bind(order.after.keys?.[0] ?? null, type)},${id}))`;
              }
            }
            if (limit !== null) values.push(limit);
            const rows = await tx.query<{
              document: PurchaseOrder;
              key: string | null;
            }>(
              `SELECT o.document,${key} AS key FROM procurement_purchase_orders o
               WHERE o.tenant_id=$1 AND ${orderFilterSql} AND ${conditions} AND ${after}
               ORDER BY ${sort}${limit === null ? '' : ` LIMIT $${values.length}`}`,
              values,
            );

            return rows.rows.map((row) => ({
              record: row.document,
              position:
                order && row.key === null
                  ? { rank: 1, keys: null, id: row.document.id }
                  : {
                      rank: 0,
                      keys: row.key === null ? null : [row.key],
                      id: row.document.id,
                    },
            }));
          },
          customFields: (recordType, ids) =>
            readCustomFieldDefinitions(tx, tenantId, recordType, ids),
          countPurchaseOrders: async (filter) => {
            const values: unknown[] = [tenantId, ...orderFilterValues(filter)];
            const bind = binder(values);
            const conditions = storedWhereSql(
              filter.conditions,
              orderFieldsFor(filter, bind),
              bind,
            );

            return (
              await tx.query<{ count: number }>(
                `SELECT count(*)::int AS count FROM procurement_purchase_orders o
                 WHERE o.tenant_id=$1 AND ${orderFilterSql} AND ${conditions}`,
                values,
              )
            ).rows[0]!.count;
          },
          supplier: async (id) =>
            (
              await documents<Supplier>(
                'SELECT document FROM procurement_suppliers WHERE tenant_id=$1 AND id=$2',
                [tenantId, id],
              )
            )[0] ?? null,
          updateSupplier: async (supplier) => {
            await tx.query(
              'UPDATE procurement_suppliers SET document=$3 WHERE tenant_id=$1 AND id=$2',
              [tenantId, supplier.id, supplier],
            );
          },
          timeline: (id, includeStock) =>
            readPurchasingActionTimeline(tx, tenantId, id, includeStock),
          history: async (id) =>
            (await log.list(tenantId, id))
              .filter((e) =>
                [
                  'purchase_order.created',
                  'purchase_order.status_changed',
                  'purchase_order.revised',
                ].includes(e.eventType),
              )
              .map((e): ProcurementEvent => ({
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
          submissions: (ids) =>
            documents<Submission>(
              `SELECT document FROM procurement_submissions WHERE tenant_id=$1
               AND ($2::uuid[] IS NULL OR purchase_order_id=ANY($2::uuid[])) ORDER BY created_at DESC,id DESC`,
              [tenantId, ids ?? null],
            ),
          submission: async (id) =>
            (
              await documents<Submission>(
                'SELECT document FROM procurement_submissions WHERE tenant_id=$1 AND id=$2',
                [tenantId, id],
              )
            )[0] ?? null,
          insertSubmission: async (s) => {
            await tx.query(
              `INSERT INTO procurement_submissions(tenant_id,id,purchase_order_id,connection_id,state,principal_id,document,created_at)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
              [
                tenantId,
                s.id,
                s.purchaseOrderId,
                s.connectionId,
                s.state,
                s.requestedBy,
                s,
                s.requestedAt,
              ],
            );
          },
          saveSubmission: async (s, settled) => {
            await tx.query(
              'UPDATE procurement_submissions SET state=$3,settled=$4,document=$5 WHERE tenant_id=$1 AND id=$2',
              [tenantId, s.id, s.state, settled, s],
            );
          },
          liveSubmissions: (principalId) =>
            documents<Submission>(
              `SELECT document FROM procurement_submissions WHERE tenant_id=$1 AND principal_id=$2
               AND NOT settled AND state=ANY($3::text[]) ORDER BY created_at,id`,
              [tenantId, principalId, live],
            ),
          communications: ({ orderIds, supplierId }) =>
            documents<Communication>(
              `SELECT document FROM procurement_communications WHERE tenant_id=$1
               AND ($2::uuid[] IS NULL OR purchase_order_id=ANY($2::uuid[]))
               AND ($3::uuid IS NULL OR supplier_id=$3) ORDER BY received_at DESC,id`,
              [tenantId, orderIds ?? null, supplierId ?? null],
            ),
          communication: async (id) =>
            (
              await documents<Communication>(
                'SELECT document FROM procurement_communications WHERE tenant_id=$1 AND id=$2',
                [tenantId, id],
              )
            )[0] ?? null,
          communicationByKey: async (key) =>
            (
              await documents<Communication>(
                'SELECT document FROM procurement_communications WHERE tenant_id=$1 AND message_key=$2',
                [tenantId, key],
              )
            )[0] ?? null,
          insertCommunication: async (c, key) => {
            await tx.query(
              `INSERT INTO procurement_communications(tenant_id,id,supplier_id,purchase_order_id,message_key,document,received_at,retain_until,created_at)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [
                tenantId,
                c.id,
                c.supplierId,
                c.purchaseOrderId,
                key,
                c,
                c.receivedAt,
                c.retainUntil,
                c.capturedAt,
              ],
            );
          },
          purgeCommunication: async (c) => {
            await tx.query(
              'UPDATE procurement_communications SET document=$3,purged_at=$4 WHERE tenant_id=$1 AND id=$2',
              [tenantId, c.id, c, c.purgedAt],
            );
          },
          extractions: (ids) =>
            documents<Extraction>(
              `SELECT document FROM procurement_extractions WHERE tenant_id=$1 AND communication_id=ANY($2::uuid[])
               ORDER BY communication_id,attempt`,
              [tenantId, ids],
            ),
          insertExtraction: async (e) => {
            await tx.query(
              'INSERT INTO procurement_extractions(tenant_id,id,communication_id,attempt,document,created_at) VALUES($1,$2,$3,$4,$5,$6)',
              [tenantId, e.id, e.communicationId, e.attempt, e, e.createdAt],
            );
          },
          commitments: (ids) =>
            documents<Commitment>(
              `SELECT document FROM procurement_commitments WHERE tenant_id=$1
               AND ($2::uuid[] IS NULL OR purchase_order_id=ANY($2::uuid[])) ORDER BY recorded_at,id`,
              [tenantId, ids ?? null],
            ),
          commitment: async (id) =>
            (
              await documents<Commitment>(
                'SELECT document FROM procurement_commitments WHERE tenant_id=$1 AND id=$2',
                [tenantId, id],
              )
            )[0] ?? null,
          insertCommitment: async (c, sourceKey) => {
            await tx.query(
              `INSERT INTO procurement_commitments(tenant_id,id,purchase_order_id,source_key,document,recorded_at)
               VALUES($1,$2,$3,$4,$5::jsonb || jsonb_build_object('orderRevision',COALESCE($5::jsonb->'orderRevision',(SELECT document->'revision' FROM procurement_purchase_orders WHERE tenant_id=$1 AND id=$3))),$6) ON CONFLICT(tenant_id,source_key) DO NOTHING`,
              [tenantId, c.id, c.purchaseOrderId, sourceKey, c, c.recordedAt],
            );

            return (
              await documents<Commitment>(
                'SELECT document FROM procurement_commitments WHERE tenant_id=$1 AND source_key=$2',
                [tenantId, sourceKey],
              )
            )[0]!;
          },
          reviewCommitment: async (c) => {
            await tx.query(
              'UPDATE procurement_commitments SET document=$3 WHERE tenant_id=$1 AND id=$2',
              [tenantId, c.id, c],
            );
          },
          latestObservation: async (orderId) =>
            (
              await documents<PurchasingObservation>(
                `SELECT document FROM procurement_observations WHERE tenant_id=$1 AND purchase_order_id=$2
                 ORDER BY observed_at DESC,id DESC LIMIT 1`,
                [tenantId, orderId],
              )
            )[0] ?? null,
          observations: (orderId, limit) =>
            documents<PurchasingObservation>(
              `SELECT document FROM procurement_observations WHERE tenant_id=$1 AND purchase_order_id=$2
               ORDER BY observed_at DESC,id DESC LIMIT $3`,
              [tenantId, orderId, limit],
            ),
          insertObservation: async (o) => {
            await tx.query(
              `INSERT INTO procurement_observations(tenant_id,id,purchase_order_id,connection_id,digest,document,observed_at)
               VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
              [
                tenantId,
                o.id,
                o.purchaseOrderId,
                o.connectionId,
                o.digest,
                o,
                o.observedAt,
              ],
            );
            await observed?.({ transaction: async (_tenant, fn) => fn(tx) }, o);
          },
          recordRead: (evidence) =>
            insertPurchasingRead(tx, tenantId, evidence),
          followUps: (ids) =>
            documents<FollowUp>(
              `SELECT document FROM procurement_follow_ups WHERE tenant_id=$1
               AND ($2::uuid[] IS NULL OR purchase_order_id=ANY($2::uuid[])) ORDER BY responded_at,id`,
              [tenantId, ids ?? null],
            ),
          insertFollowUp: async (f) =>
            !!(
              await tx.query(
                `INSERT INTO procurement_follow_ups(tenant_id,id,purchase_order_id,key,document,responded_at)
                 VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
                [tenantId, f.id, f.purchaseOrderId, f.key, f, f.respondedAt],
              )
            ).rowCount,
          command: async (id) =>
            (
              await tx.query<{ digest: string; result: unknown }>(
                'SELECT digest,result FROM procurement_commands WHERE tenant_id=$1 AND id=$2',
                [tenantId, id],
              )
            ).rows[0] ?? null,
          saveCommand: async (id, digest, result) => {
            await tx.query(
              'INSERT INTO procurement_commands(tenant_id,id,digest,result) VALUES($1,$2,$3,$4)',
              [tenantId, id, digest, JSON.stringify(result)],
            );
          },
          audit: (entry) => log.append(entry),
          skuIdentities: async (connectionId, skus) => {
            // Exact canonical IDs and keys win; a SKU code counts only when one SKU has it.
            const rows = (
              await tx.query<{
                key: string;
                sku_id: string;
                rank: number;
                external_id: string;
                scope_key: string;
              }>(
                `SELECT k.key,e.id AS sku_id,
                  CASE WHEN e.id::text=k.key THEN 0 WHEN e.reconciliation_key=k.key THEN 1 ELSE 2 END AS rank,
                  m.external_id,m.scope_key
                 FROM unnest($2::text[]) k(key)
                 JOIN inventory_entities e ON e.tenant_id=$1 AND e.kind='sku' AND (e.id::text=k.key OR e.reconciliation_key=k.key
                  OR EXISTS (SELECT 1 FROM inventory_product_skus p WHERE p.tenant_id=e.tenant_id AND p.sku_id=e.id AND p.code=k.key))
                 JOIN connector_source_mappings m ON m.tenant_id=e.tenant_id AND m.resource='sku' AND m.canonical_id=e.id
                  AND m.connection_id=$3
                 ORDER BY k.key,rank,m.external_id`,
                [tenantId, skus, connectionId],
              )
            ).rows;
            const result = new Map<
              string,
              { externalId: string; scopeKey: string }
            >();
            for (const key of skus) {
              const matches = rows.filter((r) => r.key === key);
              const best = matches[0];
              if (!best) continue;
              const tied = new Set(
                matches
                  .filter((m) => m.rank === best.rank)
                  .map((m) => m.sku_id),
              );
              const externals = new Set(
                matches
                  .filter((m) => m.sku_id === best.sku_id)
                  .map((m) => `${m.scope_key}\u0000${m.external_id}`),
              );
              if (tied.size === 1 && externals.size === 1)
                result.set(key, {
                  externalId: best.external_id,
                  scopeKey: best.scope_key,
                });
            }

            return result;
          },
        });
      }),
  };
}
