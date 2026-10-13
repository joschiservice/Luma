import {
  isCount,
  iso,
  type ItemRecord,
  type JtlContext,
  kinds,
  refuse,
  warehouseOf,
} from './records.js';

/** An item's stock as JTL reports it, with physical quantity per warehouse. */
export interface ItemStock {
  /** Physical quantity across warehouses. */
  total: number;
  /** Open quantity of uncancelled sales orders. */
  reserved: number;
  /** Physical minus reserved and quarantined units; negative when orders oversell. */
  available: number;
  warehouses: Record<string, number>;
}

/** Derives the stock totals JTL reports for an item. */
function stockOf(item: ItemRecord): ItemStock {
  const total = Object.values(item.stock).reduce(
    (sum, value) => sum + value,
    0,
  );

  return {
    total,
    reserved: item.reserved,
    available:
      total -
      item.reserved -
      Object.values(item.quarantinedStock ?? {}).reduce(
        (sum, value) => sum + value,
        0,
      ),
    warehouses: { ...item.stock },
  };
}

/** Loads items by ID; refuses when any is missing. */
export async function loadItems(context: JtlContext, ids: readonly string[]) {
  const unique = [...new Set(ids)];
  const records = await context.store.getMany<ItemRecord>(kinds.item, unique);
  if (records.length !== unique.length) refuse('Item not found', 404);

  return new Map(records.map((record) => [record.id, record.data]));
}

/**
 * Stores changed items after a stock change. Each change advances `modifiedTimestamp` to the
 * later of simulation time and one millisecond after the previous change, so readers always see
 * a strictly newer timestamp.
 */
export async function saveStock(
  context: JtlContext,
  items: Iterable<ItemRecord>,
) {
  for (const item of items) {
    item.modified = iso(Math.max(context.now, Date.parse(item.modified) + 1));
    await context.store.put(kinds.item, item.id, item, {
      updatedAt: context.now,
    });
    const stock = stockOf(item);
    context.notify({
      topic: 'items/stock',
      resource: item.id,
      payload: {
        itemId: item.id,
        total: stock.total,
        reserved: stock.reserved,
        available: stock.available,
      },
    });
  }
}

/** Sets an item's physical quantity in one warehouse, as an inventory count does. */
export async function countStock(
  context: JtlContext,
  itemId: string,
  warehouse: string,
  quantity: number,
) {
  if (!isCount(quantity)) refuse('Invalid stock quantity');
  const item = (await loadItems(context, [itemId])).get(itemId)!;
  item.stock[warehouseOf(context, warehouse)] = quantity;
  await saveStock(context, [item]);
}

/** Reads an item's current stock; undefined for an unknown item. */
export async function readItemStock(context: JtlContext, itemId: string) {
  const record = await context.store.get<ItemRecord>(kinds.item, itemId);

  return record ? stockOf(record.data) : undefined;
}

/** One catalog item with its stock, for periodic stock pushes and reorder checks. */
export interface ItemStockRow extends ItemStock {
  id: string;
  sku: string;
  name: string;
}

/** Reads items in creation order with their stock; pass `next` as `after` for the next page. */
export async function itemsPage(
  context: JtlContext,
  options: { after?: string | null | undefined; limit: number },
) {
  const page = await context.store.page<ItemRecord>({
    kind: kinds.item,
    after: options.after,
    limit: options.limit,
  });

  return {
    items: page.items.map(({ data }): ItemStockRow => ({
      id: data.id,
      sku: data.sku,
      name: data.name,
      ...stockOf(data),
    })),
    next: page.next,
  };
}

/** Serializes an item with its stock totals in ERP API 2.2 field names. */
export function itemJson(item: ItemRecord) {
  const stock = stockOf(item);

  return {
    id: Number(item.id),
    sKU: item.sku,
    name: item.name,
    unit: item.unit,
    isActive: item.active,
    isShopActive: item.shopActive,
    isInventoryManagementActive: true,
    salesPriceGross: item.price,
    gTIN: item.gtin,
    manufacturerName: item.manufacturer,
    stockTotal: stock.total,
    stockReservedTotal: stock.reserved,
    stockAvailable: stock.available,
    modifiedTimestamp: item.modified,
  };
}
