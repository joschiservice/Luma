import { type Planner, positionKey } from '../planning.js';

/**
 * Plans a stock position once its SKU and location are mapped. Shopify's legacy `reserved`
 * figure is committed stock, so it moves to `committed` until the adapter reports `shopify/1`.
 */
export const planInventoryPosition: Planner<'inventory.read'> = async (
  input,
  { context, inventory, positions, resolve, missing, provenance, digest },
) => {
  const o = input.observation;
  const data = input.observation.data;
  const skuId = await resolve('sku', data.sku),
    locationId = await resolve('location', data.location);
  if (!skuId || !locationId) return { status: 'pending', missing };
  const key = positionKey(skuId, locationId, data.unit);
  const entityId =
    positions.get(JSON.stringify(['position', key])) ??
    (await inventory.identify(context, 'position', key));

  return {
    owner: 'inventory',
    snapshot: {
      ...provenance,
      entityId,
      kind: 'position',
      schemaVersion: 4,
      mappingVersion: digest(JSON.stringify([skuId, locationId])),
      data: {
        type: 'position',
        ...(data.composition === undefined
          ? {}
          : { composition: data.composition }),
        skuId,
        locationId,
        unit: data.unit,
        onHand: data.onHand,
        reserved:
          o.source.provider === 'shopify' &&
          data.inventorySemantics !== 'shopify/1'
            ? null
            : data.reserved,
        committed:
          o.source.provider === 'shopify' &&
          data.inventorySemantics !== 'shopify/1'
            ? data.reserved
            : (data.committed ?? null),
        incoming: data.incoming ?? null,
        damaged: data.damaged ?? null,
        qualityControl: data.qualityControl ?? null,
        safetyStock: data.safetyStock ?? null,
        locationActive: data.locationActive ?? null,
        itemActive: data.itemActive ?? null,
        tracked: data.tracked ?? null,
        inventorySemantics:
          o.source.provider === 'shopify'
            ? 'shopify/1'
            : (data.inventorySemantics ?? null),
        available: data.available,
        writeAttribution: data.writeAttribution ?? null,
        availabilityBasis: data.availabilityBasis,
      },
    },
  };
};
