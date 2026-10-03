import type {
  Metrics,
  MetricSeries,
  RunDetail,
  RunSummary,
  SkuComparison,
} from '@luma/simulator-contract';
import type { FaultRule, JournalEntry } from '@luma/simulator-core';
import { readItemStock } from '@luma/simulator-jtl';
import { readStock } from '@luma/simulator-shopify';
import type { Pool } from 'pg';

import { instancesFor, worldModel } from '../engine/model.js';
import { erpContext, type Incident, shopContext } from '../engine/world.js';
import { createPgStore, type RecordTable } from '../pg-store.js';
import { currentTime, type RunRecord } from './runs.js';
import { createSinks, createWorld, tableFor } from './session.js';

const minute = 60_000;

/** Summarizes a run for lists without reading provider records. */
export async function summarize(
  pool: Pool,
  run: RunRecord,
): Promise<RunSummary> {
  const { rows } = await pool.query<{ orders: string; incidents: string }>(
    `SELECT
       (SELECT count(*) FROM sim_world_records WHERE run_id = $1 AND instance = 'world' AND kind = 'order') AS orders,
       (SELECT count(*) FROM sim_world_records WHERE run_id = $1 AND instance = 'world' AND kind = 'incident' AND key = 'active') AS incidents,
       (SELECT count(*) FROM sim_world_records WHERE run_id = $1 AND instance = 'world' AND kind = 'event') AS events`,
    [run.id],
  );
  const now = currentTime(run);
  const wall = Date.now();

  return {
    id: run.id,
    seed: run.seed,
    profile: { name: run.profile.name, label: run.profile.label },
    status: run.status,
    progress: run.progress,
    error: run.error,
    clock: {
      now,
      running: run.running,
      speed: run.speed,
      offsetMs: run.status === 'ready' ? Math.round(now - wall) : 0,
      scheduledEvents: Number((rows[0] as { events?: string })?.events ?? 0),
    },
    chaos: { preset: run.chaos.preset },
    instances: instancesFor(run.profile).map((instance) => ({
      name: instance.name,
      kind: instance.kind,
      label: instance.label,
      health: run.health[instance.name]?.status ?? 'healthy',
    })),
    counts: {
      orders: Number(rows[0]?.orders ?? 0),
      activeIncidents: Number(rows[0]?.incidents ?? 0),
    },
    createdAt: run.createdAt,
  };
}

/** Adds the chaos profile, merchant setup, fault rules and webhook targets. */
export async function detail(pool: Pool, run: RunRecord): Promise<RunDetail> {
  const [summary, faults, webhooks] = await Promise.all([
    summarize(pool, run),
    pool.query<{ rule: FaultRule }>(
      'SELECT rule FROM sim_faults WHERE run_id = $1 ORDER BY position',
      [run.id],
    ),
    pool.query<{ instance: string; url: string }>(
      'SELECT instance, url FROM sim_webhook_targets WHERE run_id = $1 ORDER BY instance',
      [run.id],
    ),
  ]);
  const model = worldModel(run.id, run.profile, run.seed);

  return {
    ...summary,
    chaosProfile: run.chaos as RunDetail['chaosProfile'],
    merchant: {
      description: run.profile.description,
      ordersPerDay: run.profile.demand.ordersPerDay,
      autonomous: run.profile.demand.autonomous,
      variants: model.catalog.variants.length,
      shops: run.profile.shops.map((shop) => ({
        instance: shop.instance,
        name: shop.name,
        domain: shop.domain,
        currency: shop.currency,
        location: shop.warehouse,
      })),
      warehouses: run.profile.warehouses.map(({ id, name, picksPerHour }) => ({
        id,
        name,
        picksPerHour,
      })),
    },
    faults: faults.rows.map(({ rule }) => ({
      id: rule.id,
      instance: rule.instance,
      operation: rule.operation,
      resource: rule.resource,
      kind: rule.kind,
      occurrence: rule.occurrence,
      remaining: rule.remaining,
      expiresAt: rule.expiresAt ?? null,
      status: rule.status,
    })),
    webhooks: webhooks.rows,
  };
}

