import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type {
  CapabilityEvent,
  CapabilityReader,
} from '../application/capabilities.js';
import { createCapabilityRuntime } from '../application/capabilities.js';
import type { EffectIntent } from '../application/effects.js';
import type {
  CapabilityInput,
  CapabilityOutput,
} from '../domain/capabilities.js';
import { ConnectorError } from '../domain/capabilities.js';
import type { WriteAcceptance } from '../domain/write-receipts.js';
import { createSampleConnector } from './sample-provider.js';

// Identity's brand and membership checks have their own tests; these fixtures isolate connector scoping.
vi.mock('@luma/identity', () => ({
  requireTenant(context: TenantContext, tenantId: string) {
    if (context.tenantId !== tenantId) throw new Error('Tenant mismatch');
  },
}));

const context = {
  tenantId: 'tenant-a',
  requestId: 'request-a',
} as TenantContext;

const input: CapabilityInput<'inventory.write'> = {
  sku: { externalId: 'SKU/001', scopeKey: '' },
  location: { externalId: 'Warehouse-A', scopeKey: '' },
  available: { amount: '-2.250000', unit: 'each' },
  expectedRevision: '1',
};

const read = {
  connectionId: 'connection-a',
  capability: 'inventory.read',
  version: '0',
  input: { limit: 10 },
} as const;

const write = {
  connectionId: 'connection-a',
  capability: 'inventory.write',
  version: '0',
  input,
  idempotencyKey: 'v0:proposal-a',
} as const;

function fixture(mechanism: 'api' | 'deterministic_browser' = 'api') {
  const connection = createSampleConnector({
    tenantId: context.tenantId,
    connectionId: 'connection-a',
    mechanism,
    now: () => new Date('2026-09-17T00:00:00Z'),
    id: randomUUID,
  });
  const record = vi
    .fn<(event: CapabilityEvent) => Promise<void>>()
    .mockResolvedValue();
  const resolve = vi.fn().mockResolvedValue(connection);
  const runtime = createCapabilityRuntime({ resolve, record });

  return { connection, runtime, record, resolve };
}

describe.each(['api', 'deterministic_browser'] as const)(
  '%s sample conformance',
  (mechanism) => {
    it('discovers capabilities and reads normalized data through the same consumer', async () => {
      const { runtime } = fixture(mechanism);
      const consumer = async (reader: CapabilityReader) =>
        reader.read(context, read);
      expect(
        (await runtime.discover(context, 'connection-a')).map(
          (item) => item.capability,
        ),
      ).toEqual(['inventory.read', 'inventory.write']);
      const result = await consumer(runtime);
      if (!result.ok) throw new Error(result.error.code);
      expectTypeOf(result.value).toEqualTypeOf<
        CapabilityOutput<'inventory.read'>
      >();
      expect(result.value.items[0]).toMatchObject({
        source: {
          tenantId: 'tenant-a',
          connectionId: 'connection-a',
          provider: 'sample',
          externalId: 'SKU/001',
        },
        data: { available: '3.000000', onHand: null },
        schemaVersion: 1,
      });
    });
    it('bridges an action to execution without provider or mechanism branches', async () => {
      const { runtime } = fixture(mechanism);
      const intent: EffectIntent = {
        tenantId: context.tenantId,
        connectionId: 'connection-a',
        capability: 'inventory.write',
        capabilityVersion: '0',
        target: { kind: 'sku', id: 'canonical-sku-a' },
        parameters: { available: input.available.amount },
        preconditions: { evidenceRefs: [], validUntil: '2026-09-18T00:00:00Z' },
        expectedPostcondition: { available: input.available.amount },
      };
      const registry = runtime.effects({
        capability: 'inventory.write',
        map: async (_context, action) =>
          action.target.id === 'canonical-sku-a' ? input : null,
        checkPreconditions: async () => true,
        async verify() {
          const result = await runtime.read(context, read);
          if (!result.ok || !result.value.items[0])
            throw new Error('Observation unavailable');
          const observed = result.value.items[0];

          return {
            outcome:
              observed.data.available === input.available.amount
                ? 'passed'
                : 'failed',
            observationRefs: [observed.id],
            observedAt: observed.observedAt,
            evaluatorVersion: 'sample/0',
          };
        },
      });
      const adapter = await registry.resolve(context, intent);
      expect(adapter?.minimumRisk).toBe('medium');
      expect(await adapter?.checkPreconditions(intent)).toBe(true);
      expect(
        await adapter?.execute(intent, write.idempotencyKey),
      ).toMatchObject({ evidenceRefs: [expect.any(String)] });
      expect(await adapter?.verify(intent)).toMatchObject({
        outcome: 'passed',
      });
      expect(
        await registry.resolve(context, {
          ...intent,
          target: { kind: 'sku', id: 'foreign-sku' },
        }),
      ).toBeNull();
      expect(
        await registry.resolve(context, { ...intent, capabilityVersion: '1' }),
      ).toBeNull();
      await expect(
        registry.resolve(context, { ...intent, tenantId: 'foreign' }),
      ).rejects.toThrow('Tenant mismatch');
    });
  },
);

