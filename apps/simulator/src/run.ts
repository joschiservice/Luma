import type { Clock, ProviderRequest } from '@luma/simulator-core';
import {
  advance,
  createClock,
  journal,
  json,
  matchFault,
  schedule,
} from '@luma/simulator-core';
import * as jtl from '@luma/simulator-jtl';
import * as shopify from '@luma/simulator-shopify';
import { z } from 'zod';

import type { OperationalScenario } from './operational-scenarios.js';

const orderId = z.string().regex(/^[1-9]\d{0,8}$/);
const quantity = z.number().int().min(1).max(1000);

export const commandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('order'), id: orderId, quantity }),
  z.object({
    kind: z.literal('stock'),
    quantity: z.number().int().min(0).max(2147483647),
    id: orderId.optional(),
  }),
  z.object({ kind: z.literal('ship'), id: orderId }),
  z.object({
    kind: z.literal('shipping-method'),
    id: orderId,
    shippingMethodId: z.enum(['7', '8', '9']),
  }),
  z.object({ kind: z.literal('return'), id: orderId, quantity }),
  z.object({ kind: z.literal('return-approve'), id: orderId }),
  z.object({ kind: z.literal('return-decline'), id: orderId }),
  z.object({ kind: z.literal('return-receive'), id: orderId }),
  z.object({ kind: z.literal('return-close'), id: orderId }),
  z.object({
    kind: z.literal('refund'),
    id: orderId,
    outcome: z.enum(['success', 'pending', 'failure']),
  }),
  z.object({ kind: z.literal('refund-settle'), id: orderId }),
]);

export const faultSchema = z
  .object({
    instance: z.enum(['jtl', 'shopify']),
    operation: z.enum([
      '*',
      'orders.read',
      'products.read',
      'items.read',
      'inventory.read',
      'inventory.available.reconcile',
      'fulfillment.read',
      'returns.read',
      'orders.shipping-method.read',
      'orders.shipping-method.write',
    ]),
    resource: z.string().min(1).optional(),
    phase: z.enum(['before', 'after-commit']),
    kind: z.enum(['outage', 'rate-limit', 'response-loss']),
    occurrence: z.number().int().min(1).max(10000).default(1),
    remaining: z.number().int().min(1).max(10000).default(1),
    lifetimeMs: z.number().int().positive().max(86400000).optional(),
  })
  .superRefine((f, ctx) => {
    if (
      (f.kind === 'response-loss') !== (f.phase === 'after-commit') ||
      (f.kind === 'response-loss' &&
        !(
          (f.instance === 'jtl' &&
            f.operation === 'orders.shipping-method.write') ||
          (f.instance === 'shopify' &&
            f.operation === 'inventory.available.reconcile')
        ))
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Response loss requires a supported JTL shipping-method or Shopify inventory write after commit',
      });
  });

export const serviceHealthSchema = z.enum([
  'healthy',
  'rate-limited',
  'unavailable',
]);

export interface Run {
  id: string;
  seed: number;
  random: number;
  nextOrder: number;
  scenario: 'commerce' | 'manual';
  clock: Clock;
  serviceHealth: Record<'jtl' | 'shopify', z.infer<typeof serviceHealthSchema>>;
  jtl: jtl.JtlState;
  shopify: shopify.ShopifyState;
  mappings: { jtl: string; shopify: string }[];
  operationalScenarios: OperationalScenario[];
}
const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('cycle') }),
  z.object({
    type: z.literal('merchant'),
    instance: z.enum(['jtl', 'shopify']),
    command: commandSchema,
  }),
]);

/** Creates a repeatable run with a seed order in each isolated provider namespace. */
export function createRun(
  id: string,
  seed = 44,
  scenario: Run['scenario'] = 'commerce',
  startAt?: number,
): Run {
  const clock = createClock(startAt);
  const run: Run = {
    id,
    seed,
    random: seed >>> 0,
    nextOrder: 11,
    scenario,
    clock,
    serviceHealth: { jtl: 'healthy', shopify: 'healthy' },
    jtl: jtl.seed(),
    shopify: shopify.seed(clock.now),
    mappings: [{ jtl: '1', shopify: 'gid://shopify/Order/1' }],
    operationalScenarios: [],
  };
  provisionOperationalStock(run);
  mutate(run, 'jtl', { kind: 'order', id: '1', quantity: 2 });
  mutate(run, 'shopify', { kind: 'order', id: '1', quantity: 2 });
  mutate(run, 'jtl', { kind: 'order', id: '10', quantity: 2 });
  mutate(run, 'shopify', { kind: 'order', id: '10', quantity: 2 });
  run.mappings.push({ jtl: '10', shopify: 'gid://shopify/Order/10' });
  if (scenario === 'commerce') schedule(clock, 10000, { type: 'cycle' });

  return run;
}

