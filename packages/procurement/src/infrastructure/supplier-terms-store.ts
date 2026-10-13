import type { AuditLog } from '@luma/audit';
import type { TenantDatabase } from '@luma/platform';

import type { SupplierTermsStore } from '../application/supplier-terms.js';
import type {
  SupplierProductTerms,
  SupplierTermsVersion,
} from '../domain/supplier-terms.js';
import { effectiveSupplierTerms } from '../domain/supplier-terms.js';

/** Persists purchasing evidence, retries and audit atomically under procurement's tenant lock. */
export function createSupplierTermsStore(
  db: TenantDatabase,
  audit: (db: TenantDatabase) => AuditLog,
): SupplierTermsStore {
  return {
    transaction: (tenantId, write, operation) =>
      db.transaction(tenantId, async (tx) => {
        await tx.query(
          write
            ? 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))'
            : 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',
          [`procurement:${tenantId}`],
        );
        const log = audit({ transaction: async (_tenant, fn) => fn(tx) });

        return operation({
          list: async (filter) => {
            const rows = (
              await tx.query<{
                document: SupplierTermsVersion;
                supplier_name: string;
                sku: string;
                last_read_at: string | null;
                last_read_complete: boolean | null;
              }>(
                `SELECT t.document,r.observed_at::text AS last_read_at,r.complete AS last_read_complete,s.document->>'name' AS supplier_name,COALESCE((SELECT p.code FROM inventory_product_skus p WHERE p.tenant_id=t.tenant_id AND p.sku_id=t.sku_id ORDER BY p.observed_at DESC LIMIT 1),t.sku_id::text) AS sku
           FROM procurement_supplier_terms t JOIN procurement_suppliers s ON s.tenant_id=t.tenant_id AND s.id=t.supplier_id
           LEFT JOIN procurement_terms_reads r ON r.tenant_id=t.tenant_id AND r.supplier_id=t.supplier_id AND r.sku_id=t.sku_id
           WHERE t.tenant_id=$1 AND ($2::uuid IS NULL OR t.supplier_id=$2) AND ($3::uuid IS NULL OR t.sku_id=$3) ORDER BY t.supplier_id,t.sku_id,t.revision`,
                [tenantId, filter.supplierId ?? null, filter.skuId ?? null],
              )
            ).rows;
            const grouped = new Map<string, SupplierProductTerms>();
            for (const row of rows) {
              const v = row.document,
                key = `${v.supplierId}:${v.skuId}`;
              const item = grouped.get(key) ?? {
                supplierId: v.supplierId,
                supplierName: row.supplier_name,
                skuId: v.skuId,
                sku: row.sku,
                revision: v.revision,
                history: [],
                ...(row.last_read_at
                  ? {
                      lastReadAt: new Date(row.last_read_at).toISOString(),
                      lastReadComplete: row.last_read_complete ?? false,
                    }
                  : {}),
                ...effectiveSupplierTerms(
                  [],
                  new Date().toISOString().slice(0, 10),
                ),
              };
              item.history.push(v);
              item.revision = v.revision;
              Object.assign(
                item,
                effectiveSupplierTerms(
                  item.history,
                  new Date().toISOString().slice(0, 10),
                ),
              );
              grouped.set(key, item);
            }

            return [...grouped.values()];
          },
          exists: async (supplierId, skuId) =>
            (
              await tx.query(
                `SELECT 1 FROM procurement_suppliers s JOIN inventory_entities e ON e.tenant_id=s.tenant_id AND e.id=$3 AND e.kind='sku' WHERE s.tenant_id=$1 AND s.id=$2`,
                [tenantId, supplierId, skuId],
              )
            ).rows.length === 1,
          recordRead: async (supplierId, skuId, observedAt, complete) => {
            await tx.query(
              `INSERT INTO procurement_terms_reads(tenant_id,supplier_id,sku_id,observed_at,complete) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(tenant_id,supplier_id,sku_id) DO UPDATE SET observed_at=EXCLUDED.observed_at,complete=EXCLUDED.complete
          WHERE procurement_terms_reads.observed_at<=EXCLUDED.observed_at`,
              [tenantId, supplierId, skuId, observedAt, complete],
            );
          },
          insert: async (v) => {
            await tx.query(
              'INSERT INTO procurement_supplier_terms(tenant_id,id,supplier_id,sku_id,revision,document) VALUES($1,$2,$3,$4,$5,$6)',
              [tenantId, v.id, v.supplierId, v.skuId, v.revision, v],
            );
          },
          command: async (id) =>
            (
              await tx.query<{ digest: string; result: SupplierProductTerms }>(
                'SELECT digest,result FROM procurement_terms_commands WHERE tenant_id=$1 AND id=$2',
                [tenantId, id],
              )
            ).rows[0] ?? null,
          saveCommand: async (id, digest, result) => {
            await tx.query(
              'INSERT INTO procurement_terms_commands(tenant_id,id,digest,result) VALUES($1,$2,$3,$4)',
              [tenantId, id, digest, result],
            );
          },
          audit: (entry) => log.append(entry),
        });
      }),
  };
}
