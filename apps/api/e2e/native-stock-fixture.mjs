import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createAppHost } from '@luma/app-catalog';
import {
  createNativeStockRuntime,
  createSalesRuntime,
} from '@luma/application-runtime';
import {
  createInstalledRuntime,
  createInternalOrderSource,
  createSourceAuthority,
} from '@luma/connections/composition';

import { ledgerFixture } from './stock-ledger-fixture.mjs';

/** Opens one synthetic stock pool and advances explicit reviewed ownership through the real services. */
export async function nativeStockFixture(t, options = {}) {
  const f = await ledgerFixture(t, {
    shop: 'luma-synthetic-pilot.myshopify.com',
    name: 'Luma synthetic pilot',
    locationName: 'Main warehouse',
    ...options,
  });
  const authority = (scoped) =>
    createSourceAuthority(
      scoped,
      (provider) =>
        provider === 'luma-erp' || provider === 'jtl' ? 'erp' : 'storefront',
      f.f.identity.service.refreshContext,
      async () => true,
    );
  const sales = createSalesRuntime(
    f.db,
    f.f.identity.service,
    async () => true,
    authority,
  );
  const internal = await createInternalOrderSource(f.db)(f.owner);
  for (const [group, connectionId] of [
    ['order_lines', internal.id],
    ['order_lifecycle', internal.id],
    ['inventory_stock', f.installed.id],
  ]) {
    const current = await authority(f.db).read(f.owner);
    await authority(f.db).change(f.owner, {
      commandId: randomUUID(),
      revision: current.revision,
      group,
      connectionId,
    });
  }
  const host = createAppHost(f.db, {
    ...f.connectionsConfig,
    refreshContext: f.f.identity.service.refreshContext,
    env: {},
  });
  const reader = createInstalledRuntime({
    installations: host.connections,
    providers: host.registry.providers(),
    record: async () => {},
    recordObservations: async () => {},
  });
  const native = createNativeStockRuntime(
    f.db,
    f.f.identity.service,
    async () => true,
    authority,
    reader,
  );
  const opening = await f.ledger.prepareOpening(f.owner, {
    id: randomUUID(),
    key: randomUUID(),
    snapshotId: f.snapshot.id,
    reason: 'Synthetic native warehouse opening',
    balances: { available: '12' },
  });
  await f.ledger.review(f.admin, opening.id, true);
  await f.ledger.postReviewed(f.owner, opening.id);
  const base = {
    skuId: f.snapshot.document.data.skuId,
    locationId: f.snapshot.document.data.locationId,
    unit: 'each',
  };

  async function stockRead(reconcile = true) {
    const evidence = await native.readStock(f.owner, {
      connectionId: f.installed.id,
      ...base,
    });
    const latest = evidence.snapshotId;

    if (!reconcile) return evidence;

    return f.ledger.reconcile(f.owner, {
      id: randomUUID(),
      key: randomUUID(),
      snapshotId: latest,
    });
  }

  await stockRead();

  async function step(to) {
    const scope = await native.store.transaction(f.owner, (tx) =>
      tx.scope(f.installed.id, base.locationId, false),
    );
    const review = await native.ownership.prepare(f.owner, {
      id: randomUUID(),
      key: randomUUID(),
      connectionId: f.installed.id,
      locationId: base.locationId,
      version: scope.version,
      to,
      reason: 'Explicit synthetic ownership pilot',
    });
    await assert.rejects(
      native.ownership.review(f.owner, review.id, true),
      (error) => error.code === 'review_required',
    );
    await native.ownership.review(f.admin, review.id, true);

    return { review, result: await native.ownership.apply(f.owner, review.id) };
  }

  const shadow = await step('shadow'),
    propose = await step('propose'),
    own = await step('own');
  assert.deepEqual(
    await native.ownership.apply(f.owner, shadow.review.id),
    shadow.result,
  );
  const rawOrder = await f.runShopify({
    kind: 'order',
    id: '261',
    lines: [{ variant: '1', quantity: 4, price: '24.00' }],
    location: '1',
    shipping: 'standard',
    financialStatus: 'PAID',
  });
  await f.syncRecords('orders.read', { limit: 100 });
  const orderId = (
    await f.f.db.owner.query(
      "SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource='order' AND external_id=$3",
      [f.owner.tenantId, f.installed.id, `gid://shopify/Order/${rawOrder.id}`],
    )
  ).rows[0].canonical_id;
  const edited = await sales.accept(f.owner, orderId, f.installed.id);

  async function shipmentRead() {
    return native.readShipments(f.owner, orderId, f.installed.id);
  }

  return {
    ...f,
    native,
    sales,
    authority,
    base,
    rawOrder,
    orderId,
    record: edited,
    shipmentRead,
    stockRead,
    step,
    own,
    propose,
  };
}
