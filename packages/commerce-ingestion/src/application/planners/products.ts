import { normalizers, type Planner } from '../planning.js';

/** Plans a product once it and every SKU are mapped; bundle components may stay unmapped. */
export const planProduct: Planner<'products.read'> = async (
  input,
  { lookup, resolve, missing, provenance, digest },
) => {
  const o = input.observation;
  const data = input.observation.data;
  const entityId = await resolve('product', o.source);
  const skus = [];
  for (const sku of data.skus) {
    const skuId = await resolve('sku', sku.id);
    const bundle =
      sku.bundle === undefined
        ? undefined
        : {
            variant: sku.bundle.variant,
            requiresComponents: sku.bundle.requiresComponents,
            components:
              sku.bundle.components === null
                ? null
                : await Promise.all(
                    sku.bundle.components.map(async (component) => ({
                      sourceId: component.id,
                      sourceVariant: component.variant,
                      sourceSku: component.sku,
                      skuId: component.sku
                        ? await lookup({
                            ...o.source,
                            ...component.sku,
                            resource: 'sku',
                          })
                        : null,
                      quantity: component.quantity,
                    })),
                  ),
          };
    if (skuId)
      skus.push({
        skuId,
        ...(bundle === undefined ? {} : { bundle }),
        code: sku.code,
        unit: sku.unit,
        ...(sku.title !== undefined && { title: sku.title }),
        ...(sku.price !== undefined && { price: sku.price }),
        ...(sku.barcode !== undefined && { barcode: sku.barcode }),
      });
  }
  if (!entityId || missing.length) return { status: 'pending', missing };

  return {
    owner: 'inventory',
    snapshot: {
      ...provenance,
      schemaVersion: 3,
      normalizerVersion: normalizers.product,
      entityId,
      kind: 'product',
      mappingVersion: digest(
        JSON.stringify([entityId, skus.map((sku) => [sku.skuId, sku.bundle])]),
      ),
      data: {
        type: 'product',
        title: data.title,
        status: data.status,
        ...(data.vendor !== undefined && { vendor: data.vendor }),
        ...(data.published !== undefined && { published: data.published }),
        skus,
      },
    },
  };
};