/** Ensures the scenario stock pool exists, including when loading runs created before scenario controls. */
export function provisionOperationalStock(run: Run) {
  jtl.provisionScenarioStock(run.jtl, run.clock.now);
  shopify.provisionScenarioStock(run.shopify, run.clock.now);
}

/** Applies the same provider command for manual inputs and scheduled merchant actions. */
export function mutate(run: Run, instance: 'jtl' | 'shopify', input: unknown) {
  const command = commandSchema.parse(input);
  if (instance === 'jtl') {
    if (
      command.kind !== 'order' &&
      command.kind !== 'stock' &&
      command.kind !== 'ship' &&
      command.kind !== 'shipping-method'
    )
      throw new Error('JTL returns are not simulated');
    jtl.command(run.jtl, command, run.clock.now);
  } else {
    if (command.kind === 'shipping-method')
      throw new Error('Shopify shipping-method writes are unsupported');
    shopify.command(run.shopify, command, run.clock.now);
  }
  journal(
    run.clock,
    'merchant',
    command,
    instance,
    'id' in command ? command.id : '1',
  );
}

/** Advances scheduled merchant activity; propagation uses explicit provider IDs and a five-second delay. */
export function advanceRun(run: Run, milliseconds: number) {
  advance(run.clock, milliseconds, (input) => {
    const event = eventSchema.parse(input);
    if (event.type === 'merchant') {
      mutate(run, event.instance, event.command);

      return;
    }
    run.random = (Math.imul(run.random, 1664525) + 1013904223) >>> 0;
    const id = String(run.nextOrder++);
    const quantity = 1 + (run.random % 3);
    mutate(run, 'shopify', { kind: 'order', id, quantity });
    run.mappings.push({ jtl: id, shopify: `gid://shopify/Order/${id}` });
    schedule(run.clock, 5000, {
      type: 'merchant',
      instance: 'jtl',
      command: { kind: 'order', id, quantity },
    });
    schedule(run.clock, 20000, {
      type: 'merchant',
      instance: 'jtl',
      command: { kind: 'ship', id },
    });
    schedule(run.clock, 25000, {
      type: 'merchant',
      instance: 'shopify',
      command: { kind: 'ship', id },
    });
    schedule(run.clock, 30000, { type: 'cycle' });
  });
}

/** Executes a provider request and consumes faults inside the host's durable transaction. */
export function dispatch(
  run: Run,
  instance: 'jtl' | 'shopify',
  request: ProviderRequest,
) {
  const target = {
    instance,
    ...(instance === 'jtl' ? jtl.identify(request) : shopify.identify(request)),
  };
  journal(
    run.clock,
    'request',
    {
      method: request.method,
      url: request.url,
      operation: target.operation,
      body: request.body,
    },
    instance,
    target.resource,
  );
  const health = run.serviceHealth[instance];
  if (health !== 'healthy') {
    const status = health === 'rate-limited' ? 429 : 503;
    journal(
      run.clock,
      'response',
      { status, serviceHealth: health },
      instance,
      target.resource,
    );

    return {
      ...json({ error: health }, status),
      headers: { 'content-type': 'application/json', 'retry-after': '1' },
    };
  }
  const fault = matchFault(run.clock, { ...target, phase: 'before' });
  if (fault)
    return {
      ...json({ error: fault.kind }, fault.kind === 'rate-limit' ? 429 : 503),
      headers: { 'content-type': 'application/json', 'retry-after': '1' },
    };
  const response =
    instance === 'jtl'
      ? jtl.handle(run.jtl, request, run.clock.now)
      : shopify.handle(run.shopify, request, run.clock.now);
  if ('committed' in response && response.committed) {
    journal(
      run.clock,
      'provider-write',
      { operation: target.operation, body: request.body },
      instance,
      target.resource,
    );
    const after = matchFault(run.clock, { ...target, phase: 'after-commit' });
    if (after) return { ...response, lost: true };
  }
  journal(
    run.clock,
    'response',
    { status: response.status },
    instance,
    target.resource,
  );

  return response;
}
