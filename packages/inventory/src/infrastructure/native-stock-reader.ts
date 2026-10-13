import {
  hasPermission,
  IdentityError,
  requirePermission,
  requireTenant,
  type TenantContext,
} from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import type {
  NativeStockDemand,
  NativeStockReader,
} from '../application/native-stock.js';
import { LedgerError } from '../domain/ledger.js';
import { addressSchema } from './ledger-validation.js';
import { reservationSchema, scopeSchema } from './native-stock-validation.js';

/** Reads retained native records without creating accounts, changing authority or exposing customer fields. */
export function createNativeStockReader(
  db: TenantDatabase,
  refreshContext: (context: TenantContext) => Promise<TenantContext>,
  demand?: (
    db: TenantDatabase,
    context: TenantContext,
    orderId: string,
  ) => Promise<NativeStockDemand | null>,
): NativeStockReader {
  async function access(context: TenantContext) {
    const fresh = await refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Actor changed');
    requirePermission(fresh, 'inventory.read');

    return fresh;
  }

  return {
    /** Reads one exact stock pool and its bounded review queue. A zero prepared account is not an opening. */
    async pool(
      context: TenantContext,
      input: {
        skuId: string;
        locationId: string;
        unit: string;
        connectionId: string;
      },
    ) {
      const fresh = await access(context);

      return db.transaction(
        fresh.tenantId,
        async (tx) => {
          const row = (
            await tx.query<{ document: unknown }>(
              `SELECT jsonb_build_object('connectionId',connection_id,'locationId',location_id,'version',version::text,'mode',mode,'authorityRevision',authority_revision,'lastTransitionId',last_transition_id,'updatedAt',updated_at) AS document FROM inventory_stock_ownership_scopes WHERE tenant_id=$1 AND location_id=$2`,
              [fresh.tenantId, input.locationId],
            )
          ).rows[0];
          const scope = row
            ? scopeSchema.parse(row.document)
            : {
                connectionId: input.connectionId,
                locationId: input.locationId,
                version: '0',
                mode: 'observe' as const,
                authorityRevision: 0,
                lastTransitionId: null,
                updatedAt: null,
              };
          const accounts = (
            await tx.query<{
              id: string;
              address: {
                skuId: string;
                locationId: string;
                unit: string;
                state: string;
                connectionId?: string;
              };
              balance: string;
              version: string;
            }>(
              `SELECT id,jsonb_build_object('skuId',sku_id,'locationId',location_id,'unit',unit,'state',state)||CASE WHEN connection_id IS NOT NULL THEN jsonb_build_object('connectionId',connection_id) ELSE '{}'::jsonb END AS address,trim_scale(balance)::text AS balance,version::text FROM inventory_ledger_accounts WHERE tenant_id=$1 AND sku_id=$2 AND location_id=$3 AND unit=$4 ORDER BY state,connection_id,id`,
              [fresh.tenantId, input.skuId, input.locationId, input.unit],
            )
          ).rows;
          const opened = !!(
            await tx.query(
              'SELECT 1 FROM inventory_ledger_openings WHERE tenant_id=$1 AND sku_id=$2 AND location_id=$3 AND unit=$4',
              [fresh.tenantId, input.skuId, input.locationId, input.unit],
            )
          ).rowCount;
          const pending = (
            await tx.query<{
              id: string;
              purpose: string;
              preparedBy: string;
              state: 'pending' | 'approved' | 'rejected';
              createdAt: Date;
            }>(
              `SELECT id,command_document->>'purpose' AS purpose,prepared_by AS "preparedBy",state,created_at AS "createdAt" FROM inventory_ledger_reviews WHERE tenant_id=$1 AND source_bindings->0->>'skuId'=$2 AND source_bindings->0->>'locationId'=$3 AND source_bindings->0->>'unit'=$4 AND state IN ('pending','approved') AND NOT EXISTS(SELECT 1 FROM inventory_ledger_commands r WHERE r.tenant_id=$1 AND r.command_key=inventory_ledger_reviews.command_key) ORDER BY created_at DESC,id DESC LIMIT 20`,
              [fresh.tenantId, input.skuId, input.locationId, input.unit],
            )
          ).rows;

          const ownershipReviews = (
            await tx.query<{
              id: string;
              from: 'observe' | 'shadow' | 'propose' | 'own';
              to: 'observe' | 'shadow' | 'propose' | 'own';
              preparedBy: string;
              state: 'pending' | 'approved' | 'rejected';
            }>(
              `SELECT id,from_mode AS "from",to_mode AS "to",prepared_by AS "preparedBy",state FROM inventory_stock_ownership_reviews WHERE tenant_id=$1 AND binding->>'locationId'=$2 AND state IN ('pending','approved') AND NOT EXISTS(SELECT 1 FROM inventory_stock_ownership_transitions t WHERE t.tenant_id=$1 AND t.review_id=inventory_stock_ownership_reviews.id) ORDER BY created_at DESC,id DESC LIMIT 20`,
              [fresh.tenantId, input.locationId],
            )
          ).rows;

          return {
            ownershipReviews,
            skuId: input.skuId,
            locationId: input.locationId,
            unit: input.unit,
            scope,
            opened,
            accounts: accounts.map((account) => ({
              ...account,
              address: addressSchema.parse(account.address),
            })),
            pendingReviews: pending.map((value) => ({
              ...value,
              createdAt: value.createdAt.toISOString(),
            })),
          };
        },
        { readOnlySnapshot: true },
      );
    },
    /** Reads exact order reservations, including retained terminal quantities, with order read permission. */
    async order(context: TenantContext, orderId: string) {
      const fresh = await access(context);
      requirePermission(fresh, 'orders.read');

      return db.transaction(
        fresh.tenantId,
        async (tx) => {
          const rows = (
            await tx.query<{ document: unknown }>(
              `SELECT jsonb_build_object('id',id,'orderId',order_id,'orderLineId',order_line_id,'skuId',sku_id,'locationId',location_id,'unit',unit,'version',version::text,'allocated',trim_scale(allocated)::text,'remaining',trim_scale(remaining)::text,'consumed',trim_scale(consumed)::text,'released',trim_scale(released)::text,'expiresAt',expires_at,'state',state,'createdAt',created_at,'updatedAt',updated_at) AS document FROM inventory_native_reservations WHERE tenant_id=$1 AND order_id=$2 ORDER BY created_at,id LIMIT 5001`,
              [fresh.tenantId, orderId],
            )
          ).rows;
          if (rows.length > 5000)
            throw new LedgerError(
              'source_incomplete',
              'This order has too many reservation records to inspect at once.',
            );

          const scoped: TenantDatabase = {
            transaction: async (tenantId, work) => {
              requireTenant(fresh, tenantId);

              return work(tx);
            },
          };
          const retainedDemand =
            hasPermission(fresh, 'inventory.manage') && demand
              ? await demand(scoped, fresh, orderId)
              : null;

          return {
            demand: retainedDemand,
            orderId,
            reservations: rows.map((row) =>
              reservationSchema.parse(row.document),
            ),
          };
        },
        { readOnlySnapshot: true },
      );
    },
  };
}
