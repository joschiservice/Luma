import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { merchantProfile, merchantProfiles } from '@luma/simulator-commerce';
import {
  controlSchema,
  createRunSchema,
  injectIncidentSchema,
  instanceSchema,
  journalQuerySchema,
  metricsQuerySchema,
  type Profiles,
  recordQuerySchema,
  runIdSchema,
  runScenarioSchema,
  webhookTargetsSchema,
} from '@luma/simulator-contract';
import {
  chaosPreset,
  type ChaosPresetName,
  chaosPresets,
  type ChaosProfile,
  type FaultRule,
  incidentKinds,
  workflowScenarios,
} from '@luma/simulator-core';
import type { JtlCommand } from '@luma/simulator-jtl';
import type { ShopifyCommand } from '@luma/simulator-shopify';
import Fastify from 'fastify';
import pg from 'pg';
import { z } from 'zod';

import {
  gmailCommandSchema,
  jtlCommandSchema,
  shopifyCommandSchema,
} from './commands.js';
import { advanceWorld } from './engine/advance.js';
import { injectIncident, recoverIncident } from './engine/incidents.js';
import { forgetModel, worldModel } from './engine/model.js';
import { placeOrder, placeWholesaleOrder } from './engine/orders.js';
import { erp, type Incident, mail, shop, type World } from './engine/world.js';
import { createDispatcher } from './runtime/dispatch.js';
import { clearRun, provisionRun } from './runtime/provision.js';
import {
  currentTime,
  insertRun,
  listRuns,
  readRun,
  type RunRecord,
  saveRun,
} from './runtime/runs.js';
import {
  type LumaCases,
  readIncidents,
  scorecard,
  viewIncident,
} from './runtime/scorecard.js';
import { withRun } from './runtime/session.js';
import {
  compareSku,
  detail,
  journal,
  metrics,
  recordKinds,
  records,
  searchSkus,
  summarize,
} from './runtime/views.js';
import { createWebhookDelivery } from './runtime/webhooks.js';

const requestSchema = z.object({
  url: z.string().url(),
  method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']),
  headers: z.record(z.string(), z.string()),
  body: z.string().nullable(),
});

const tickMs = 250;
/** One tick never simulates more than this, so catching up after downtime stays responsive. */
const maxCatchUpMs = 5 * 60_000;
/** Longer downtime is skipped instead of replayed. */
const maxReplayMs = 24 * 3_600_000;

const assetTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

export interface SimulatorOptions {
  /** Runtime connection to the simulator database; the role must not own the schema. */
  databaseUrl: string;
  /** Bearer token for every `/api` route; at least 20 characters. */
  token: string;
  /** Advances running clocks in real time; tests advance explicitly instead. */
  autonomous?: boolean | undefined;
  /** Luma inventory checks for a run, provided by the local pilot. */
  operations?:
    | ((runId: string, action: 'status' | 'check') => Promise<unknown>)
    | undefined;
  /** Luma's cases for the scorecard, provided by the local pilot. */
  luma?: LumaCases | undefined;
  /** Built control panel directory. */
  assets?: string | undefined;
}

/**
 * The simulation time of a manual change. A running clock catches up to now; a paused clock
 * moves one millisecond, so successive changes often share one whole-second Shopify update time.
 */
const actionTime = (run: RunRecord) =>
  Math.max(Math.round(currentTime(run)), run.now + 1);

const notFound = (message: string) =>
  Object.assign(new Error(message), { statusCode: 404 });

function chaosFrom(input: string | ChaosProfile): ChaosProfile {
  if (typeof input !== 'string') return input;
  if (!Object.hasOwn(chaosPresets, input))
    throw new Error(`Unknown chaos preset ${input}`);

  return chaosPreset(input as ChaosPresetName);
}

/**
 * Builds the loopback simulator service: provider endpoints, control API, control panel,
 * real-time clock and webhook delivery. Closing it stops background work and the pool.
 */
