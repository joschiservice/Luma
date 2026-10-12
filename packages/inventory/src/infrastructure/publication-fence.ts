import {
  IdentityError,
  requireChangesAllowed,
  requirePermission,
  requireTenant,
  type TenantContext,
} from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import type { NativePublicationBinding } from '../application/publication.js';
import { addressSchema } from './ledger-validation.js';
import { scopeSchema } from './native-stock-validation.js';

/** Keeps the approved pool and ownership stable through one admitted channel dispatch; it never posts stock. */
export function createNativePublicationFence(
  db: TenantDatabase,
  refreshContext: (context: TenantContext) => Promise<TenantContext>,
) {
  return async <T>(
    context: TenantContext,
    input: NativePublicationBinding,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const fresh = await refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Actor changed.');
    requirePermission(fresh, 'inventory.manage');
    requireChangesAllowed(fresh);
    const binding = { ...input, scope: scopeSchema.parse(input.scope) };
    addressSchema.parse({
      skuId: binding.skuId,
      locationId: binding.locationId,
      unit: binding.unit,
      state: 'available',
    });
    if (
      binding.scope.mode !== 'own' ||
      binding.scope.locationId !== binding.locationId
    )
      throw new IdentityError(
        409,
        'CONFLICT',
        'Publication needs this exact owned stock location.',
      );

    return db.transaction(fresh.tenantId, async (tx) => {
      await tx.query(
        'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',
        [`source-authority:${fresh.tenantId}`],
      );
      await tx.query(
        'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',
        [`commerce-ingestion:${fresh.tenantId}`],
      );
      const scope = (
        await tx.query<{ version: string; transition: string }>(
          `SELECT version::text version,last_transition_id transition
    FROM inventory_stock_ownership_scopes WHERE tenant_id=$1 AND location_id=$2 AND connection_id=$3 AND mode='own' FOR SHARE`,
          [fresh.tenantId, binding.locationId, binding.scope.connectionId],
        )
      ).rows[0];
      if (
        !scope ||
        scope.version !== binding.scope.version ||
        scope.transition !== binding.scope.lastTransitionId
      )
        throw new IdentityError(
          409,
          'CONFLICT',
          'Ownership changed. Review a new allocation.',
        );
      const accounts = (
        await tx.query<{ id: string; version: string; balance: string }>(
          `SELECT id,version::text,trim_scale(balance)::text balance
    FROM inventory_ledger_accounts WHERE tenant_id=$1 AND sku_id=$2 AND location_id=$3 AND unit=$4 ORDER BY id FOR UPDATE`,
          [fresh.tenantId, binding.skuId, binding.locationId, binding.unit],
        )
      ).rows;
      if (
        accounts.length !== binding.accounts.length ||
        accounts.some(
          (account) =>
            !binding.accounts.some(
              (before) =>
                before.id === account.id &&
                before.version === account.version &&
                before.balance === account.balance,
            ),
        )
      )
        throw new IdentityError(
          409,
          'CONFLICT',
          'Native stock changed. Review a new allocation.',
        );

      return operation();
    });
  };
}
