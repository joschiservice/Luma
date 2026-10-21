import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
  type Bucket,
  charge,
  decide,
  type FaultRule,
  json,
  matchFault,
  type ProviderEvent,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderSimulator,
  type TransportFault,
} from '@luma/simulator-core';
import { gmail } from '@luma/simulator-gmail';
import { jtl } from '@luma/simulator-jtl';
import { shopify } from '@luma/simulator-shopify';
import { starshipit } from '@luma/simulator-starshipit';
import type { Pool, PoolClient } from 'pg';

import { cin7 } from '../engine/cin7.js';
import { mailboxName } from '../engine/model.js';
import {
  erpContext,
  handleEvents,
  mailContext,
  shippingContext,
  shopContext,
  type World,
} from '../engine/world.js';
import { createPgStore } from '../pg-store.js';
import { currentTime, readRun, type RunRecord } from './runs.js';
import {
  createSinks,
  createWorld,
  flushSinks,
  tableFor,
  withRun,
} from './session.js';
import { readOnly } from './stores.js';

/** What the HTTP route sends back: a provider response, or a dropped connection. */
export type DispatchResult =
  { kind: 'response'; response: ProviderResponse } | { kind: 'reset' };

const providers = { jtl, cin7, shopify, gmail, starshipit };

type ProviderKind = keyof typeof providers;

/** The request-level behavior every provider shares, independent of its config and commands. */
type Provider = Pick<
  ProviderSimulator<unknown, unknown>,
  'identify' | 'unauthorized' | 'drift' | 'rateLimit'
>;

/** The provider kind of a run's instance; undefined for an unknown instance. */
function providerKind(run: RunRecord, name: string): ProviderKind | undefined {
  if (name === (run.profile.erp ?? 'jtl')) return run.profile.erp ?? 'jtl';
  if (name === mailboxName) return 'gmail';
  if (name === 'starshipit') return 'starshipit';

  return run.profile.shops.some((item) => item.instance === name)
    ? 'shopify'
    : undefined;
}

/** Serves one request with the provider of the instance's kind. */
function handleWith(
  kind: ProviderKind,
  world: World,
  name: string,
  events: ProviderEvent[],
  request: ProviderRequest,
) {
  if (kind === 'shopify')
    return shopify.handle(shopContext(world, name, events), request);
  if (kind === 'starshipit')
    return starshipit.handle(shippingContext(world, events), request);
  if (kind === 'gmail')
    return gmail.handle(mailContext(world, events), request);
  const context = erpContext(world, events);

  return kind === 'cin7'
    ? cin7.handle(context as Parameters<typeof cin7.handle>[0], request)
    : jtl.handle(context, request);
}

const retryAfter = { 'content-type': 'application/json', 'retry-after': '1' };

/** Builds the response a transport fault produces before the provider does any work. */
function faultResponse(
  fault: TransportFault | 'unauthorized',
  provider: Provider,
  request: ProviderRequest,
): ProviderResponse {
  switch (fault) {
    case 'unauthorized':
      return provider.unauthorized(request);
    case 'rate-limit':
      return {
        ...json({ error: 'Too many requests' }, 429),
        headers: retryAfter,
      };
    case 'server-error':
      return json({ error: 'Internal server error' }, 500);
    case 'malformed':
      return {
        ...json(null, 200),
        bodyText: '{"data":{"page":{"nodes":[{"id":"gid://shopify/',
      };
    default:
      return {
        ...json({ error: 'Service unavailable' }, 503),
        headers: retryAfter,
      };
  }
}

/**
 * Executes Luma's provider requests with the run's failure behavior: service health, manual
 * fault rules, the chaos profile, provider rate limits, latency and lost responses. Writes run
 * under the run lock with the engine; reads run outside it and cannot write records.
 */
