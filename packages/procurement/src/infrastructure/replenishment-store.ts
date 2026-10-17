import type { TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { canonicalJson, conflict, invalid, notFound } from '@luma/platform';

import type {
  ReplenishmentActivation,
  ReplenishmentStock,
  ReplenishmentStore,
} from '../application/replenishment.js';
import type { ReplenishmentApprovalContext } from '../domain/replenishment-review-context.js';

type StockRow = {
  position_id: string;
  connection_id: string;
  sku: string;
  document: {
    observedAt: string;
    observationId: string;
    deleted: boolean;
    data: { available: string | null; unit: string };
  };
};

function stockRow(row: StockRow): ReplenishmentStock {
  const quantity = row.document.data.available;

  return {
    positionId: row.position_id,
    connectionId: row.connection_id,
    sku: row.sku,
    unit: row.document.data.unit,
    available:
      typeof quantity === 'string' &&
      quantity.trim() !== '' &&
      Number.isFinite(Number(quantity))
        ? Number(quantity)
        : null,
    observedAt: row.document.observedAt,
    observationId: row.document.observationId,
    deleted: row.document.deleted,
  };
}

// The generated sku_id column lets a scoped position read use the entity primary key.
const stockColumns = `p.entity_id AS position_id,p.connection_id,s.document,
  COALESCE((SELECT k.code FROM inventory_product_skus k WHERE k.tenant_id=p.tenant_id AND k.sku_id=e.id
    AND k.code_key IS NOT NULL ORDER BY k.connection_id,k.product_id LIMIT 1),e.reconciliation_key) AS sku`;
const stockJoins = `JOIN inventory_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
  JOIN inventory_entities e ON e.tenant_id=p.tenant_id AND e.id=s.sku_id`;

/** Persists immutable replenishment grants and reads explicitly scoped tenant inventory. */
export function createReplenishmentStore(
  db: TenantDatabase,
): ReplenishmentStore {
  return {
    reviewContext: (context, runId, input) =>
      db.transaction(context.tenantId, async (tx) => {
        if (input)
          await tx.query(
            `INSERT INTO replenishment_approval_contexts(tenant_id,run_id,document) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
            [context.tenantId, runId, input],
          );
        const row = (
          await tx.query<{ document: ReplenishmentApprovalContext }>(
            'SELECT document FROM replenishment_approval_contexts WHERE tenant_id=$1 AND run_id=$2',
            [context.tenantId, runId],
          )
        ).rows[0];

        return row ? row.document : null;
      }),
    async hasStock(context) {
      return db.transaction(context.tenantId, async (tx) => {
        const result = await tx.query<{ present: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM inventory_projections p
            JOIN inventory_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
            WHERE p.tenant_id=$1 AND s.kind='position' AND NOT (s.document->>'deleted')::boolean) AS present`,
          [context.tenantId],
        );

        return result.rows[0]!.present;
      });
    },
    async stocksFor(context, positions) {
      if (!positions.length) return [];

      return db.transaction(context.tenantId, async (tx) => {
        const rows = await tx.query<StockRow>(
          `SELECT ${stockColumns} FROM inventory_projections p ${stockJoins}
           WHERE p.tenant_id=$1 AND s.kind='position' AND p.entity_id=ANY($2::uuid[])
           AND EXISTS (SELECT 1 FROM unnest($2::uuid[],$3::uuid[]) scope(position_id,connection_id)
             WHERE scope.position_id=p.entity_id AND (scope.connection_id IS NULL OR scope.connection_id=p.connection_id))
           ORDER BY p.entity_id,p.connection_id`,
          [
            context.tenantId,
            positions.map((p) => p.positionId),
            positions.map((p) => p.connectionId ?? null),
          ],
        );

        return rows.rows.map(stockRow);
      });
    },
    async browseStocks(context, query) {
      const cursor = query.cursor?.split(':');
      if (
        cursor &&
        (cursor.length !== 2 ||
          !cursor.every((part) =>
            /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
              part,
            ),
          ))
      )
        throw invalid('Invalid stock choices cursor.');
      const search = query.q?.trim() ?? '';
      const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;

      return db.transaction(context.tenantId, async (tx) => {
        const rows = await tx.query<StockRow>(
          // Search scalar SKU labels once; documents and display lookups are read only for the page.
          `WITH ${
            search
              ? `matching_skus AS MATERIALIZED (
            SELECT sku_id FROM (
              SELECT DISTINCT ON (sku_id) sku_id,code FROM inventory_product_skus
              WHERE tenant_id=$1 AND code_key IS NOT NULL ORDER BY sku_id,connection_id,product_id
            ) codes WHERE code ILIKE $6
            UNION SELECT id FROM inventory_entities e WHERE e.tenant_id=$1 AND e.reconciliation_key ILIKE $6
              AND NOT EXISTS (SELECT 1 FROM inventory_product_skus k WHERE k.tenant_id=$1 AND k.sku_id=e.id AND k.code_key IS NOT NULL)
          ),`
              : ''
          } page AS MATERIALIZED (
            SELECT p.* FROM inventory_projections p
            JOIN inventory_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
            WHERE p.tenant_id=$1 AND s.kind='position' AND NOT (s.document->>'deleted')::boolean
              AND ($2::uuid IS NULL OR p.entity_id=$2) AND ($3::uuid IS NULL OR p.connection_id=$3)
              AND ($4::uuid IS NULL OR (p.entity_id,p.connection_id)>($4::uuid,$5::uuid))
              ${search ? 'AND s.sku_id IN (SELECT sku_id FROM matching_skus)' : ''}
            ORDER BY p.entity_id,p.connection_id LIMIT 51
          ) SELECT ${stockColumns} FROM page p ${stockJoins}
            ORDER BY p.entity_id,p.connection_id`,
          [
            context.tenantId,
            query.positionId ?? null,
            query.connectionId ?? null,
            cursor?.[0] ?? null,
            cursor?.[1] ?? null,
            ...(search ? [pattern] : []),
          ],
        );
        const positions = rows.rows.slice(0, 50).map(stockRow);
        const last = positions.at(-1);

        return {
          positions,
          nextCursor:
            rows.rows.length > 50 && last
              ? `${last.positionId}:${last.connectionId}`
              : null,
        };
      });
    },
    async list(context: TenantContext): Promise<ReplenishmentActivation[]> {
      return db.transaction(context.tenantId, async (tx) =>
        (
          await tx.query<{
            document: ReplenishmentActivation;
            active: boolean;
            revoked_at: Date | null;
            revoked_by: string | null;
          }>(
            'SELECT document,active,revoked_at,revoked_by FROM replenishment_activations WHERE tenant_id=$1 ORDER BY created_at DESC,id',
            [context.tenantId],
          )
        ).rows.map((r) => ({
          ...r.document,
          active: r.active,
          ...(r.revoked_at
            ? {
                revokedAt: r.revoked_at.toISOString(),
                revokedBy: r.revoked_by!,
              }
            : {}),
        })),
      );
    },
    async save(context: TenantContext, activation: ReplenishmentActivation) {
      return db.transaction(context.tenantId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `replenishment:${context.tenantId}`,
        ]);
        const existing = (
          await tx.query<{
            document: ReplenishmentActivation;
            active: boolean;
          }>(
            'SELECT document,active FROM replenishment_activations WHERE tenant_id=$1 AND id=$2',
            [context.tenantId, activation.id],
          )
        ).rows[0];
        if (existing) {
          if (
            canonicalJson({ ...existing.document, reviewedAt: '' }) !==
            canonicalJson({ ...activation, reviewedAt: '' })
          )
            throw conflict(
              'This activation ID is already bound to a different rule.',
            );

          return { ...existing.document, active: existing.active };
        }
        const overlap = await tx.query(
          'SELECT id FROM replenishment_activations WHERE tenant_id=$1 AND position_id=$2 AND active',
          [context.tenantId, activation.positionId],
        );
        if (overlap.rowCount)
          throw conflict(
            'Revoke the existing rule for this stock position before replacing it.',
          );
        await tx.query(
          'INSERT INTO replenishment_activations(tenant_id,id,position_id,principal_id,document,created_at) VALUES($1,$2,$3,$4,$5,$6)',
          [
            context.tenantId,
            activation.id,
            activation.positionId,
            activation.principalId,
            activation,
            activation.reviewedAt,
          ],
        );

        return activation;
      });
    },
    async revoke(context: TenantContext, id: string) {
      return db.transaction(context.tenantId, async (tx) => {
        const row = (
          await tx.query<{
            document: ReplenishmentActivation;
            revoked_at: Date;
            revoked_by: string;
          }>(
            'UPDATE replenishment_activations SET active=false,revoked_at=COALESCE(revoked_at,clock_timestamp()),revoked_by=COALESCE(revoked_by,$3) WHERE tenant_id=$1 AND id=$2 RETURNING document,revoked_at,revoked_by',
            [context.tenantId, id, context.actor.id],
          )
        ).rows[0];
        if (!row) throw notFound('Replenishment activation not found.');

        return {
          ...row.document,
          active: false,
          revokedAt: row.revoked_at.toISOString(),
          revokedBy: row.revoked_by,
        };
      });
    },
    async claim(
      context: TenantContext,
      positionId: string,
      sku: string,
      runId: string,
    ) {
      return db.transaction(context.tenantId, async (tx) => {
        await tx.query(
          'INSERT INTO replenishment_claims(tenant_id,position_id,sku,run_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [context.tenantId, positionId, sku, runId],
        );
        const row = (
          await tx.query<{ run_id: string }>(
            'SELECT run_id FROM replenishment_claims WHERE tenant_id=$1 AND position_id=$2',
            [context.tenantId, positionId],
          )
        ).rows[0];

        return row?.run_id === runId;
      });
    },
    async release(context: TenantContext, runId: string) {
      await db.transaction(context.tenantId, async (tx) => {
        await tx.query(
          'DELETE FROM replenishment_claims WHERE tenant_id=$1 AND run_id=$2',
          [context.tenantId, runId],
        );
      });
    },
  };
}
