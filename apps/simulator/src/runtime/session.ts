import { randomUUID } from 'node:crypto';

import {
  decideWebhook,
  type ProviderEvent,
  type RecordStore,
} from '@luma/simulator-core';
import { jtl } from '@luma/simulator-jtl';
import { shopify } from '@luma/simulator-shopify';
import type { Pool, PoolClient } from 'pg';

import { cin7 } from '../engine/cin7.js';
import { worldModel } from '../engine/model.js';
import { type World, worldInstance } from '../engine/world.js';
import { createPgStore, type RecordTable } from '../pg-store.js';
import { readRun, type RunRecord, saveRun } from './runs.js';

const minute = 60_000;

/** Buffered side effects of one engine or request transaction. */
export interface Sinks {
  journal: {
    time: number;
    kind: string;
    instance: string | null;
    resource: string | null;
    detail: unknown;
  }[];
  metrics: Map<
    string,
    {
      name: string;
      instance: string;
      bucket: number;
      value: number;
      mode: 'add' | 'max';
    }
  >;
  webhooks: { instance: string; event: ProviderEvent }[];
}

/** Creates empty sinks. */
export const createSinks = (): Sinks => ({
  journal: [],
  metrics: new Map(),
  webhooks: [],
});

/** The record table each provider kind owns. */
export function tableFor(run: RunRecord, name: string): RecordTable {
  if (name === worldInstance) return 'sim_world_records';
  const erp = run.profile.erp ?? 'jtl';
  const kind =
    name === erp
      ? erp === 'cin7'
        ? cin7
        : jtl
      : run.profile.shops.some((shop) => shop.instance === name)
        ? shopify
        : undefined;
  if (!kind) throw new Error(`Unknown instance ${name}`);

  return kind.table as RecordTable;
}

/** Builds an engine world over the given stores and sinks. */
export function createWorld(
  run: RunRecord,
  stores: (instance: string) => RecordStore,
  sinks: Sinks,
  options: { now: number; live: boolean; wallTime?: number },
): World {
  return {
    run: {
      id: run.id,
      seed: run.seed,
      profile: run.profile,
      chaos: run.chaos,
      startedAt: run.state.startedAt,
      state: run.state,
      health: run.health,
    },
    model: worldModel(run.id, run.profile, run.seed),
    now: options.now,
    wallTime: options.wallTime ?? Date.now(),
    live: options.live,
    store: stores,
    journal(kind, detail, instance, resource) {
      if (!this.live && kind !== 'run') return;
      sinks.journal.push({
        time: this.now,
        kind,
        instance: instance ?? null,
        resource: resource ?? null,
        detail,
      });
    },
    metric(name, value, instance = '', mode = 'add') {
      const bucket = Math.floor(this.now / minute) * minute;
      const key = `${name}\u0000${instance}\u0000${bucket}`;
      const current = sinks.metrics.get(key);
      if (!current)
        sinks.metrics.set(key, { name, instance, bucket, value, mode });
      else
        current.value =
          mode === 'max'
            ? Math.max(current.value, value)
            : current.value + value;
    },
    webhook(instance, event) {
      if (this.live) sinks.webhooks.push({ instance, event });
    },
  };
}

/** Writes buffered journal entries, metrics and webhooks in the caller's transaction. */
export async function flushSinks(
  client: PoolClient,
  run: RunRecord,
  sinks: Sinks,
) {
  if (sinks.journal.length)
    await client.query(
      `INSERT INTO sim_journal (run_id, time, kind, instance, resource, detail)
       SELECT $1, r.time, r.kind, r.instance, r.resource, r.detail
       FROM jsonb_to_recordset($2::jsonb) AS r(time bigint, kind text, instance text, resource text, detail jsonb)`,
      [run.id, JSON.stringify(sinks.journal)],
    );
  const metrics = [...sinks.metrics.values()];
  for (const mode of ['add', 'max'] as const) {
    const rows = metrics.filter((metric) => metric.mode === mode);
    if (rows.length)
      await client.query(
        `INSERT INTO sim_metrics (run_id, name, instance, bucket, value)
         SELECT $1, r.name, r.instance, r.bucket, r.value
         FROM jsonb_to_recordset($2::jsonb) AS r(name text, instance text, bucket bigint, value double precision)
         ON CONFLICT (run_id, name, instance, bucket) DO UPDATE SET value = ${
           mode === 'add'
             ? 'sim_metrics.value + excluded.value'
             : 'GREATEST(sim_metrics.value, excluded.value)'
         }`,
        [run.id, JSON.stringify(rows)],
      );
  }
  if (sinks.webhooks.length) {
    const { rows: targets } = await client.query<{ instance: string }>(
      'SELECT instance FROM sim_webhook_targets WHERE run_id = $1',
      [run.id],
    );
    const subscribed = new Set(targets.map((target) => target.instance));
    const deliveries = sinks.webhooks.flatMap(({ instance, event }) => {
      if (!subscribed.has(instance)) return [];
      const eventId = randomUUID();
      const decision = decideWebhook(run.chaos, run.seed, eventId);
      const body = event.payload;
      const delivery = (delay: number, status: 'pending' | 'dropped') => ({
        instance,
        topic: event.topic,
        event_id: eventId,
        body,
        due_at: Math.round(Date.now() + delay),
        status,
      });

      return [
        delivery(decision.delayMs, decision.drop ? 'dropped' : 'pending'),
        ...(decision.duplicate && !decision.drop
          ? [
              delivery(
                Math.round(decision.delayMs * 1.5) + 1_000,
                'pending' as const,
              ),
            ]
          : []),
      ];
    });
    const dropped = deliveries.filter(
      (delivery) => delivery.status === 'dropped',
    );
    for (const delivery of dropped)
      await client.query(
        `INSERT INTO sim_metrics (run_id, name, instance, bucket, value) VALUES ($1, 'webhooks.dropped', $2, $3, 1)
         ON CONFLICT (run_id, name, instance, bucket) DO UPDATE SET value = sim_metrics.value + 1`,
        [run.id, delivery.instance, Math.floor(run.now / minute) * minute],
      );
    if (deliveries.length)
      await client.query(
        `INSERT INTO sim_webhooks (run_id, instance, topic, event_id, body, due_at, status)
         SELECT $1, r.instance, r.topic, r.event_id, r.body, r.due_at, r.status
         FROM jsonb_to_recordset($2::jsonb) AS r(instance text, topic text, event_id text, body jsonb, due_at bigint, status text)`,
        [run.id, JSON.stringify(deliveries)],
      );
  }
}

/**
 * Runs work against a locked run in one transaction, then saves the run and its buffered
 * effects. Provider writes and clock ticks use this so they serialize per run.
 */
export async function withRun<T>(
  pool: Pool,
  id: string,
  work: (session: {
    client: PoolClient;
    run: RunRecord;
    world: World;
    sinks: Sinks;
  }) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const run = await readRun(client, id, true);
    if (!run)
      throw Object.assign(new Error('Run not found'), { statusCode: 404 });
    const sinks = createSinks();
    const world = createWorld(
      run,
      (instance) =>
        createPgStore(client, tableFor(run, instance), run.id, instance),
      sinks,
      { now: run.now, live: true },
    );
    const result = await work({ client, run, world, sinks });
    run.now = Math.max(run.now, Math.round(world.now));
    await saveRun(client, run);
    await flushSinks(client, run, sinks);
    await client.query('COMMIT');

    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
