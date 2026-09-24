import { readFile } from 'node:fs/promises';

import { journal } from '@luma/simulator-core';
import Fastify from 'fastify';
import { z } from 'zod';

import {
  injectInventoryMismatch,
  recoverInventoryMismatch,
} from './operational-scenarios.js';
import { type Measure, unmeasured } from './performance.js';
import {
  advanceRun,
  createRun,
  dispatch,
  faultSchema,
  mutate,
  serviceHealthSchema,
} from './run.js';
import { openStore } from './store.js';

const runId = z.string().regex(/^[a-z0-9-]{1,64}$/);
const instance = z.enum(['jtl', 'shopify']);
const requestSchema = z.object({
  url: z.string().url(),
  method: z.enum(['GET', 'POST', 'PATCH']),
  headers: z.record(z.string()),
  body: z.string().nullable(),
});
const controlSchema = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['pause', 'resume', 'reset']) }),
  z.object({
    action: z.literal('advance'),
    milliseconds: z.number().min(0).max(86400000),
  }),
  z.object({ action: z.literal('speed'), speed: z.number().min(0.1).max(100) }),
  z.object({ action: z.literal('command'), instance, command: z.unknown() }),
  z.object({ action: z.literal('fault'), rule: faultSchema }),
  z.object({
    action: z.literal('service-health'),
    instance,
    status: serviceHealthSchema,
  }),
  z.object({ action: z.literal('disable'), id: z.string() }),
]);

/** Builds the loopback control service and autonomous runner. Closing it drains durable writes. */
export async function createApp(
  path: string,
  token: string,
  autonomous = true,
  measure: Measure = unmeasured,
  operations?: (runId: string, action: 'status' | 'check') => Promise<unknown>,
) {
  if (token.length < 20)
    throw new Error('Simulator token must have at least 20 characters');
  const store = await openStore(path, measure);
  const app = Fastify({ bodyLimit: 1024 * 1024 });
  app.addHook('onRequest', async (request, reply) => {
    if (
      request.routeOptions.url?.startsWith('/api/') &&
      request.headers.authorization !== `Bearer ${token}`
    )
      return reply.code(401).send({ error: 'Simulator token required' });
  });
  app.setErrorHandler((error, _request, reply) =>
    reply.code(error instanceof z.ZodError ? 400 : 409).send({
      error: error instanceof Error ? error.message : 'Request failed',
    }),
  );
  for (const [url, file, type] of [
    ['/', 'index.html', 'text/html'],
    ['/app.js', 'app.js', 'text/javascript'],
    ['/style.css', 'style.css', 'text/css'],
  ]) {
    app.get(url!, async (_request, reply) =>
      reply
        .type(type!)
        .send(
          await readFile(
            new URL(`../../simulator-web/src/${file}`, import.meta.url),
            'utf8',
          ),
        ),
    );
  }
  app.get('/api/runs', () => store.transact((runs) => Object.values(runs)));
  app.post('/api/runs', async (request) => {
    const input = z
      .object({
        id: runId,
        seed: z.number().int().min(0).max(4294967295).default(44),
        scenario: z.enum(['commerce', 'manual']).default('commerce'),
      })
      .parse(request.body);

    return store.transact((runs) => {
      if (runs[input.id]) throw new Error('Run already exists');
      const run = createRun(input.id, input.seed, input.scenario);
      runs[input.id] = run;

      return run;
    });
  });
  app.post('/api/runs/:id/control', async (request) => {
    const { id } = z.object({ id: runId }).parse(request.params);
    const input = controlSchema.parse(request.body);

    return store.transact((runs) => {
      const run = runs[id];
      if (!run) throw new Error('Run not found');
      journal(run.clock, 'control', input);
      if (input.action === 'pause') run.clock.running = false;
      if (input.action === 'resume') run.clock.running = true;
      if (input.action === 'reset')
        runs[id] = createRun(
          id,
          run.seed,
          run.scenario,
          Math.max(
            run.clock.now,
            ...run.jtl.items.map((item) =>
              item.modifiedTimestamp ? Date.parse(item.modifiedTimestamp) : 0,
            ),
          ) + 1,
        );
      if (input.action === 'advance')
        measure('simulator.advance', () => advanceRun(run, input.milliseconds));
      if (input.action === 'speed') run.clock.speed = input.speed;
      if (input.action === 'command')
        mutate(run, input.instance, input.command);
      if (input.action === 'service-health')
        run.serviceHealth[input.instance] = input.status;
      if (input.action === 'fault') {
        const { lifetimeMs, ...rule } = input.rule;
        run.clock.faults.push({
          ...rule,
          id: `fault-${++run.clock.sequence}`,
          matches: 0,
          status: 'armed',
          ...(lifetimeMs ? { expiresAt: run.clock.now + lifetimeMs } : {}),
        });
      }
      if (input.action === 'disable') {
        const fault = run.clock.faults.find((f) => f.id === input.id);
        if (!fault) throw new Error('Fault not found');
        fault.status = 'disabled';
      }

      return runs[id];
    });
  });
  app.post('/api/runs/:id/scenarios', async (request) => {
    const { id } = z.object({ id: runId }).parse(request.params);
    const input = z
      .object({ id: z.string().uuid(), kind: z.literal('inventory-mismatch') })
      .strict()
      .parse(request.body);

    return store.transact((runs) => {
      const run = runs[id];
      if (!run) throw new Error('Run not found');

      return injectInventoryMismatch(run, input.id);
    });
  });
  app.post('/api/runs/:id/scenarios/:scenarioId/recover', async (request) => {
    const { id, scenarioId } = z
      .object({ id: runId, scenarioId: z.string().uuid() })
      .parse(request.params);

    return store.transact((runs) => {
      const run = runs[id];
      if (!run) throw new Error('Run not found');

      return recoverInventoryMismatch(run, scenarioId);
    });
  });
  for (const action of ['status', 'check'] as const) {
    app.route({
      method: action === 'status' ? 'GET' : 'POST',
      url: `/api/runs/:id/operations${action === 'check' ? '/check' : ''}`,
      async handler(request) {
        const { id } = z.object({ id: runId }).parse(request.params);
        const exists = await store.transact((runs) => !!runs[id]);
        if (!exists) throw new Error('Run not found');

        return operations ? operations(id, action) : { connected: false };
      },
    });
  }
  app.post('/api/runs/:id/providers/:instance/request', async (request) => {
    const target = z.object({ id: runId, instance }).parse(request.params);
    const input = requestSchema.parse(request.body);

    return store.transact((runs) => {
      const run = runs[target.id];
      if (!run) throw new Error('Run not found');

      return measure('simulator.dispatch', () =>
        dispatch(run, target.instance, input),
      );
    });
  });
  let ticking = false;
  const timer = autonomous
    ? setInterval(() => {
        if (ticking) return;
        ticking = true;
        void store
          .transact((runs) => {
            for (const run of Object.values(runs)) {
              if (!run.clock.running) continue;
              const before = structuredClone(run);
              try {
                measure('simulator.advance', () =>
                  advanceRun(run, 250 * run.clock.speed),
                );
              } catch (error) {
                before.clock.running = false;
                journal(before.clock, 'scenario-error', {
                  message:
                    error instanceof Error
                      ? error.message
                      : 'Transition failed',
                });
                runs[run.id] = before;
              }
            }
          })
          .catch((error) => app.log.error(error))
          .finally(() => {
            ticking = false;
          });
      }, 250)
    : undefined;
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
    await store.close();
  });

  return app;
}
