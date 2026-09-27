import type { TenantContext } from '@luma/identity';
import { IdentityError } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { canonicalJson } from '@luma/platform';

import type {
  ReplenishmentActivation,
  ReplenishmentStock,
  ReplenishmentStore,
} from '../application/replenishment.js';

/** Persists immutable replenishment grants and reads tenant inventory projections. */
export function createReplenishmentStore(
  db: TenantDatabase,
): ReplenishmentStore {
  return {
    async stocks(context: TenantContext): Promise<ReplenishmentStock[]> {
      return db.transaction(context.tenantId, async (tx) => {
        const rows = await tx.query<{
          position_id: string;
          connection_id: string;
          sku: string;
          document: {
            observedAt: string;
            observationId: string;
            deleted: boolean;
            data: { available: string | null; unit: string };
          };
        }>(
          `SELECT p.entity_id AS position_id,p.connection_id,s.document,e.reconciliation_key AS sku
           FROM inventory_projections p JOIN inventory_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
           JOIN inventory_entities e ON e.tenant_id=p.tenant_id AND e.id=(s.document->'data'->>'skuId')::uuid
           WHERE p.tenant_id=$1 AND s.kind='position' ORDER BY e.reconciliation_key,p.entity_id,p.connection_id`,
          [context.tenantId],
        );

        return rows.rows.map((r) => ({
          positionId: r.position_id,
          connectionId: r.connection_id,
          sku: r.sku,
          unit: r.document.data.unit,
          available:
            r.document.data.available !== null &&
            r.document.data.available.trim() !== '' &&
            Number.isFinite(Number(r.document.data.available))
              ? Number(r.document.data.available)
              : null,
          observedAt: r.document.observedAt,
          observationId: r.document.observationId,
          deleted: r.document.deleted,
        }));
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
            throw new IdentityError(
              409,
              'CONFLICT',
              'This activation ID is already bound to a different rule.',
            );

          return { ...existing.document, active: existing.active };
        }
        const overlap = await tx.query(
          'SELECT id FROM replenishment_activations WHERE tenant_id=$1 AND position_id=$2 AND active',
          [context.tenantId, activation.positionId],
        );
        if (overlap.rowCount)
          throw new IdentityError(
            409,
            'CONFLICT',
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
        if (!row)
          throw new IdentityError(
            404,
            'NOT_FOUND',
            'Replenishment activation not found.',
          );

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
