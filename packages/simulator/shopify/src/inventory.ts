import {
  type InventoryLevelData,
  iso,
  levelGid,
  levelId,
  save,
  type ShopifyContext,
} from './records.js';

/** Shopify's available quantity: on hand minus units committed to open orders. */
export const available = (level: InventoryLevelData) =>
  level.onHand - level.committed;

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
    ![data.onHand, data.committed].every(
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
    case 'incoming':
    case 'quality_control':
    case 'reserved':
    case 'safety_stock':
      return 0;
    default:
      return undefined;
  }
}