/** Reads journal entries newest first with an exclusive cursor. */
export async function journal(
  pool: Pool,
  runId: string,
  query: {
    limit: number;
    before?: number | undefined;
    kind?: string | undefined;
    instance?: string | undefined;
  },
) {
  const values: unknown[] = [
    runId,
    query.before ?? Number.MAX_SAFE_INTEGER,
    query.limit + 1,
  ];
  const filters = [
    ...(query.kind ? [`kind = $${values.push(query.kind)}`] : []),
    ...(query.instance ? [`instance = $${values.push(query.instance)}`] : []),
  ];
  const { rows } = await pool.query<{
    id: string;
    time: string;
    kind: string;
    instance: string | null;
    resource: string | null;
    detail: unknown;
  }>(
    `SELECT id, time, kind, instance, resource, detail FROM sim_journal
     WHERE run_id = $1 AND id < $2${filters.map((filter) => ` AND ${filter}`).join('')}
     ORDER BY id DESC LIMIT $3`,
    values,
  );
  const items: JournalEntry[] = rows.slice(0, query.limit).map((row) => ({
    sequence: Number(row.id),
    time: Number(row.time),
    kind: row.kind,
    ...(row.instance ? { instance: row.instance } : {}),
    ...(row.resource ? { resource: row.resource } : {}),
    detail: row.detail,
  }));

  return {
    items,
    nextCursor: rows.length > query.limit ? items.at(-1)!.sequence : null,
  };
}

/** Gauges keep the highest value in a bucket; every other series is a count. */
const gauges = new Set(['backlog']);

/**
 * Reads series for the window ending at the run's current time. Buckets grow with the window,
 * from one minute for an hour to one hour for a week, so charts keep about 100 bars.
 */
export async function metrics(
  pool: Pool,
  run: RunRecord,
  windowMs: number,
): Promise<Metrics> {
  const to = currentTime(run);
  const bucketMs =
    [minute, 5 * minute, 15 * minute, 60 * minute].find(
      (size) => windowMs / size <= 150,
    ) ?? 60 * minute;
  const from = Math.floor((to - windowMs) / bucketMs) * bucketMs;
  const { rows } = await pool.query<{
    name: string;
    instance: string;
    bucket: string;
    value: number;
  }>(
    `SELECT name, instance, (bucket / $3) * $3 AS bucket,
       CASE WHEN name = ANY($4::text[]) THEN max(value) ELSE sum(value) END AS value
     FROM sim_metrics WHERE run_id = $1 AND bucket >= $2
     GROUP BY name, instance, (bucket / $3) * $3 ORDER BY 3`,
    [run.id, from, bucketMs, [...gauges]],
  );
  const series = new Map<string, MetricSeries>();
  const add = (
    name: string,
    instance: string,
    bucket: number,
    value: number,
  ) => {
    const key = `${name}\u0000${instance}`;
    let entry = series.get(key);
    if (!entry) {
      entry = { name, instance: instance || null, points: [] };
      series.set(key, entry);
    }
    entry.points.push([bucket, value]);
  };
  const requests = new Map<string, number>();
  for (const row of rows)
    if (row.name === 'requests')
      requests.set(`${row.instance}\u0000${row.bucket}`, row.value);
  for (const row of rows) {
    if (row.name === 'latency.total') {
      const count = requests.get(`${row.instance}\u0000${row.bucket}`);
      if (count)
        add(
          'latency.mean',
          row.instance,
          Number(row.bucket),
          Math.round(row.value / count),
        );
      continue;
    }
    add(row.name, row.instance, Number(row.bucket), row.value);
  }

  return { bucketMs, from, to, series: [...series.values()] };
}

