import type { ProductSnapshot } from '@luma/connections';

import type { createBundleReader } from './bundles.js';
import { variantSelection } from './read-selections.js';
import { type ReadSession, ref, statusFrom, text } from './read-session.js';
import * as s from './schemas.js';

// Unlisted products stay unknown: they sell by direct link but are hidden from the storefront.
const productStatuses: Record<string, ProductSnapshot['status']> = {
  ACTIVE: 'active',
  DRAFT: 'draft',
  ARCHIVED: 'archived',
};

/**
 * Emits one product with all variant pages. Export reads record each variant's bundle flag
 * without reading its current recipe.
 */
export async function readProduct(
  session: ReadSession,
  parent: { id: string },
  {
    bulk,
    readBundleRecipes,
  }: {
    bulk: boolean;
    readBundleRecipes: ReturnType<typeof createBundleReader>;
  },
) {
  const { node, children, emit } = session;
  const product = await node(
    parent.id,
    'Product',
    'id updatedAt title status vendor publishedAt priceRangeV2 { minVariantPrice { currencyCode } }',
    s.product,
  );
  const variants = await children(
    parent.id,
    'Product',
    'variants',
    variantSelection,
    s.variant,
  );
  // An export establishes older catalog facts, not a historical recipe read now.
  const bundles = bulk
    ? new Map(
        variants
          .filter((v) => v.requiresComponents !== undefined)
          .map((v) => [
            v.id,
            {
              variant: ref(v.id),
              requiresComponents: v.requiresComponents === true,
              components: null,
            },
          ]),
      )
    : await readBundleRecipes(variants);
  const currency = product.priceRangeV2?.minVariantPrice.currencyCode ?? null;
  emit('product', ref(product.id), product.updatedAt, {
    title: product.title,
    status: statusFrom(productStatuses, product.status),
    vendor: text(product.vendor),
    // Only an Online Store publication has a publication time readable with read_products.
    published: product.publishedAt != null,
    skus: variants.map((variant) => ({
      id: ref(variant.inventoryItem.id),
      code: variant.sku,
      unit: 'each',
      // Shopify names the only variant of a product "Default Title".
      title: variant.title === 'Default Title' ? null : text(variant.title),
      price: variant.price == null ? null : { amount: variant.price, currency },
      barcode: text(variant.barcode),
      ...(bundles.has(variant.id) ? { bundle: bundles.get(variant.id)! } : {}),
    })),
  } satisfies ProductSnapshot);
}