it('replays the same intent, rejects changed intent and stale revisions', async () => {
  const { runtime } = fixture();
  const first = await runtime.write(context, write);
  expect(first.ok).toBe(true);
  expect(await runtime.write(context, write)).toEqual(first);
  expect(
    await runtime.write(context, {
      ...write,
      input: { ...input, available: { amount: '5', unit: 'each' } },
    }),
  ).toMatchObject({ ok: false, error: { code: 'conflict', effect: 'none' } });
  expect(
    await runtime.write(context, { ...write, idempotencyKey: 'new-key' }),
  ).toMatchObject({ ok: false, error: { code: 'conflict' } });
  const result = await runtime.read(context, read);
  expect(result.ok && result.value.items[0]?.sourceRevision).toBe('2');
});

it.each(['revoked', 'disconnected', 'pending', 'degraded'] as const)(
  'refuses %s connections',
  async (status) => {
    const { connection, runtime, record } = fixture();
    connection.status = status;
    expect(await runtime.discover(context, 'connection-a')).toEqual([]);
    expect(await runtime.write(context, write)).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
    expect(record).not.toHaveBeenCalled();
  },
);

it('rejects mismatched tenant and connection identities before dispatch', async () => {
  const { connection, runtime, record } = fixture();
  connection.tenantId = 'tenant-b';
  expect(await runtime.read(context, read)).toMatchObject({
    ok: false,
    error: { code: 'unavailable' },
  });
  connection.tenantId = context.tenantId;
  connection.id = 'connection-b';
  expect(await runtime.read(context, read)).toMatchObject({
    ok: false,
    error: { code: 'unavailable' },
  });
  expect(record).not.toHaveBeenCalled();
});