export async function createApp(options: SimulatorOptions) {
  if (options.token.length < 20)
    throw new Error('Simulator token must have at least 20 characters');
  const app = Fastify({ bodyLimit: 2 * 1024 * 1024 });
  const pool = new pg.Pool({ connectionString: options.databaseUrl, max: 20 });
  // Idle clients can be closed by the server, for example when a test drops its database.
  pool.on('error', (error) =>
    app.log.warn(error, 'Simulator database connection closed'),
  );
  const dispatcher = createDispatcher(pool);

  /**
   * Arms a fault rule in the run's session. With `origin`, an existing rule from the same
   * request is kept instead of arming another.
   */
  async function armFault(
    client: pg.PoolClient,
    run: RunRecord,
    world: World,
    input: Omit<FaultRule, 'id' | 'matches' | 'status' | 'expiresAt'> & {
      lifetimeMs?: number | undefined;
    },
    origin?: string,
  ) {
    if (origin) {
      const existing = await client.query(
        "SELECT 1 FROM sim_faults WHERE run_id = $1 AND rule->>'origin' = $2",
        [run.id, origin],
      );
      if (existing.rowCount) return;
    }
    const { lifetimeMs, ...rule } = input;
    const position = await world.store('world').sequence('fault');
    const fault: FaultRule = {
      ...rule,
      id: `fault-${position}`,
      matches: 0,
      status: 'armed',
      ...(lifetimeMs ? { expiresAt: run.now + lifetimeMs } : {}),
      ...(origin ? { origin } : {}),
    };
    // The session holds the run lock, so its own connection writes the rule.
    await client.query(
      'INSERT INTO sim_faults (run_id, id, rule) VALUES ($1, $2, $3)',
      [run.id, fault.id, fault],
    );
    dispatcher.rulesChanged(run.id);
  }

  const webhooks = createWebhookDelivery(pool);
  const provisioning = new Set<Promise<void>>();
  const assets =
    options.assets ??
    fileURLToPath(new URL('../../simulator-web/dist/', import.meta.url));

  app.addHook('onRequest', async (request, reply) => {
    if (
      request.url.startsWith('/api/') &&
      request.headers.authorization !== `Bearer ${options.token}`
    )
      return reply.code(401).send({ error: 'Simulator token required' });
  });
  app.setErrorHandler((error, _request, reply) => {
    const status =
      error instanceof z.ZodError
        ? 400
        : typeof (error as { statusCode?: unknown }).statusCode === 'number'
          ? (error as { statusCode: number }).statusCode
          : 409;
    void reply.code(status).send({
      error:
        error instanceof z.ZodError
          ? error.issues
              .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
              .join('; ')
          : error instanceof Error
            ? error.message
            : 'Request failed',
    });
  });

  async function serveAsset(
    path: string,
    reply: import('fastify').FastifyReply,
  ) {
    const file = normalize(join(assets, path));
    if (!file.startsWith(normalize(assets))) throw notFound('Not found');
    try {
      return reply
        .type(assetTypes[extname(file)] ?? 'application/octet-stream')
        .header(
          'cache-control',
          path.startsWith('assets/')
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        )
        .send(await readFile(file));
    } catch {
      if (path === 'index.html')
        return reply
          .code(503)
          .type('text/plain')
          .send(
            'Build the control panel first: pnpm --filter @luma/simulator-web build',
          );
      throw notFound('Not found');
    }
  }

  app.get('/', (_request, reply) => serveAsset('index.html', reply));
  app.get('/assets/*', (request, reply) =>
    serveAsset(`assets/${(request.params as { '*': string })['*']}`, reply),
  );

  async function load(id: unknown) {
    const run = await readRun(pool, runIdSchema.parse(id));
    if (!run) throw notFound('Run not found');

    return run;
  }

  function provision(run: RunRecord) {
    const work = provisionRun(pool, run)
      .catch(async (error: unknown) => {
        app.log.error(error);
        run.status = 'failed';
        run.progress = null;
        run.error =
          error instanceof Error ? error.message : 'Provisioning failed';
        await saveRun(pool, run).catch(() => undefined);
      })
      .finally(() => provisioning.delete(work));
    provisioning.add(work);

    return work;
  }

  app.get('/api/profiles', (): Profiles => ({
    merchants: Object.values(merchantProfiles).map((profile) => ({
      name: profile.name,
      label: profile.label,
      description: profile.description,
      erp: profile.erp,
      ordersPerDay: profile.demand.ordersPerDay,
      wholesaleOrdersPerDay:
        'wholesale' in profile ? profile.wholesale.ordersPerDay : 0,
      variants:
        'fixed' in profile.catalog
          ? profile.catalog.fixed.reduce(
              (sum, item) => sum + item.variants.length,
              0,
            )
          : Math.round(
              profile.catalog.products *
                ((profile.catalog.variantsPerProduct[0] +
                  profile.catalog.variantsPerProduct[1]) /
                  2),
            ),
      shops: profile.shops.length,
      warehouses: profile.warehouses.length,
    })),
    chaos: Object.entries(chaosPresets).map(([name, profile]) => ({
      name,
      profile: profile as Profiles['chaos'][number]['profile'],
    })),
    incidents: Object.entries(incidentKinds).map(([kind, definition]) => ({
      kind,
      ...definition,
    })),
  }));
  app.get('/api/runs', async () =>
    Promise.all((await listRuns(pool)).map((run) => summarize(pool, run))),
  );
  app.post('/api/runs', async (request) => {
    const input = createRunSchema.parse(request.body);
    if (!Object.hasOwn(merchantProfiles, input.profile))
      throw new Error(`Unknown merchant profile ${input.profile}`);
    const profile = merchantProfile(
      input.profile as keyof typeof merchantProfiles,
    );
    profile.erp = input.erp ?? profile.erp;
    profile.historyDays = input.historyDays ?? profile.historyDays;
    const now = Date.now();
    const run: RunRecord = {
      id: input.id,
      seed: input.seed,
      profileName: input.profile,
      profile,
      chaos: chaosFrom(input.chaos as string | ChaosProfile),
      status: 'provisioning',
      progress: { step: 'queued', done: 0, total: 1 },
      error: null,
      now,
      running: false,
      speed: 1,
      wallAt: now,
      health: {},
      state: {
        pickCarry: {},
        nextStockSync: now,
        startedAt: now,
        startRunning: input.running,
      },
      createdAt: now,
    };
    await insertRun(pool, run);
    void provision(run);

    return summarize(pool, run);
  });
  app.get('/api/runs/:id', async (request) =>
    detail(pool, await load((request.params as { id: string }).id)),
  );
  app.delete('/api/runs/:id', async (request, reply) => {
    const run = await load((request.params as { id: string }).id);
    if (run.status === 'provisioning')
      throw new Error('Wait until the run finishes provisioning');
    await pool.query('DELETE FROM sim_runs WHERE id = $1', [run.id]);
    forgetModel(run.id);

    return reply.code(204).send();
  });
  app.post('/api/runs/:id/control', async (request) => {
    const id = runIdSchema.parse((request.params as { id: string }).id);
    const input = controlSchema.parse(request.body);
    if (input.action === 'reset') {
      const run = await load(id);
      if (run.status === 'provisioning')
        throw new Error('The run is already provisioning');
      await clearRun(pool, id);
      forgetModel(id);
      const now = Math.max(Date.now(), run.now + 1);
      Object.assign(run, {
        status: 'provisioning',
        progress: { step: 'queued', done: 0, total: 1 },
        error: null,
        now,
        running: false,
        wallAt: now,
        health: {},
        state: {
          pickCarry: {},
          nextStockSync: now,
          startedAt: now,
          startRunning: false,
        },
      } satisfies Partial<RunRecord>);
      await saveRun(pool, run);
      void provision(run);

      return detail(pool, run);
    }
    await withRun(pool, id, async ({ client, run, world }) => {
      if (run.status !== 'ready') throw new Error('The run is not ready');
      if (
        input.action === 'command' ||
        input.action === 'order' ||
        input.action === 'wholesale-order'
      )
        await advanceWorld(world, actionTime(run));
      world.journal('control', input);
      switch (input.action) {
        case 'pause':
          run.running = false;
          break;
        case 'resume':
          run.running = true;
          // At real-time speed, a run that fell behind catches up with real time, because
          // Luma's freshness and timing rules compare provider times with real time.
          run.wallAt =
            run.speed === 1 && run.now < Date.now() ? run.now : Date.now();
          break;
        case 'speed':
          run.speed = input.speed;
          run.wallAt = Date.now();
          break;
        case 'advance':
          await advanceWorld(world, run.now + input.milliseconds);
          run.wallAt = Date.now();
          break;
        case 'command': {
          const target = world.model.instances.find(
            (item) => item.name === input.instance,
          );
          if (!target) throw notFound('Unknown instance');
          if (target.kind === 'gmail')
            await mail(world, gmailCommandSchema.parse(input.command));
          else if (target.kind !== 'shopify')
            await erp(
              world,
              jtlCommandSchema.parse(input.command) as JtlCommand,
            );
          else
            await shop(
              world,
              target.name,
              shopifyCommandSchema.parse(input.command) as ShopifyCommand,
            );
          world.journal('merchant', input.command, input.instance);
          break;
        }
        case 'order': {
          const shopName = input.shop ?? world.model.shops[0]!.name;
          await placeOrder(world, shopName, {
            identity: `manual:${await world.store('world').sequence('manual-order')}`,
            ...(input.lines
              ? {
                  lines: input.lines.map((line) => {
                    const variant = world.model.variantBySku(line.sku);
                    if (!variant) throw notFound(`Unknown SKU ${line.sku}`);

                    return { variant: variant.id, quantity: line.quantity };
                  }),
                }
              : {}),
            ...(input.shipping ? { shipping: input.shipping } : {}),
          });
          break;
        }
        case 'wholesale-order':
          if (!run.profile.wholesale)
            throw new Error(`${run.profileName} sells no wholesale`);
          await placeWholesaleOrder(
            world,
            `manual:${await world.store('world').sequence('manual-wholesale')}`,
          );
          break;
        case 'fault':
          await armFault(client, run, world, input.rule);
          break;
        case 'disable': {
          const { rows } = await client.query<{ rule: FaultRule }>(
            'SELECT rule FROM sim_faults WHERE run_id = $1 AND id = $2',
            [run.id, input.id],
          );
          if (!rows[0]) throw notFound('Fault not found');
          await client.query(
            'UPDATE sim_faults SET rule = $3 WHERE run_id = $1 AND id = $2',
            [run.id, input.id, { ...rows[0].rule, status: 'disabled' }],
          );
          dispatcher.rulesChanged(run.id);
          break;
        }
        case 'service-health':
          instanceSchema.parse(input.instance);
          if (
            !world.model.instances.some((item) => item.name === input.instance)
          )
            throw notFound('Unknown instance');
          if (input.status === 'healthy') delete run.health[input.instance];
          else run.health[input.instance] = { status: input.status };
          break;
        case 'chaos':
          run.chaos = chaosFrom(input.chaos as string | ChaosProfile);
          break;
      }
    });

    return detail(pool, await load(id));
  });
  app.get('/api/runs/:id/journal', async (request) => {
    const run = await load((request.params as { id: string }).id);

    return journal(pool, run.id, journalQuerySchema.parse(request.query));
  });
  app.get('/api/runs/:id/metrics', async (request) => {
    const run = await load((request.params as { id: string }).id);

    return metrics(pool, run, metricsQuerySchema.parse(request.query).windowMs);
  });
  app.get('/api/runs/:id/incidents', async (request) => {
    const run = await load((request.params as { id: string }).id);
    const incidents = await readIncidents(pool, run);
    let cases = null;
    if (options.luma) cases = await options.luma(run.id).catch(() => null);

    return incidents.map((incident) =>
      viewIncident(incident, cases, currentTime(run)),
    );
  });
  app.post('/api/runs/:id/incidents', async (request) => {
    const id = runIdSchema.parse((request.params as { id: string }).id);
    const input = injectIncidentSchema.parse(request.body);
    const incident = await withRun(pool, id, async ({ run, world }) => {
      if (run.status !== 'ready') throw new Error('The run is not ready');
      await advanceWorld(world, actionTime(run));

      return injectIncident(world, input);
    });

    return viewIncident(incident, null, Date.now());
  });
  app.post('/api/runs/:id/incidents/:incident/recover', async (request) => {
    const params = z
      .object({ id: runIdSchema, incident: z.string().uuid() })
      .parse(request.params);
    const incident = await withRun(pool, params.id, async ({ run, world }) => {
      await advanceWorld(world, actionTime(run));

      return recoverIncident(world, params.incident);
    });
    if (!incident) throw notFound('Incident not found');

    return viewIncident(incident, null, Date.now());
  });
  app.post('/api/runs/:id/scenarios', async (request) => {
    const id = runIdSchema.parse((request.params as { id: string }).id);
    const input = runScenarioSchema.parse(request.body);
    const scenario = workflowScenarios[input.scenario];
    const incidents = await withRun(
      pool,
      id,
      async ({ client, run, world }) => {
        if (run.status !== 'ready') throw new Error('The run is not ready');
        await advanceWorld(world, actionTime(run));
        const targets = {
          shop: world.model.shops[0]!.name,
          mailbox: world.model.mailbox.name,
        };
        const started: Incident[] = [];
        for (const [index, step] of scenario.steps.entries()) {
          const origin = `${input.id}:${index}`;
          if (step.kind === 'fault')
            await armFault(
              client,
              run,
              world,
              {
                instance: targets[step.on],
                operation: step.operation,
                kind: step.fault,
                occurrence: 1,
                remaining: step.remaining,
                lifetimeMs: step.lifetimeMs,
              },
              origin,
            );
          else
            started.push(
              await injectIncident(world, {
                id: scenarioIncidentId(origin),
                kind: step.incident,
                instance: targets[step.on],
              }),
            );
        }

        return started;
      },
    );

    return incidents.map((incident) =>
      viewIncident(incident, null, Date.now()),
    );
  });
  app.get('/api/runs/:id/scorecard', async (request) =>
    scorecard(
      pool,
      await load((request.params as { id: string }).id),
      options.luma,
    ),
  );
  app.get('/api/runs/:id/records/:instance/kinds', async (request) => {
    const params = request.params as { id: string; instance: string };
    const run = await load(params.id);

    return recordKinds(pool, run, instanceSchema.parse(params.instance));
  });
  app.get('/api/runs/:id/records/:instance', async (request) => {
    const params = request.params as { id: string; instance: string };
    const run = await load(params.id);

    return records(
      pool,
      run,
      instanceSchema.parse(params.instance),
      recordQuerySchema.parse(request.query),
    );
  });
  app.get('/api/runs/:id/skus', async (request) => {
    const run = await load((request.params as { id: string }).id);

    return searchSkus(
      run,
      z.object({ q: z.string().max(100).default('') }).parse(request.query).q,
    );
  });
  app.get('/api/runs/:id/skus/:sku', async (request) => {
    const params = request.params as { id: string; sku: string };

    return compareSku(
      pool,
      await load(params.id),
      z.string().min(1).max(100).parse(params.sku),
    );
  });
  app.put('/api/runs/:id/webhooks', async (request) => {
    const run = await load((request.params as { id: string }).id);
    const input = webhookTargetsSchema.parse(request.body);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM sim_webhook_targets WHERE run_id = $1', [
        run.id,
      ]);
      for (const target of input.targets) {
        if (
          !run.profile.shops.some(
            (shopProfile) => shopProfile.instance === target.instance,
          )
        )
          throw notFound(`Unknown shop ${target.instance}`);
        await client.query(
          'INSERT INTO sim_webhook_targets (run_id, instance, url, secret) VALUES ($1, $2, $3, $4)',
          [run.id, target.instance, target.url, target.secret],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return {
      targets: input.targets.map(({ instance, url }) => ({ instance, url })),
    };
  });
  for (const action of ['status', 'check'] as const)
    app.route({
      method: action === 'status' ? 'GET' : 'POST',
      url: `/api/runs/:id/operations${action === 'check' ? '/check' : ''}`,
      async handler(request) {
        const run = await load((request.params as { id: string }).id);

        return options.operations
          ? options.operations(run.id, action)
          : { connected: false };
      },
    });
  app.post(
    '/api/runs/:id/providers/:instance/request',
    async (request, reply) => {
      const params = z
        .object({ id: runIdSchema, instance: instanceSchema })
        .parse(request.params);
      const result = await dispatcher.dispatch(
        params.id,
        params.instance,
        requestSchema.parse(request.body),
      );
      if (result.kind === 'reset') {
        reply.hijack();
        reply.raw.destroy();

        return;
      }

      return result.response;
    },
  );

  let ticking: Promise<void> | undefined;

  async function tick() {
    const runs = (await listRuns(pool)).filter(
      (run) => run.running && run.status === 'ready',
    );
    for (const candidate of runs)
      await withRun(pool, candidate.id, async ({ run, world }) => {
        if (!run.running || run.status !== 'ready') return;
        const wall = Date.now();
        const target = Math.round(
          run.now + Math.max(0, wall - run.wallAt) * run.speed,
        );
        if (target - run.now > maxReplayMs) {
          world.journal('clock-skipped', {
            fromMs: run.now,
            toMs: target - maxReplayMs,
          });
          run.now = target - maxReplayMs;
          world.now = run.now;
        }
        const end = Math.min(target, run.now + maxCatchUpMs);
        await advanceWorld(world, end);
        // While catching up, keep the real time that is still owed.
        run.wallAt = Math.round(
          end >= target ? wall : wall - (target - end) / run.speed,
        );
        run.now = end;
      }).catch(async (error: unknown) => {
        app.log.error(error);
        // A failed transition pauses this run; others keep running.
        await withRun(pool, candidate.id, async ({ run, world }) => {
          run.running = false;
          world.journal('scenario-error', {
            message:
              error instanceof Error ? error.message : 'Transition failed',
          });
        }).catch(() => undefined);
      });
  }

  const timer =
    options.autonomous === false
      ? undefined
      : setInterval(() => {
          ticking ??= tick()
            .catch((error: unknown) => app.log.error(error))
            .finally(() => {
              ticking = undefined;
            });
        }, tickMs);
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
    await ticking;
    await Promise.allSettled([...provisioning]);
    await webhooks.close();
    await dispatcher.close();
    await pool.end();
  });

  return Object.assign(app, {
    /** Resolves once every queued provisioning job has finished. */
    async provisioned() {
      await Promise.allSettled([...provisioning]);
    },
    /** Reads the world model of a run, for tests and the pilot's SKU bindings. */
    async model(runId: string) {
      const run = await readRun(pool, runId);
      if (!run) throw notFound('Run not found');

      return worldModel(run.id, run.profile, run.seed);
    },
  });
}

/** A stable incident ID for one scenario step, so a repeated request injects nothing new. */
function scenarioIncidentId(origin: string) {
  const hex = createHash('sha256').update(origin).digest('hex');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
