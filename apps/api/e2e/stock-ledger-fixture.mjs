import { randomUUID } from 'node:crypto';

import { createInventoryLedgerRuntime } from '@luma/application-runtime';
import { createAuditLog } from '@luma/audit/composition';
import { createLedgerStore } from '@luma/inventory/composition';
import { createTenantDatabase } from '@luma/platform/composition';
import { Pool } from 'pg';

import {
  correctionFixture,
  stockItem,
  stockLocation,
} from './shopify-inventory-fixture.mjs';

/** Creates current source evidence and restricted Inventory services against the real simulator. */
export async function ledgerFixture(t, options = {}) {
  const source = await correctionFixture(t, options.origin, {
    ...options,
    bundleReads: true,
  });
  await source.syncRecords('inventory.read', {
    limit: 100,
    sku: { externalId: stockItem, scopeKey: '' },
    location: { externalId: stockLocation, scopeKey: '' },
    includeComposition: true,
  });
  const snapshot = (
    await source.f.db.owner.query(
      "SELECT s.id,s.document FROM inventory_snapshots s JOIN inventory_projections p ON p.tenant_id=s.tenant_id AND p.snapshot_id=s.id WHERE s.tenant_id=$1 AND s.connection_id=$2 AND s.kind='position'",
      [source.f.org.id, source.installed.id],
    )
  ).rows[0];
  const pool = new Pool({ connectionString: source.f.db.runtimeUrl }),
    db = createTenantDatabase(pool);
  t.onTestFinished(() => pool.end());
  const store = createLedgerStore(db, createAuditLog);
  const ledger = createInventoryLedgerRuntime(db, source.f.identity.service);
  const context = (user) =>
    source.f.identity.service.resolveWorkflowContext(
      user.id,
      source.f.org.id,
      randomUUID(),
    );
  const owner = await context(source.f.owner),
    admin = await context(source.admin);

  return {
    ...source,
    pool,
    db,
    store,
    ledger,
    owner,
    admin,
    snapshot,
    context,
  };
}