it('rejects unsupported capabilities, versions and invalid input', async () => {
  const { runtime } = fixture();
  expect(
    await runtime.read(context, { ...read, capability: 'orders.read' }),
  ).toMatchObject({ ok: false, error: { code: 'unsupported_capability' } });
  // @ts-expect-error Version zero is the only supported contract.
  expect(await runtime.read(context, { ...read, version: '1' })).toMatchObject({
    ok: false,
    error: { code: 'unsupported_version' },
  });
  expect(
    await runtime.read(context, { ...read, input: { limit: 0 } }),
  ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  expect(
    await runtime.write(context, { ...write, idempotencyKey: '' }),
  ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  expect(
    await runtime.write(context, {
      ...write,
      input: { ...input, available: { amount: '1.0000001', unit: 'each' } },
    }),
  ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  // @ts-expect-error A read-only consumer cannot dispatch an effect.
  expect(await runtime.read(context, write)).toMatchObject({
    ok: false,
    error: { code: 'invalid_input' },
  });
});

it('normalizes ambiguous writes, does not retry, and excludes payloads from hooks', async () => {
  const { connection, runtime, record } = fixture();
  const run = vi.fn().mockRejectedValue(new Error('secret provider payload'));
  connection.capabilities['inventory.write']!.run = run;
  expect(await runtime.write(context, write)).toEqual({
    ok: false,
    error: { code: 'internal', effect: 'unknown', retry: 'reconcile' },
  });
  expect(run).toHaveBeenCalledTimes(1);
  expect(record.mock.calls.map(([event]) => event.phase)).toEqual([
    'started',
    'failed',
  ]);
  expect(JSON.stringify(record.mock.calls)).not.toContain('secret');
  run.mockRejectedValue(
    new ConnectorError({
      code: 'timeout',
      effect: 'unknown',
      retry: 'after_delay',
      retryAfterMs: 500,
    }),
  );
  expect(await runtime.write(context, write)).toMatchObject({
    ok: false,
    error: { code: 'timeout', retry: 'reconcile', retryAfterMs: 500 },
  });
});

it('preserves rate-limit advice on reads and rejects malformed responses', async () => {
  const { connection, runtime } = fixture();
  connection.capabilities['inventory.read']!.run = vi.fn().mockRejectedValue(
    new ConnectorError({
      code: 'rate_limited',
      effect: 'none',
      retry: 'after_delay',
      retryAfterMs: 1000,
    }),
  );
  expect(await runtime.read(context, read)).toMatchObject({
    ok: false,
    error: { code: 'rate_limited', retryAfterMs: 1000 },
  });
  connection.capabilities['inventory.write']!.run = vi
    .fn()
    .mockResolvedValue({ status: 'accepted' });
  expect(await runtime.write(context, write)).toMatchObject({
    ok: false,
    error: { code: 'invalid_response', effect: 'unknown', retry: 'reconcile' },
  });
});

it('fails closed on a pre-dispatch hook failure and propagates post-dispatch evidence failure', async () => {
  const { connection, runtime, record } = fixture();
  const run = vi.spyOn(connection.capabilities['inventory.write']!, 'run');
  record.mockRejectedValueOnce(new Error('Audit unavailable'));
  await expect(runtime.write(context, write)).rejects.toThrow(
    'Audit unavailable',
  );
  expect(run).not.toHaveBeenCalled();
  record
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(new Error('Completion unavailable'));
  await expect(runtime.write(context, write)).rejects.toThrow(
    'Completion unavailable',
  );
  expect(run).toHaveBeenCalledTimes(1);
});

it('rejects observations from another source and returns independent discovery metadata', async () => {
  const { connection, runtime } = fixture();
  const discovered = await runtime.discover(context, 'connection-a');
  discovered[0]!.retry.maxAttempts = 99;
  expect(
    (await runtime.discover(context, 'connection-a'))[0]!.retry.maxAttempts,
  ).toBe(3);
  const handler = connection.capabilities['inventory.read']!;
  const run = handler.run;
  handler.run = async (context, input) => {
    const page = await run(context, input);
    page.items[0]!.source.tenantId = 'foreign-tenant';

    return page;
  };
  expect(await runtime.read(context, read)).toMatchObject({
    ok: false,
    error: { code: 'invalid_response', effect: 'none' },
  });
});

it('withholds dispatch if adapter risk changes after policy resolution', async () => {
  const { connection, runtime } = fixture();
  const handler = connection.capabilities['inventory.write']!;
  const run = vi.spyOn(handler, 'run');
  const registry = runtime.effects({
    capability: 'inventory.write',
    map: async () => input,
    checkPreconditions: async () => true,
    verify: async () => ({
      outcome: 'inconclusive',
      observationRefs: [],
      observedAt: '2026-09-17T00:00:00Z',
      evaluatorVersion: '0',
    }),
  });
  const intent: EffectIntent = {
    tenantId: context.tenantId,
    connectionId: write.connectionId,
    capability: write.capability,
    capabilityVersion: '0',
    target: { kind: 'sku', id: 'sku-a' },
    parameters: {},
    preconditions: { evidenceRefs: [], validUntil: '2026-09-18T00:00:00Z' },
    expectedPostcondition: {},
  };
  const adapter = await registry.resolve(context, intent);
  handler.descriptor.minimumRisk = 'high';
  await expect(
    adapter!.execute(intent, write.idempotencyKey),
  ).rejects.toMatchObject({ failure: { code: 'conflict', effect: 'none' } });
  expect(run).not.toHaveBeenCalled();
});

describe('owner-stored write receipts', () => {
  const intent: EffectIntent = {
    tenantId: context.tenantId,
    connectionId: write.connectionId,
    capability: write.capability,
    capabilityVersion: '0',
    target: { kind: 'sku', id: 'sku-a' },
    parameters: {},
    preconditions: { evidenceRefs: [], validUntil: '2026-09-18T00:00:00Z' },
    expectedPostcondition: {},
  };
  const bind = (
    runtime: ReturnType<typeof fixture>['runtime'],
    storeReceipt: (
      context: TenantContext,
      intent: EffectIntent,
      acceptance: WriteAcceptance,
    ) => Promise<string>,
  ) =>
    runtime.effects({
      capability: 'inventory.write',
      map: async () => input,
      checkPreconditions: async () => true,
      verify: async () => ({
        outcome: 'inconclusive',
        observationRefs: [],
        observedAt: '2026-09-17T00:00:00Z',
        evaluatorVersion: '0',
      }),
      storeReceipt,
    });

  it('cites only the receipt the owner stored, with the normalized acceptance', async () => {
    const { runtime } = fixture();
    const stored: WriteAcceptance[] = [];
    const adapter = await bind(runtime, async (_context, action, value) => {
      expect(action).toEqual(intent);
      stored.push(value);

      return 'receipt-a';
    }).resolve(context, intent);
    const result = await adapter!.execute(intent, write.idempotencyKey);

    expect(result).toEqual({
      evidenceRefs: ['receipt-a'],
      providerRequestId: null,
    });
    expect(stored).toEqual([
      {
        provider: 'sample',
        connectionId: 'connection-a',
        capability: 'inventory.write',
        adapterVersion: 'sample/0',
        dispatchIdentity: adapter!.dispatchIdentity,
        idempotencyKey: write.idempotencyKey,
        acceptedAt: expect.any(String),
        providerRequestId: null,
        records: [],
      },
    ]);
  });

  it('cites nothing and reports a dispatched, unknown write when the receipt cannot be stored', async () => {
    const { runtime } = fixture();
    const adapter = await bind(runtime, async () => {
      throw new Error('storage unavailable');
    }).resolve(context, intent);

    await expect(
      adapter!.execute(intent, write.idempotencyKey),
    ).rejects.toMatchObject({
      failure: {
        code: 'internal',
        effect: 'unknown',
        retry: 'reconcile',
        dispatch: 'dispatched',
      },
    });
  });

  it('stores nothing when the provider response is lost', async () => {
    const { connection, runtime } = fixture();
    vi.spyOn(
      connection.capabilities['inventory.write']!,
      'run',
    ).mockRejectedValue(
      new ConnectorError({
        code: 'transient',
        effect: 'unknown',
        retry: 'reconcile',
      }),
    );
    const storeReceipt = vi.fn(async () => 'receipt-a');
    const adapter = await bind(runtime, storeReceipt).resolve(context, intent);

    await expect(
      adapter!.execute(intent, write.idempotencyKey),
    ).rejects.toMatchObject({ failure: { effect: 'unknown' } });
    expect(storeReceipt).not.toHaveBeenCalled();
  });
});

it('carries a declared app permission to the resolved adapter', async () => {
  const { connection, runtime } = fixture();
  const registry = runtime.effects({
    capability: 'inventory.write',
    map: async () => input,
    checkPreconditions: async () => true,
    verify: async () => ({
      outcome: 'inconclusive',
      observationRefs: [],
      observedAt: '2026-09-17T00:00:00Z',
      evaluatorVersion: '0',
    }),
  });
  const intent: EffectIntent = {
    tenantId: context.tenantId,
    connectionId: write.connectionId,
    capability: write.capability,
    capabilityVersion: '0',
    target: { kind: 'sku', id: 'sku-a' },
    parameters: {},
    preconditions: { evidenceRefs: [], validUntil: '2026-09-18T00:00:00Z' },
    expectedPostcondition: {},
  };
  const undeclared = await registry.resolve(context, intent);
  expect(undeclared).not.toHaveProperty('permission');

  connection.capabilities['inventory.write']!.descriptor.permission =
    'sample:inventory.adjust';
  expect((await registry.resolve(context, intent))?.permission).toBe(
    'sample:inventory.adjust',
  );
});
