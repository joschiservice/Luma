import { generateCatalog, merchantProfile } from '@luma/simulator-commerce';

/**
 * Links the simulated merchant's most-demanded SKUs and each shop's stock location to the ERP's
 * records, as a merchant does after reviewing them. Imports keep each source's records apart
 * until people link them, and stock detection compares only linked records. Each pass links up
 * to `batch` SKUs whose records are imported and skips the inventory scenario's explicit pair.
 * Passes are safe to repeat.
 */
export function createStockLinks({
  commerce,
  operator,
  manifest,
  limit = Number(process.env.LUMA_SIMULATOR_LINKED_SKUS ?? 500),
  batch = 100,
}) {
  const stock = manifest.simulator?.stock;
  if (!stock) return { pass: async () => ({ linked: 0, remaining: 0 }) };
  const { variants } = generateCatalog(
    merchantProfile(stock.profile),
    stock.seed,
  );
  const pairs = [...variants]
    .sort((a, b) => b.popularity - a.popularity || Number(a.id) - Number(b.id))
    .filter((variant) => variant.id !== manifest.simulator.inventory.erpItem)
    .slice(0, limit)
    .flatMap((variant) => variant.shops.map((shop) => ({ variant, shop })));
  const done = new Set();
  const identity = (instance, provider, resource, externalId) => ({
    tenantId: manifest.organizationId,
    connectionId: manifest.connections[instance],
    provider,
    resource,
    externalId,
    scopeKey: '',
  });

  /** Links the shop record to the ERP record once both are imported; false while one is missing. */
  async function link(context, kind, erp, shop, reason) {
    const [target, other] = await Promise.all([
      commerce.sources.resolve(context, erp),
      commerce.sources.resolve(context, shop),
    ]);
    if (!target || !other) return false;
    if (target !== other)
      await commerce.ingestion.link(context, kind, target, other, reason);

    return true;
  }

  return {
    async pass() {
      const context = await operator();
      for (const [shop, location] of Object.entries(stock.locations)) {
        const key = `location:${shop}`;
        if (
          !done.has(key) &&
          (await link(
            context,
            'location',
            identity('jtl', 'jtl', 'location', 'all-warehouses'),
            identity(shop, 'shopify', 'location', location),
            'The shop location sells the stock of all ERP warehouses',
          ))
        )
          done.add(key);
      }
      let linked = 0;
      for (const { variant, shop } of pairs) {
        const key = `sku:${shop}:${variant.id}`;
        if (done.has(key)) continue;
        if (linked >= batch) break;
        if (
          await link(
            context,
            'sku',
            identity('jtl', 'jtl', 'sku', variant.id),
            identity(
              shop,
              'shopify',
              'sku',
              `gid://shopify/InventoryItem/${variant.id}`,
            ),
            `The shop sells ERP item ${variant.sku}`,
          )
        ) {
          done.add(key);
          linked++;
        }
      }

      return {
        linked,
        remaining: pairs.filter(
          ({ variant, shop }) => !done.has(`sku:${shop}:${variant.id}`),
        ).length,
      };
    },
  };
}
