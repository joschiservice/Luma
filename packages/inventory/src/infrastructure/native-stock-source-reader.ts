import { randomUUID } from 'node:crypto';

import type { CapabilityOutput, CapabilityReader } from '@luma/connections';
import {
  requireChangesAllowed,
  requirePermission,
  requireTenant,
  type TenantContext,
} from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { forbidden } from '@luma/platform';

import type { NativeStockStore } from '../application/native-stock.js';
import { LedgerError } from '../domain/ledger.js';

/** Reads one exact installed source and retains it through the Inventory owner before returning its current evidence. */
export function createNativeStockSourceReader(deps: {
  db: TenantDatabase;
  store: NativeStockStore;
  reader: CapabilityReader;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  record(
    context: TenantContext,
    observations: CapabilityOutput<'inventory.read'>['items'],
  ): Promise<void>;
}) {
  return async (
    context: TenantContext,
    input: {
      connectionId: string;
      skuId: string;
      locationId: string;
      unit: string;
    },
  ) => {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id) throw forbidden('Actor changed');
    requirePermission(fresh, 'inventory.read');
    requirePermission(fresh, 'inventory.manage');
    requirePermission(fresh, 'sync.manage');
    requireChangesAllowed(fresh);
    const mappings = await deps.db.transaction(
      fresh.tenantId,
      async (tx) =>
        (
          await tx.query<{
            resource: string;
            externalId: string;
            scopeKey: string;
            provider: string;
          }>(
            `SELECT m.resource,m.external_id AS "externalId",m.scope_key AS "scopeKey",c.document->>'provider' AS provider FROM connector_source_mappings m JOIN connector_installations c ON c.tenant_id=m.tenant_id AND c.id=m.connection_id WHERE m.tenant_id=$1 AND m.connection_id=$2 AND ((m.resource='sku' AND m.canonical_id=$3) OR (m.resource='location' AND m.canonical_id=$4)) LIMIT 3`,
            [fresh.tenantId, input.connectionId, input.skuId, input.locationId],
          )
        ).rows,
    );
    const skus = mappings.filter((value) => value.resource === 'sku'),
      locations = mappings.filter((value) => value.resource === 'location');
    if (skus.length !== 1 || locations.length !== 1)
      throw new LedgerError(
        'source_incomplete',
        'Confirm one exact SKU and location mapping before reading native stock evidence.',
      );
    const sku = {
        externalId: skus[0]!.externalId,
        scopeKey: skus[0]!.scopeKey,
      },
      location = {
        externalId: locations[0]!.externalId,
        scopeKey: locations[0]!.scopeKey,
      };
    const check = async (
      state: 'complete' | 'unavailable',
      snapshotId: string | null,
    ) =>
      deps.db.transaction(fresh.tenantId, async (tx) => {
        await tx.query(
          `INSERT INTO inventory_native_stock_read_checks(tenant_id,id,connection_id,sku_id,location_id,unit,actor_id,state,snapshot_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            fresh.tenantId,
            randomUUID(),
            input.connectionId,
            input.skuId,
            input.locationId,
            input.unit,
            fresh.actor.id,
            state,
            snapshotId,
          ],
        );
      });
    try {
      const result = await deps.reader.read(fresh, {
        connectionId: input.connectionId,
        capability: 'inventory.read',
        version: '0',
        input: {
          limit: 1,
          sku,
          location,
          ...(skus[0]!.provider === 'shopify'
            ? { includeComposition: true }
            : {}),
        },
      });
      if (
        !result.ok ||
        result.value.completeness !== 'complete' ||
        result.value.nextCursor !== null ||
        result.value.items.length !== 1
      )
        throw new LedgerError(
          'source_incomplete',
          'This source did not establish one complete stock position.',
        );
      await deps.record(fresh, result.value.items);
      const snapshot = await deps.db.transaction(
        fresh.tenantId,
        async (tx) =>
          (
            await tx.query<{ id: string }>(
              `SELECT id FROM inventory_snapshots WHERE tenant_id=$1 AND connection_id=$2 AND observation_id=$3 AND kind='position'`,
              [fresh.tenantId, input.connectionId, result.value.items[0]!.id],
            )
          ).rows,
      );
      if (snapshot.length !== 1)
        throw new LedgerError(
          'source_incomplete',
          'This stock observation remains incompletely mapped.',
        );

      await check('complete', snapshot[0]!.id);

      return await deps.store.transaction(fresh, async (tx) => {
        const evidence = await tx.ledger.stockEvidence(snapshot[0]!.id);
        if (
          !evidence ||
          evidence.skuId !== input.skuId ||
          evidence.locationId !== input.locationId ||
          evidence.unit !== input.unit ||
          evidence.snapshotId !== snapshot[0]!.id
        )
          throw new LedgerError(
            'stale',
            'Stock identity changed during the independent read.',
          );

        return evidence;
      });
    } catch (error) {
      await check('unavailable', null);
      throw error;
    }
  };
}