/** Lists record kinds and counts of one provider instance. */
export async function recordKinds(
  pool: Pool,
  run: RunRecord,
  instance: string,
) {
  const table: RecordTable = tableFor(run, instance);
  const { rows } = await pool.query<{ kind: string; count: string }>(
    `SELECT kind, count(*) FROM ${table} WHERE run_id = $1 AND instance = $2 GROUP BY kind ORDER BY kind`,
    [run.id, instance],
  );

  return rows.map((row) => ({ kind: row.kind, count: Number(row.count) }));
}

/** Pages provider records newest first for inspection. */
export async function records(
  pool: Pool,
  run: RunRecord,
  instance: string,
  query: {
    kind: string;
    after?: string | undefined;
    limit: number;
    parent?: string | undefined;
  },
) {
  const client = await pool.connect();
  try {
    const page = await createPgStore(
      client,
      tableFor(run, instance),
      run.id,
      instance,
    ).page({
      kind: query.kind,
      parent: query.parent,
      after: query.after,
      limit: query.limit,
      reverse: true,
    });

    return {
      items: page.items.map((record) => ({
        kind: record.kind,
        id: record.id,
        parent: record.parent,
        key: record.key,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        data: record.data,
      })),
      next: page.next,
    };
  } finally {
    client.release();
  }
}

/** Finds SKUs by code or product name prefix. */
export function searchSkus(run: RunRecord, query: string) {
  const model = worldModel(run.id, run.profile, run.seed);
  const needle = query.trim().toLowerCase();
  const results: { sku: string; name: string }[] = [];
  for (const variant of model.catalog.variants) {
    const name = model.product(variant.productId).title;
    if (
      !needle ||
      variant.sku.toLowerCase().startsWith(needle) ||
      name.toLowerCase().startsWith(needle)
    )
      results.push({
        sku: variant.sku,
        name:
          variant.title === 'Default Title'
            ? name
            : `${name} · ${variant.title}`,
      });
    if (results.length >= 20) break;
  }

  return results;
}

/** Compares a SKU's ERP stock with every shop that lists it. */
export async function compareSku(
  pool: Pool,
  run: RunRecord,
  sku: string,
): Promise<SkuComparison> {
  const client = await pool.connect();
  try {
    const world = createWorld(
      run,
      (instance) =>
        createPgStore(client, tableFor(run, instance), run.id, instance),
      createSinks(),
      { now: currentTime(run), live: true },
    );
    const variant = world.model.variantBySku(sku);
    if (!variant)
      throw Object.assign(new Error('SKU not found'), { statusCode: 404 });
    const erp = await readItemStock(erpContext(world), variant.id);
    const shops: SkuComparison['shops'] = [];
    for (const shop of world.model.shops.filter((item) =>
      variant.shops.includes(item.name),
    )) {
      const stock = await readStock(
        shopContext(world, shop.name),
        variant.id,
        shop.shop.warehouse,
      );
      shops.push({
        instance: shop.name,
        variant: `gid://shopify/ProductVariant/${variant.id}`,
        location: `gid://shopify/Location/${shop.shop.warehouse}`,
        onHand: stock?.onHand ?? 0,
        committed: stock?.committed ?? 0,
        available: stock?.available ?? 0,
        drift:
          stock && erp ? stock.available - Math.max(0, erp.available) : null,
      });
    }
    const incidents = await world
      .store('world')
      .page<Incident>({ kind: 'incident', key: 'active', limit: 200 });
    const product = world.model.product(variant.productId);

    return {
      sku,
      name:
        variant.title === 'Default Title'
          ? product.title
          : `${product.title} · ${variant.title}`,
      erp: erp ? { instance: 'jtl', itemId: variant.id, ...erp } : null,
      shops,
      incidents: incidents.items
        .filter((item) => item.data.detail.variant === variant.id)
        .map((item) => item.id),
    };
  } finally {
    client.release();
  }
}
