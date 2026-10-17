import { createHash } from 'node:crypto';

import { nativePublicationBindingSchema } from '@luma/api-contract';
import type { AuthoritySnapshot } from '@luma/connections';
import { requirePermission, type TenantContext } from '@luma/identity';
import { quantityUnits } from '@luma/inventory';
import { canonicalJson, conflict, type TenantDatabase } from '@luma/platform';
import type { z } from 'zod';

import type { correctionTarget } from '../domain/inventory-correction.js';

interface PositionSource {
  connectionId: string;
  skuId: string;
  locationId: string;
  unit: string;
  observationId: string;
  observedAt: string;
  mappings: { resource: string; externalId: string; scopeKey: string }[];
  active: boolean;
  installed: boolean;
  readable: boolean;
  deleted: boolean;
  provider: string;
}

/** Reads reviewed native authority for the selected channel without writing Inventory-owned state. */
export function createNativeAllocationQuery(database: TenantDatabase) {
  return async (
    context: TenantContext,
    target: z.infer<typeof correctionTarget>,
    source: PositionSource,
    authority: AuthoritySnapshot,
  ) => {
    requirePermission(context, 'inventory.read');
    const choice = target.nativeAllocation;
    if (
      !choice ||
      target.sourceConnectionId !== target.connectionId ||
      source.connectionId !== target.connectionId ||
      source.provider !== 'shopify' ||
      !source.active ||
      !source.installed ||
      !source.readable ||
      source.deleted ||
      source.unit !== 'each'
    )
      throw conflict(
        'Choose the owned Shopify channel and a whole-unit allocation.',
      );
    const selling = authority.groups.find(
      (group) => group.group === 'inventory_selling',
    );
    if (
      selling?.connectionId !== target.connectionId ||
      selling.state !== 'resolved'
    )
      throw conflict(
        'The selling source changed or is inconclusive. Review source authority.',
      );
    const native = await database.transaction(
      context.tenantId,
      async (tx) => {
        const scope = (
          await tx.query<{ scope: unknown }>(
            `
    SELECT jsonb_build_object('connectionId',connection_id,'locationId',location_id,'version',version::text,'mode',mode,
     'authorityRevision',authority_revision,'lastTransitionId',last_transition_id,'updatedAt',updated_at) scope
    FROM inventory_stock_ownership_scopes WHERE tenant_id=$1 AND location_id=$2 AND connection_id=$3 AND mode='own'`,
            [context.tenantId, source.locationId, target.connectionId],
          )
        ).rows[0];
        if (!scope)
          throw conflict(
            'Review native ownership for this exact location before publishing stock.',
          );
        const accounts = (
          await tx.query<{ accounts: unknown }>(
            `
    SELECT jsonb_agg(jsonb_build_object('id',id,'address',jsonb_build_object('skuId',sku_id,'locationId',location_id,'unit',unit,'state',state)
     || CASE WHEN connection_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('connectionId',connection_id) END,
     'balance',trim_scale(balance)::text,'version',version::text) ORDER BY id) accounts
    FROM inventory_ledger_accounts WHERE tenant_id=$1 AND sku_id=$2 AND location_id=$3 AND unit=$4`,
            [context.tenantId, source.skuId, source.locationId, source.unit],
          )
        ).rows[0]?.accounts;
        const openings = (
          await tx.query<{ id: string }>(
            `
    SELECT DISTINCT e.review_id id FROM inventory_ledger_entries e
    JOIN inventory_ledger_postings p ON p.tenant_id=e.tenant_id AND p.entry_id=e.id
    JOIN inventory_ledger_accounts a ON a.tenant_id=p.tenant_id AND a.id=p.account_id
    JOIN inventory_ledger_reviews r ON r.tenant_id=e.tenant_id AND r.id=e.review_id AND r.state='approved'
    WHERE e.tenant_id=$1 AND e.purpose='opening' AND a.sku_id=$2 AND a.location_id=$3 AND a.unit=$4 ORDER BY e.review_id`,
            [context.tenantId, source.skuId, source.locationId, source.unit],
          )
        ).rows.map((row) => row.id);
        if (!Array.isArray(accounts) || !openings.length)
          throw conflict('This stock pool needs a reviewed native opening.');
        const parsedAccounts =
          nativePublicationBindingSchema.shape.accounts.parse(accounts);
        const availableRow = parsedAccounts.find(
          (value) => value.address.state === 'available',
        );
        if (!availableRow) throw conflict('Native availability is unknown.');

        return nativePublicationBindingSchema.parse({
          scope: scope.scope,
          authorityRevision: authority.revision,
          skuId: source.skuId,
          locationId: source.locationId,
          unit: source.unit,
          available: availableRow.balance,
          accounts: parsedAccounts,
          openingReviewIds: openings,
        });
      },
      { readOnlySnapshot: true },
    );
    if (BigInt(choice.available) * 1000000n > quantityUnits(native.available))
      throw conflict('The allocation exceeds current native availability.');
    const age = Date.now() - Date.parse(source.observedAt);
    if (!Number.isFinite(age) || age < 0 || age >= 300000)
      throw conflict(
        'Read this stock source independently before publishing an allocation.',
      );

    return {
      connectionId: target.connectionId,
      label: 'Luma native stock',
      observationId: source.observationId,
      observedAt: source.observedAt,
      available: choice.available,
      nativeAllocation: native,
      revision: createHash('sha256')
        .update(
          canonicalJson({
            native,
            allocation: choice.available,
            mappings: source.mappings,
          }),
        )
        .digest('hex'),
    };
  };
}
