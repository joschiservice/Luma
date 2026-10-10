import { createMemoryStore } from '@luma/simulator-core';
import type { JtlSeedItem } from '@luma/simulator-jtl';
import type { ShopifySeedProduct } from '@luma/simulator-shopify';
import type { Pool } from 'pg';

import { advanceWorld } from '../engine/advance.js';
import { importOrder, placeOrder } from '../engine/orders.js';
import { erp, shop, type World } from '../engine/world.js';
import { createPgStore } from '../pg-store.js';
import { type RunRecord, saveProgress, saveRun } from './runs.js';
import { createSinks, createWorld, flushSinks, tableFor } from './session.js';

const hour = 3_600_000;

/** Seeds the ERP and every shop from the generated catalog. */
async function seedProviders(world: World) {
  const { catalog, profile } = world.model;
  const product = (id: string) => world.model.product(id);
  const items = catalog.variants.map((variant, index): JtlSeedItem => ({
    id: variant.id,
    sku: variant.sku,
    name:
      variant.title === 'Default Title'
        ? product(variant.productId).title
        : `${product(variant.productId).title} · ${variant.title}`,
    price: variant.price.toFixed(2),
    gtin: variant.barcode,
    manufacturer: product(variant.productId).vendor,
    active: true,
    shopActive: product(variant.productId).published,
    stock: variant.stock,
    suppliers: [
      {
        supplierId: variant.supplierId,
        netPrice: variant.cost,
        isDefault: true,
      },
      // Some items have a second, slightly more expensive source.
      ...(catalog.suppliers.length > 1 && index % 5 === 0
        ? [
            {
              supplierId:
                catalog.suppliers[
                  Number(variant.supplierId) % catalog.suppliers.length
                ]!.id,
              netPrice: Math.round(variant.cost * 107) / 100,
              isDefault: false,
            },
          ]
        : []),
    ],
  }));
  await erp(world, {
    kind: 'seed-catalog',
    items,
    suppliers: catalog.suppliers.map((supplier) => ({
      id: supplier.id,
      companyName: supplier.name,
      supplierNumber: supplier.number,
      city: supplier.city,
      countryIso: supplier.country,
      email: supplier.email,
      profile: supplier.profile,
    })),
  });
  for (const { name, shop: shopProfile } of world.model.shops) {
    const products: ShopifySeedProduct[] = catalog.products.flatMap((item) => {
      const variants = item.variants.filter((variant) =>
        variant.shops.includes(name),
      );
      if (!variants.length) return [];

      return [
        {
          id: item.id,
          title: item.title,
          vendor: item.vendor,
          productType:
            profile.catalog.categories.find(
              (category) => category.code === item.category,
            )?.name ?? item.category,
          published: item.published,
          variants: variants.map((variant) => ({
            id: variant.id,
            sku: variant.sku,
            title: variant.title,
            price: (variant.price * shopProfile.priceFactor).toFixed(2),
            barcode: variant.barcode,
            // Each shop location mirrors the ERP's total stock through the stock connector.
            stock: {
              [shopProfile.warehouse]: Object.values(variant.stock).reduce(
                (sum, value) => sum + value,
                0,
              ),
            },
          })),
        },
      ];
    });
    await shop(world, name, { kind: 'seed-catalog', products });
  }
}

/** Places the fixed orders 1 and 10 that test fixtures and the approval example rely on. */
async function seedFixtures(world: World) {
  if (world.model.profile.name !== 'test') return;
  const shopName = world.model.shops[0]!.name;
  for (const id of ['1', '10']) {
    const order = await placeOrder(world, shopName, {
      identity: `fixture-${id}`,
      id,
      lines: [{ variant: '1', quantity: 2 }],
      shipping: 'standard',
    });
    await importOrder(world, shopName, order.order, id);
  }
}

/**
 * Builds a run's world in memory: catalog, provider seed data, fixtures and `historyHours` of
 * simulated orders before the run's start. Reports progress after each simulated hour.
 */
export async function buildWorld(
  run: RunRecord,
  progress: (
    step: string,
    done: number,
    total: number,
  ) => Promise<void> = async () => undefined,
) {
  const stores = new Map<string, ReturnType<typeof createMemoryStore>>();
  const store = (instance: string) => {
    let value = stores.get(instance);
    if (!value) {
      value = createMemoryStore();
      stores.set(instance, value);
    }

    return value;
  };
  const sinks = createSinks();
  const historyHours = Math.round(run.profile.historyDays * 24);
  const start = run.now;
  const world = createWorld(run, store, sinks, {
    now: start - historyHours * hour,
    live: false,
  });
  await progress(
    'seeding ERP and shops',
    0,
    world.model.catalog.variants.length,
  );
  await seedProviders(world);
  await seedFixtures(world);
  for (let hourIndex = 0; hourIndex < historyHours; hourIndex++) {
    await progress('simulating order history', hourIndex, historyHours);
    await advanceWorld(world, Math.min(start, world.now + hour));
  }
  world.now = start;
  run.state.nextStockSync = start;

  return { world, stores, sinks, historyHours };
}

/**
 * Builds a run's world in memory, then saves it to PostgreSQL in one transaction, because
 * history creates hundreds of thousands of records. Reports progress on the run row.
 */
export async function provisionRun(pool: Pool, run: RunRecord) {
  const progress = (step: string, done: number, total: number) =>
    saveProgress(pool, run.id, { step, done, total });
  const { world, stores, sinks, historyHours } = await buildWorld(
    run,
    progress,
  );
  const snapshots = new Map(
    [...stores].map(([instance, memory]) => [instance, memory.snapshot()]),
  );
  const total = [...snapshots.values()].reduce(
    (sum, value) => sum + value.records.length,
    0,
  );
  await progress('saving records', 0, total);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let saved = 0;
    for (const [instance, snapshot] of snapshots) {
      const target = createPgStore(
        client,
        tableFor(run, instance),
        run.id,
        instance,
      );
      const records = snapshot.records.sort((a, b) => a.seq - b.seq);
      for (let index = 0; index < records.length; index += 10_000) {
        await target.putMany(records.slice(index, index + 10_000));
        saved += Math.min(10_000, records.length - index);
        await progress('saving records', saved, total);
      }
      for (const [name, value] of Object.entries(snapshot.sequences))
        await client.query(
          `INSERT INTO sim_sequences (run_id, instance, name, value) VALUES ($1, $2, $3, $4)
           ON CONFLICT (run_id, instance, name) DO UPDATE SET value = excluded.value`,
          [run.id, instance, name, value],
        );
    }
    world.live = true;
    world.journal('run', {
      profile: run.profile.name,
      seed: run.seed,
      variants: world.model.catalog.variants.length,
      historyHours,
      records: total,
    });
    run.status = 'ready';
    run.progress = null;
    run.now = world.now;
    run.wallAt = Date.now();
    run.running = run.state.startRunning ?? false;
    await saveRun(client, run);
    await flushSinks(client, run, sinks);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Removes a run's provider records, world state and history before provisioning it again. */
export async function clearRun(pool: Pool, runId: string) {
  for (const table of [
    'sim_shopify_records',
    'sim_jtl_records',
    'sim_cin7_records',
    'sim_world_records',
    'sim_sequences',
    'sim_journal',
    'sim_faults',
    'sim_metrics',
    'sim_webhooks',
    'sim_writes',
  ])
    await pool.query(`DELETE FROM ${table} WHERE run_id = $1`, [runId]);
}
