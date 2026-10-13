import {
  type InventoryLevelData,
  iso,
  levelGid,
  levelId,
  save,
  type ShopifyContext,
} from './records.js';

/** Shopify's sellable units, excluding committed and unavailable states; incoming is separate. */
export const available = (level: InventoryLevelData) =>
  level.onHand -
  level.committed -
  (level.reserved ?? 0) -
  (level.damaged ?? 0) -
  (level.qualityControl ?? 0) -
  (level.safetyStock ?? 0);

/** Reads an item's stock at a location. */
export function readLevel(
  context: ShopifyContext,
  item: string,
  location: string,
) {
  return context.store.get<InventoryLevelData>(
    'InventoryLevel',
    levelId(item, location),
  );
}

/** Stores a level, connecting the item to the location when new, and sends `inventory_levels/update`. */
export async function writeLevel(
  context: ShopifyContext,
  data: InventoryLevelData,
) {
  if (
    ![
      data.onHand,
      data.committed,
      data.reserved ?? 0,
      data.incoming ?? 0,
      data.damaged ?? 0,
      data.qualityControl ?? 0,
      data.safetyStock ?? 0,
    ].every(
      (value) => Number.isSafeInteger(value) && Math.abs(value) <= 2147483647,
    )
  )
    throw new Error('Inventory quantity out of range');
  await save(
    context,
    'InventoryLevel',
    levelId(data.item, data.location),
    data,
    {
      parent: data.item,
      key: data.location,
    },
  );
  context.notify({
    topic: 'inventory_levels/update',
    resource: levelGid(data.item, data.location),
    payload: {
      inventory_item_id: Number(data.item),
      location_id: Number(data.location),
      available: available(data),
      updated_at: iso(context.now),
      admin_graphql_api_id: levelGid(data.item, data.location),
    },
  });
}

/**
 * Changes on-hand and committed units of a stocked item by the given amounts.
 * Fails when the item is not stocked at the location.
 */
export async function adjustLevel(
  context: ShopifyContext,
  item: string,
  location: string,
  change: { onHand?: number; committed?: number },
) {
  const level = await readLevel(context, item, location);
  if (!level)
    throw new Error(`Variant ${item} is not stocked at location ${location}`);
  await writeLevel(context, {
    ...level.data,
    onHand: level.data.onHand + (change.onHand ?? 0),
    committed: level.data.committed + (change.committed ?? 0),
  });
}

/** Reads a level quantity by Shopify name; undefined for names Shopify does not define. */
export function quantity(level: InventoryLevelData, name: string) {
  switch (name) {
    case 'on_hand':
      return level.onHand;
    case 'committed':
      return level.committed;
    case 'available':
      return available(level);
    case 'damaged':
      return level.damaged ?? 0;
    case 'incoming':
      return level.incoming ?? 0;
    case 'quality_control':
      return level.qualityControl ?? 0;
    case 'reserved':
      return level.reserved ?? 0;
    case 'safety_stock':
      return level.safetyStock ?? 0;
    default:
      return undefined;
  }
}
