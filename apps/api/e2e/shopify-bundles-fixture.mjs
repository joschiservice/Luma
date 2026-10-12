import { correctionFixture } from './shopify-inventory-fixture.mjs';

/** Reads sold component lines and current recipes through the installed, restricted runtime. */
export async function bundlesFixture(t, origin, options = {}) {
  const fixture = await correctionFixture(t, origin, {
    ...options,
    bundleReads: true,
  });
  const { runShopify, syncRecords, f, installed } = fixture;
  await runShopify({
    kind: 'seed-catalog',
    products: [
      {
        id: '2',
        title: 'Travel bundle',
        vendor: 'Luma Goods',
        productType: 'Bundle',
        published: true,
        variants: [
          {
            id: '2',
            sku: 'LUMA-BUNDLE',
            title: 'Default Title',
            price: '48.00',
            barcode: null,
            stock: { 1: 100 },
          },
        ],
      },
      {
        id: '3',
        title: 'Bottle',
        vendor: 'Luma Goods',
        productType: 'Accessories',
        published: true,
        variants: [
          {
            id: '3',
            sku: 'LUMA-BOTTLE',
            title: 'Default Title',
            price: '12.00',
            barcode: null,
            stock: { 1: 20 },
          },
          {
            id: '4',
            sku: 'LUMA-REPLACEMENT',
            title: 'Replacement',
            price: '13.00',
            barcode: null,
            stock: { 1: 20 },
          },
        ],
      },
    ],
  });
  await runShopify({
    kind: 'bundle-recipe',
    variant: '2',
    requiresComponents: true,
    components: [
      { id: '201', variant: '1', quantity: 2 },
      { id: '202', variant: '3', quantity: 1 },
    ],
  });
  const group = {
    id: '220',
    title: 'Travel bundle at sale',
    quantity: 2,
    product: '2',
    variant: '2',
    sku: 'LUMA-BUNDLE',
  };
  const order = await runShopify({
    kind: 'order',
    id: '219',
    lines: [
      { variant: '1', quantity: 4, price: '18.00', bundleGroup: group },
      { variant: '3', quantity: 2, price: '12.00', bundleGroup: group },
    ],
    location: '1',
    shipping: 'standard',
    financialStatus: 'PAID',
  });
  await syncRecords('products.read', { limit: 100 });
  await syncRecords('orders.read', { limit: 100 });
  await syncRecords('fulfillment.read', { limit: 100 });
  const canonical = async (resource, external) =>
    (
      await f.db.owner.query(
        'SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource=$3 AND external_id=$4',
        [f.org.id, installed.id, resource, external],
      )
    ).rows[0].canonical_id;
  const parentSkuId = await canonical('sku', 'gid://shopify/InventoryItem/2');
  const orderId = await canonical('order', 'gid://shopify/Order/219');
  const productUrl = `${f.base}/products/${parentSkuId}`,
    orderUrl = `${f.base}/orders/${orderId}`;

  return {
    ...fixture,
    order,
    group,
    parentSkuId,
    orderId,
    productUrl,
    orderUrl,
  };
}