export function createDispatcher(pool: Pool) {
  const occurrences = new Map<string, number>();
  const buckets = new Map<string, Bucket>();
  // Whether a run has armed rules, so requests can skip the rule transaction. A request
  // caches what it read only if no rule changed meanwhile: its snapshot may predate the change.
  const armedRules = new Map<string, boolean>();
  const ruleChanges = new Map<string, number>();
  // Request metrics and journal entries are written in batches, not once per request.
  const pending = new Map<
    string,
    { run: RunRecord; sinks: ReturnType<typeof createSinks> }
  >();
  let flushing: Promise<void> | undefined;

  async function flush() {
    const batches = [...pending.values()];
    pending.clear();
    if (!batches.length) return;
    const client = await pool.connect();
    try {
      for (const batch of batches)
        await flushSinks(client, batch.run, batch.sinks);
    } finally {
      client.release();
    }
  }

  // A batch can fail, for example when its run was deleted meanwhile; it is dropped, not retried.
  const save = () =>
    flush().catch((error: unknown) =>
      console.error('Simulator request metrics were not saved', error),
    );

  const timer = setInterval(() => {
    flushing ??= save().finally(() => {
      flushing = undefined;
    });
  }, 2_000);
  timer.unref();

  function occurrence(key: string) {
    const value = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, value);
    if (occurrences.size > 200_000)
      occurrences.delete(occurrences.keys().next().value!);

    return value - 1;
  }

  /** Consumes manual fault rules for one phase in its own short transaction. */
  async function manualFault(
    run: RunRecord,
    target: {
      instance: string;
      operation: string;
      resource?: string | undefined;
    },
    phase: 'before' | 'after-commit',
  ) {
    if (armedRules.get(run.id) === false) return undefined;
    const changes = ruleChanges.get(run.id) ?? 0;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string; rule: FaultRule }>(
        'SELECT id, rule FROM sim_faults WHERE run_id = $1 ORDER BY position FOR UPDATE',
        [run.id],
      );
      const rules = rows.map((row) => row.rule);
      if ((ruleChanges.get(run.id) ?? 0) === changes)
        armedRules.set(
          run.id,
          rules.some((rule) => rule.status === 'armed'),
        );
      const before = JSON.stringify(rules);
      const fired = matchFault(rules, { ...target, phase }, currentTime(run));
      if (JSON.stringify(rules) !== before)
        for (const rule of rules)
          await client.query(
            'UPDATE sim_faults SET rule = $3 WHERE run_id = $1 AND id = $2',
            [run.id, rule.id, rule],
          );
      if (fired)
        await client.query(
          `INSERT INTO sim_journal (run_id, time, kind, instance, resource, detail) VALUES ($1, $2, 'fault', $3, $4, $5)`,
          [
            run.id,
            currentTime(run),
            target.instance,
            target.resource ?? null,
            {
              id: fired.id,
              kind: fired.kind,
              operation: target.operation,
              phase,
            },
          ],
        );
      await client.query('COMMIT');

      return fired;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function record(
    run: RunRecord,
    name: string,
    target: {
      operation: string;
      resource?: string | undefined;
      write: boolean;
    },
    status: number | 'reset',
    latencyMs: number,
    fault: string | null,
  ) {
    let batch = pending.get(run.id);
    if (!batch) {
      batch = { run, sinks: createSinks() };
      pending.set(run.id, batch);
    }
    const world = createWorld(
      run,
      () => {
        throw new Error('Request metrics read no records');
      },
      batch.sinks,
      { now: currentTime(run), live: true },
    );
    const failed = status === 'reset' || status >= 400 || fault !== null;
    world.metric('requests', 1, name);
    world.metric('latency.total', latencyMs, name);
    if (failed) world.metric('requests.failed', 1, name);
    if (failed || target.write)
      world.journal(
        target.write ? 'provider-write' : 'response',
        { operation: target.operation, status, fault, latencyMs },
        name,
        target.resource,
      );
  }

  async function execute(
    run: RunRecord,
    name: string,
    kind: ProviderKind,
    request: ProviderRequest,
    write: boolean,
  ) {
    if (write)
      return withRun(pool, run.id, async ({ world, client }) => {
        const events: ProviderEvent[] = [];
        const response = await handleWith(kind, world, name, events, request);
        if (response.committed) {
          await handleEvents(world, name, events);
          await countWrite(client, run, name, request);
        }

        return response;
      });
    // Reads need no transaction: at read committed it would add no consistency, only round
    // trips. The read-only stores keep handlers from writing outside the run lock.
    const client = await pool.connect();
    try {
      const world = createWorld(
        run,
        (store) =>
          readOnly(createPgStore(client, tableFor(run, store), run.id, store)),
        createSinks(),
        { now: currentTime(run), live: true },
      );

      return await handleWith(kind, world, name, [], request);
    } finally {
      client.release();
    }
  }

  return {
    /** Writes pending request metrics and stops the batch timer; a failed write is logged. */
    async close() {
      clearInterval(timer);
      await flushing;
      await save();
    },
    /** Forgets cached rule state; call after the transaction that changed the rules commits. */
    rulesChanged(runId: string) {
      ruleChanges.set(runId, (ruleChanges.get(runId) ?? 0) + 1);
      armedRules.delete(runId);
    },
    async dispatch(
      runId: string,
      name: string,
      request: ProviderRequest,
    ): Promise<DispatchResult> {
      const run = await readRun(pool, runId);
      if (!run)
        throw Object.assign(new Error('Run not found'), { statusCode: 404 });
      if (run.status !== 'ready')
        return {
          kind: 'response',
          response: {
            ...json({ error: 'Simulator run is provisioning' }, 503),
            headers: retryAfter,
          },
        };
      const kind = providerKind(run, name);
      if (!kind)
        throw Object.assign(new Error('Unknown provider instance'), {
          statusCode: 404,
        });
      const provider: Provider = providers[kind];
      const target = { instance: name, ...provider.identify(request) };
      const started = Date.now();
      const finish = async (
        result: DispatchResult,
        fault: string | null,
        latencyMs = 0,
      ) => {
        await record(
          run,
          name,
          target,
          result.kind === 'reset' ? 'reset' : result.response.status,
          latencyMs || Date.now() - started,
          fault,
        );

        return result;
      };
      const health = run.health[name]?.status ?? 'healthy';
      if (health !== 'healthy')
        return finish(
          {
            kind: 'response',
            response: faultResponse(
              health === 'unauthorized'
                ? 'unauthorized'
                : health === 'rate-limited'
                  ? 'rate-limit'
                  : 'unavailable',
              provider,
              request,
            ),
          },
          `service-${health}`,
        );
      const manual = await manualFault(run, target, 'before');
      if (manual && manual.kind !== 'response-loss') {
        if (manual.kind === 'reset' || manual.kind === 'timeout') {
          if (manual.kind === 'timeout')
            await delay(run.chaos.transport.timeoutMs);

          return finish({ kind: 'reset' }, manual.kind);
        }
        if (manual.kind !== 'schema-drift')
          return finish(
            {
              kind: 'response',
              response: faultResponse(manual.kind, provider, request),
            },
            manual.kind,
          );
      }
      const identity = `${request.method} ${request.url} ${createHash('sha256')
        .update(request.body ?? '')
        .digest('hex')}`;
      const decision = decide(run.chaos, {
        seed: run.seed,
        instance: name,
        operation: target.operation,
        write: target.write,
        identity,
        occurrence: occurrence(`${run.id}\u0000${name}\u0000${identity}`),
        now: currentTime(run),
      });
      const fault =
        manual?.kind === 'schema-drift' ? 'schema-drift' : decision.fault;
      if (provider.rateLimit && run.chaos.transport.rateLimits) {
        const key = `${run.id}\u0000${name}`;
        const bucket = buckets.get(key) ?? {
          available: provider.rateLimit.capacity,
          at: Date.now(),
        };
        buckets.set(key, bucket);
        const cost = provider.rateLimit.cost(request);
        if (!charge(provider.rateLimit, bucket, cost, Date.now()))
          return finish(
            {
              kind: 'response',
              response: provider.rateLimit.reject(cost, bucket.available),
            },
            'throttled',
          );
      }
      await delay(decision.latencyMs);
      if (fault && !decision.afterCommit && fault !== 'schema-drift') {
        if (fault === 'timeout') await delay(run.chaos.transport.timeoutMs);
        if (fault === 'timeout' || fault === 'reset')
          return finish({ kind: 'reset' }, fault);

        return finish(
          {
            kind: 'response',
            response: faultResponse(fault, provider, request),
          },
          fault,
        );
      }
      let response = await execute(run, name, kind, request, target.write);
      if (fault === 'schema-drift' && response.status < 300)
        response = provider.drift(response);
      const bucket = buckets.get(`${run.id}\u0000${name}`);
      if (provider.rateLimit && bucket && run.chaos.transport.rateLimits) {
        const cost = provider.rateLimit.cost(request);
        const actual = provider.rateLimit.actualCost?.(response);
        if (actual !== undefined && actual < cost)
          bucket.available = Math.min(
            provider.rateLimit.capacity,
            bucket.available + cost - actual,
          );
        if (provider.rateLimit.annotate)
          response = provider.rateLimit.annotate(
            response,
            cost,
            bucket.available,
          );
      }
      if (response.committed) {
        const lost = await manualFault(run, target, 'after-commit');
        if (lost || decision.lose)
          return finish(
            { kind: 'response', response: { ...response, lost: true } },
            'response-loss',
          );
        if (fault && decision.afterCommit) {
          if (fault === 'timeout') await delay(run.chaos.transport.timeoutMs);
          if (fault === 'timeout' || fault === 'reset')
            return finish({ kind: 'reset' }, `${fault}-after-commit`);

          return finish(
            {
              kind: 'response',
              response: faultResponse(fault, provider, request),
            },
            `${fault}-after-commit`,
          );
        }
      }

      return finish(
        { kind: 'response', response },
        fault === 'schema-drift' ? fault : null,
      );
    },
  };
}

/** Counts committed writes per idempotency key, or per request digest when none is sent. */
async function countWrite(
  client: PoolClient,
  run: RunRecord,
  name: string,
  request: ProviderRequest,
) {
  const headerKey = request.headers['idempotency-key'];
  let bodyKey: string | undefined;
  try {
    const body = JSON.parse(request.body ?? '{}') as {
      variables?: { key?: unknown };
    };
    bodyKey =
      typeof body.variables?.key === 'string' ? body.variables.key : undefined;
  } catch {
    bodyKey = undefined;
  }
  const keyed = headerKey ?? bodyKey;
  const key =
    keyed ??
    createHash('sha256')
      .update(`${request.method} ${request.url} ${request.body ?? ''}`)
      .digest('hex');
  const operation =
    providers[providerKind(run, name) ?? 'shopify'].identify(request).operation;
  await client.query(
    `INSERT INTO sim_writes (run_id, instance, operation, key, keyed, count, first_at, last_at)
     VALUES ($1, $2, $3, $4, $5, 1, $6, $6)
     ON CONFLICT (run_id, instance, operation, key) DO UPDATE SET count = sim_writes.count + 1, last_at = excluded.last_at`,
    [run.id, name, operation, key, keyed !== undefined, Date.now()],
  );
}
