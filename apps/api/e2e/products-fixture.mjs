import { randomUUID } from 'node:crypto';

import { createCommerceServices } from '@luma/application-runtime';
import { builtInMembership, makeTenantContext } from '@luma/identity';

import { inventoryFixture } from './inventory-fixture.mjs';

/**
 * Seeds a Shopify store and JTL catalog through commerce ingestion on top of the inventory
 * fixture. SKU-100 is linked across both sources and differs in title and listing; APR-M is
 * missing from JTL; GIFT-BOX exists in both sources but is not linked; SCARF-1 is a Shopify
 * draft only.
 */
export async function productsFixture(t, f) {
  const stock = await inventoryFixture(t, f);
  const commerce = createCommerceServices(f.db.ownerUrl);
  t.onTestFinished(() => commerce.close());
  const context = makeTenantContext(
    { userId: f.owner.id, sessionId: 'fixture' },
    { ...f.org, status: 'active', dataRegion: 'EU' },
    builtInMembership(
      { id: randomUUID(), organizationId: f.org.id, userId: f.owner.id },
      'owner',
    ),
    randomUUID(),
  );

  /** Ingests one product observation and binds the product and its SKUs by explicit keys. */
  async function product({
    connectionId,
    external,
    title,
    status = 'active',
    published = true,
    vendor = null,
    skus,
    time = new Date().toISOString(),
  }) {
    const source = {
      tenantId: f.org.id,
      connectionId,
      provider: connectionId === stock.erp ? 'jtl' : 'shopify',
      resource: 'product',
      externalId: external,
      scopeKey: '',
    };
    const id = randomUUID();
    await commerce.ingestion.ingest(context, id, {
      capability: 'products.read',
      observation: {
        id,
        source,
        kind: 'snapshot',
        observedAt: time,
        sourceUpdatedAt: time,
        sourceRevision: null,
        adapterVersion: 'fixture/1',
        schemaVersion: 1,
        data: {
          title,
          status,
          vendor,
          published,
          skus: skus.map((sku) => ({
            id: { externalId: sku.external, scopeKey: '' },
            code: sku.code,
            unit: 'each',
            title: sku.title ?? null,
            price: sku.price ?? null,
            barcode: sku.barcode ?? null,
          })),
        },
      },
    });
    await commerce.ingestion.bind(
      context,
      source,
      `product:${connectionId}:${external}`,
      id,
      'operator-confirmed',
    );
    for (const sku of skus)
      await commerce.ingestion.bind(
        context,
        { ...source, resource: 'sku', externalId: sku.external },
        sku.key,
        id,
        'operator-confirmed',
      );
    await commerce.ingestion.replay(context, connectionId, id);
  }

  const eur = (amount) => ({ amount, currency: 'EUR' });
  await product({
    connectionId: stock.store,
    external: 'gid://shopify/Product/1',
    title: 'Canvas tote',
    vendor: 'Luma Goods',
    skus: [
      {
        external: 'SKU-100',
        key: 'SKU-100',
        code: 'SKU-100',
        price: eur('24.00'),
        barcode: '0012345678905',
      },
    ],
    time: new Date(Date.now() - 86_400_000).toISOString(),
  });
  await product({
    connectionId: stock.store,
    external: 'gid://shopify/Product/1',
    title: 'Canvas tote',
    vendor: 'Luma Goods',
    skus: [
      {
        external: 'SKU-100',
        key: 'SKU-100',
        code: 'SKU-100',
        price: eur('26.00'),
        barcode: '0012345678905',
      },
    ],
  });
  await product({
    connectionId: stock.erp,
    external: '77',
    title: 'Canvas tote bag',
    published: false,
    vendor: 'Luma Goods',
    skus: [
      {
        external: '77',
        key: 'SKU-100',
        code: 'SKU-100',
        price: { amount: '26.00', currency: null },
        barcode: '012345678905',
      },
    ],
  });
  await product({
    connectionId: stock.store,
    external: 'gid://shopify/Product/2',
    title: 'Linen apron',
    skus: [
      {
        external: 'APR-S',
        key: 'APR-S',
        code: 'APR-S',
        title: 'Small',
        price: eur('18.00'),
      },
      {
        external: 'APR-M',
        key: 'APR-M',
        code: 'APR-M',
        title: 'Medium',
        price: eur('18.00'),
      },
    ],
  });
  await product({
    connectionId: stock.erp,
    external: '81',
    title: 'Linen apron Small',
    skus: [{ external: '81', key: 'APR-S', code: 'APR-S' }],
  });
  await product({
    connectionId: stock.store,
    external: 'gid://shopify/Product/3',
    title: 'Gift box',
    skus: [{ external: 'GIFT-S', key: 'GIFT-store', code: 'gift-box' }],
  });
  await product({
    connectionId: stock.erp,
    external: '90',
    title: 'Gift box',
    skus: [{ external: '90', key: 'GIFT-erp', code: 'GIFT-BOX ' }],
  });
  await product({
    connectionId: stock.store,
    external: 'gid://shopify/Product/4',
    title: 'Wool scarf',
    status: 'draft',
    published: false,
    skus: [{ external: 'SCARF-1', key: 'SCARF-1', code: 'SCARF-1' }],
  });
  const soldAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const soldOrderId = await stock.order({
    external: 'order-101',
    key: 'order-101',
    data: { displayNumber: '#101', placedAt: soldAt },
    lines: [
      { external: 'line-1', sku: 'SKU-100', skuKey: 'SKU-100', quantity: '3' },
    ],
  });

  /** Confirms that `otherId` is the same SKU as `targetId`, as a reviewed link would. */
  const link = (targetId, otherId) =>
    commerce.ingestion.link(context, 'sku', targetId, otherId, 'Same item');

  return { ...stock, product, link, soldOrderId };
}
