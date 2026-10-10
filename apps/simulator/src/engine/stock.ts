import { availableAt } from '@luma/simulator-cin7';
import { keyedRandom } from '@luma/simulator-core';
import { type ItemStock, readItemStock } from '@luma/simulator-jtl';
import { readStock } from '@luma/simulator-shopify';

import { reorderIfLow } from './fulfillment.js';
import {
  closeIncident,
  erpContext,
  erpResource,
  type Incident,
  instance,
  openIncident,
  shop,
  shopContext,
  type World,
  worldInstance,
} from './world.js';

/** A shop SKU whose stock sync stopped; the incident ends when the shop matches the ERP again. */
interface Freeze {
  incident: string;
  shop: string;
  variant: string;
  location: string;
}

const freezeKey = (shopName: string, variant: string) =>
  `${shopName}:${variant}`;

/**
 * The availability a shop location mirrors: JTL's total across warehouses, or what Cin7 reports
 * at the shop's warehouse, because Cin7 integrations map one location to each shop location.
 */
export function mirrored(world: World, stock: ItemStock, location: string) {
  const erp = world.model.erp;

  return erp.kind === 'cin7'
    ? availableAt(
        stock.warehouses,
        stock.reserved,
        erp.config.warehouses.map((w) => w.id),
        location,
      )
    : stock.available;
}

/** Marks an item for the next ERP-to-shop stock push. */
export async function markDirty(world: World, itemId: string) {
  await world
    .store(worldInstance)
    .put('dirty', itemId, {}, { updatedAt: world.now });
}

/** Returns the shops that list a variant and the location that mirrors ERP stock. */
function listings(world: World, variantId: string) {
  const variant = world.model.variant(variantId);

  return world.model.shops
    .filter((item) => variant.shops.includes(item.name))
    .map((item) => ({ shop: item.name, location: item.shop.warehouse }));
}

/**
 * Pushes current ERP availability to every shop that lists a changed item, like the merchant's
 * stock connector, and skips frozen SKUs. Each pass handles a bounded batch, so large changes
 * take several passes.
 */
export async function syncStock(world: World, limit = 2_000) {
  const store = world.store(worldInstance);
  const page = await store.page({ kind: 'dirty', limit });
  for (const record of page.items) {
    await store.delete('dirty', record.id);
    const erpStock = await readItemStock(erpContext(world), record.id);
    if (!erpStock) continue;
    await reorderIfLow(world, record.id, erpStock.available);
    for (const listing of listings(world, record.id)) {
      if (await store.get('freeze', freezeKey(listing.shop, record.id)))
        continue;
      await shop(world, listing.shop, {
        kind: 'available',
        variant: record.id,
        location: listing.location,
        quantity: Math.max(0, mirrored(world, erpStock, listing.location)),
      });
    }
    world.metric('stock.pushed', 1);
  }

  return page.items.length;
}

/** Ends drift incidents whose shop stock matches the ERP again, for example after a correction. */
export async function checkFreezes(world: World) {
  const store = world.store(worldInstance);
  for (const frozen of (
    await store.page<Freeze>({ kind: 'freeze', limit: 500 })
  ).items) {
    const { shop: shopName, variant, location } = frozen.data;
    const erpStock = await readItemStock(erpContext(world), variant);
    const shopStock = await readStock(
      shopContext(world, shopName),
      variant,
      location,
    );
    if (
      erpStock &&
      shopStock?.available === Math.max(0, mirrored(world, erpStock, location))
    ) {
      await store.delete('freeze', frozen.id);
      await closeIncident(
        world,
        frozen.data.incident,
        'Shop stock matches the ERP again',
      );
    }
  }
}

/**
 * Stops the stock sync for one shop SKU and leaves the shop with a wrong availability: drift
 * moves it a few units either way; oversell shows stock the ERP does not have.
 */
export async function driftStock(
  world: World,
  kind: 'inventory-drift' | 'oversell',
  shopName: string,
  variantId: string,
  origin: Incident['origin'],
  options: { id?: string | undefined; offset?: number | undefined } = {},
) {
  const store = world.store(worldInstance);
  if (await store.get('freeze', freezeKey(shopName, variantId)))
    return undefined;
  const shopInstance = instance(world, shopName);
  if (shopInstance.kind !== 'shopify')
    throw new Error('Stock drift affects a shop');
  const variant = world.model.variant(variantId);
  if (!variant.shops.includes(shopName))
    throw new Error(`${shopName} does not list ${variant.sku}`);
  const location = shopInstance.shop.warehouse;
  const erpStock = await readItemStock(erpContext(world), variantId);
  if (!erpStock) throw new Error(`ERP item ${variantId} not found`);
  const random = keyedRandom(
    world.run.seed,
    'drift',
    shopName,
    variantId,
    world.now,
  );
  const offset =
    options.offset ??
    (kind === 'oversell'
      ? random.int(10, 40)
      : (random.chance(0.5) ? 1 : -1) * random.int(3, 20));
  const erpAvailable = Math.max(0, mirrored(world, erpStock, location));
  // Drift must leave a visible difference, also when the ERP has nothing left.
  const quantity =
    erpAvailable + offset >= 0 && offset !== 0
      ? erpAvailable + offset
      : erpAvailable + Math.abs(offset || 1);
  await shop(world, shopName, {
    kind: 'available',
    variant: variantId,
    location,
    quantity,
  });
  const incident = await openIncident(world, {
    ...(options.id ? { id: options.id } : {}),
    kind,
    origin,
    instance: shopName,
    summary: `${shopInstance.shop.name} shows ${quantity} available for ${variant.sku}; the ERP has ${mirrored(world, erpStock, location)}.`,
    resources: [
      {
        instance: shopName,
        kind: 'InventoryItem',
        id: `gid://shopify/InventoryItem/${variantId}`,
        label: variant.sku,
      },
      {
        instance: shopName,
        kind: 'Location',
        id: `gid://shopify/Location/${location}`,
        label: shopInstance.config.locations[0]?.name ?? location,
      },
      erpResource(world, 'item', variantId, variant.sku),
    ],
    detail: { variant: variantId, sku: variant.sku, location, offset },
  });
  await store.put(
    'freeze',
    freezeKey(shopName, variantId),
    {
      incident: incident.id,
      shop: shopName,
      variant: variantId,
      location,
    } satisfies Freeze,
    {
      updatedAt: world.now,
    },
  );

  return incident;
}

/** Restarts the stock sync for a drifted SKU and matches the shop to the ERP. */
export async function recoverDrift(world: World, incident: Incident) {
  const variant = String(incident.detail.variant);
  const shopName = incident.instance!;
  const shopInstance = instance(world, shopName);
  if (shopInstance.kind !== 'shopify') return;
  const erpStock = await readItemStock(erpContext(world), variant);
  await world
    .store(worldInstance)
    .delete('freeze', freezeKey(shopName, variant));
  await shop(world, shopName, {
    kind: 'available',
    variant,
    location: shopInstance.shop.warehouse,
    quantity: Math.max(
      0,
      erpStock ? mirrored(world, erpStock, shopInstance.shop.warehouse) : 0,
    ),
  });
}
