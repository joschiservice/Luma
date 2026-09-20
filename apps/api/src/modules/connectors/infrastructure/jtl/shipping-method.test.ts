import { describe, expect, it, vi } from 'vitest';

import { createCapabilityRuntime } from '#modules/connectors/application/capabilities';
import type { EffectIntent } from '#modules/connectors/application/effects';
import { createShippingMethodEffects } from '#modules/connectors/application/shipping-method-effects';
import type { JtlConnectorOptions } from '#modules/connectors/infrastructure/jtl/adapter';
import { createJtlConnector } from '#modules/connectors/infrastructure/jtl/adapter';
import { cloudId } from '#modules/connectors/infrastructure/jtl/fixtures/cloud';
import type { TenantContext } from '#modules/identity/index';

vi.mock('#modules/identity/index', () => ({
  requireTenant(context: TenantContext, tenantId: string) {
    if (context.tenantId !== tenantId) throw new Error('Tenant mismatch');
  },
}));

const context = {
  tenantId: 'tenant-a',
  requestId: 'request-a',
} as TenantContext;

const ref = (externalId: string) => ({ externalId, scopeKey: '' });

const date = new Date('2026-09-18T01:00:00Z');

function fixture(cloud = false) {
  const ids = {
    order: cloud ? cloudId(10) : '10',
    before: cloud ? cloudId(7) : '7',
    after: cloud ? cloudId(8) : '8',
  };
  const state = {
    id: ids.order,
    shippingMethodId: ids.before,
    isCancelled: false,
  };
  const ledger = new Map<string, unknown>();
  let effects = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    if (init?.method === 'PATCH') {
      const key = new Headers(init.headers).get('Idempotency-Key')!;
      if (ledger.has(key)) return Response.json(ledger.get(key));
      const body = JSON.parse(String(init.body));
      state.shippingMethodId = String(body.shippingMethodId);
      const response = { salesOrderId: ids.order };
      ledger.set(key, response);
      effects++;

      return Response.json(response);
    }

    return Response.json({
      ...state,
      shipmentAddress: { private: 'excluded' },
    });
  });
  const recordObservations = vi.fn().mockResolvedValue(undefined);
  const options: JtlConnectorOptions = {
    tenantId: context.tenantId,
    connectionId: 'connection-a',
    connection: cloud
      ? {
          kind: 'cloud',
          jtlTenantId: cloudId(1),
          accessToken: async () => 'secret',
        }
      : {
          kind: 'onprem',
          baseUrl: 'http://127.0.0.1:5883/api/eazybusiness/',
          appId: 'Luma',
          appVersion: '0',
          challengeCode: 'challenge',
          apiKey: async () => 'secret',
        },
    fetch,
    recordObservations,
    shippingMethodActions: true,
    now: () => date,
  };
  const runtime = () =>
    createCapabilityRuntime({
      resolve: async () => createJtlConnector(options),
      record: vi.fn(),
    });
  const input = {
    order: ref(ids.order),
    expectedShippingMethod: ref(ids.before),
    shippingMethod: ref(ids.after),
  };
  const write = (key = 'logical-action', value = input) =>
    runtime().write(context, {
      connectionId: options.connectionId,
      capability: 'orders.shipping-method.write',
      version: '0',
      idempotencyKey: key,
      input: value,
    });
  const intent: EffectIntent = {
    tenantId: context.tenantId,
    connectionId: options.connectionId,
    capability: 'orders.shipping-method.write',
    capabilityVersion: '0',
    target: { kind: 'order', id: 'canonical-order' },
    parameters: {},
    preconditions: {
      evidenceRefs: ['diagnosis'],
      validUntil: '2026-09-18T01:05:00Z',
    },
    expectedPostcondition: { shippingMethodId: ids.after },
  };
  const binding = {
    map: vi.fn(async () => input),
    checkPreconditions: vi.fn(async () => true),
    now: () => date,
  };
  const effectsRegistry = () => createShippingMethodEffects(runtime(), binding);

  return {
    ids,
    state,
    fetch,
    options,
    input,
    write,
    runtime,
    recordObservations,
    intent,
    binding,
    effectsRegistry,
    effects: () => effects,
  };
}

describe('JTL shipping-method correction', () => {
  it.each([false, true])(
    'corrects, independently verifies and reverses (cloud=%s)',
    async (cloud) => {
      const f = fixture(cloud);
      const effect = (await f.effectsRegistry().resolve(context, f.intent))!;
      expect(effect.minimumRisk).toBe('high');
      expect(await effect.checkPreconditions(f.intent)).toBe(true);
      const receipt = await effect.execute(f.intent, 'first');
      expect(receipt.evidenceRefs).toHaveLength(1);
      expect(f.fetch).toHaveBeenCalledTimes(2);
      const patch = f.fetch.mock.calls[1]!;
      expect(patch[0].toString()).toContain(`sales-orders/${f.ids.order}`);
      expect(JSON.parse(String(patch[1]?.body))).toEqual({
        shippingMethodId: f.ids.after,
        disableAutomaticWorkflows: true,
      });
      expect(new Headers(patch[1]?.headers).get('Idempotency-Key')).toMatch(
        /^[a-f0-9]{64}$/,
      );
      expect(patch[1]).toMatchObject({ method: 'PATCH', redirect: 'error' });
      expect(await effect.verify(f.intent)).toMatchObject({
        outcome: 'passed',
        observationRefs: [expect.any(String)],
      });
      expect(f.fetch.mock.calls.at(-1)?.[1]?.method).toBe('GET');
      expect(f.recordObservations).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(f.recordObservations.mock.calls)).not.toMatch(
        /secret|excluded|shipmentAddress/,
      );
      expect(
        await f.write('undo', {
          ...f.input,
          expectedShippingMethod: ref(f.ids.after),
          shippingMethod: ref(f.ids.before),
        }),
      ).toMatchObject({ ok: true });
      expect(f.state.shippingMethodId).toBe(f.ids.before);
      expect(f.effects()).toBe(2);
    },
  );
  it('accepts reordered mapping and intent fields throughout execution', async () => {
    const f = fixture();
    const effect = (await f.effectsRegistry().resolve(context, f.intent))!;
    const reorderedRef = (value: { externalId: string; scopeKey: string }) => ({
      scopeKey: value.scopeKey,
      externalId: value.externalId,
    });
    f.binding.map.mockResolvedValue({
      shippingMethod: reorderedRef(f.input.shippingMethod),
      expectedShippingMethod: reorderedRef(f.input.expectedShippingMethod),
      order: reorderedRef(f.input.order),
    });
    const reorderedIntent: EffectIntent = {
      expectedPostcondition: { ...f.intent.expectedPostcondition },
      preconditions: {
        validUntil: f.intent.preconditions.validUntil,
        evidenceRefs: [...f.intent.preconditions.evidenceRefs],
      },
      parameters: {},
      target: { id: f.intent.target.id, kind: f.intent.target.kind },
      capabilityVersion: f.intent.capabilityVersion,
      capability: f.intent.capability,
      connectionId: f.intent.connectionId,
      tenantId: f.intent.tenantId,
    };
    expect(await effect.checkPreconditions(reorderedIntent)).toBe(true);
    await expect(
      effect.execute(reorderedIntent, 'reordered'),
    ).resolves.toMatchObject({ evidenceRefs: [expect.any(String)] });
    expect(await effect.verify(reorderedIntent)).toMatchObject({
      outcome: 'passed',
    });
    expect(f.effects()).toBe(1);
  });
  it('does not expose actions by default', () => {
    const f = fixture();
    f.options.shippingMethodActions = false;
    expect(
      createJtlConnector(f.options).capabilities[
        'orders.shipping-method.write'
      ],
    ).toBeUndefined();
  });
  it('blocks stale state, cancellation, invalid IDs and unscoped writes before PATCH', async () => {
    for (const change of [
      'stale',
      'cancelled',
      'invalid',
      'scope',
      'no-key',
    ] as const) {
      const f = fixture();
      if (change === 'stale') f.state.shippingMethodId = '9';
      if (change === 'cancelled') f.state.isCancelled = true;
      if (change === 'invalid') f.input.order.externalId = '../other';
      if (change === 'scope') f.input.order.scopeKey = 'other';
      expect(await f.write(change === 'no-key' ? '' : 'key')).toMatchObject({
        ok: false,
        error: { effect: 'none' },
      });
      expect(
        f.fetch.mock.calls.every((call) => call[1]?.method === 'GET'),
      ).toBe(true);
    }
  });
  it('blocks cross-tenant access and changed execution intent', async () => {
    const f = fixture();
    expect(
      await f.runtime().write(
        { ...context, tenantId: 'other' },
        {
          connectionId: f.options.connectionId,
          capability: 'orders.shipping-method.write',
          version: '0',
          input: f.input,
          idempotencyKey: 'key',
        },
      ),
    ).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    const effect = (await f.effectsRegistry().resolve(context, f.intent))!;
    await expect(
      effect.execute({ ...f.intent, parameters: { changed: true } }, 'key'),
    ).rejects.toMatchObject({ failure: { code: 'conflict' } });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('reconciles a lost response after adapter recreation without another effect', async () => {
    const f = fixture();
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1]?.method === 'PATCH')
        throw new Error('lost response with secret');

      return result;
    });
    expect(await f.write()).toEqual({
      ok: false,
      error: { code: 'transient', effect: 'unknown', retry: 'reconcile' },
    });
    expect(await f.write()).toMatchObject({
      ok: false,
      error: { code: 'conflict', effect: 'none' },
    });
    const recreated = (await f.effectsRegistry().resolve(context, f.intent))!;
    expect(await recreated.verify(f.intent)).toMatchObject({
      outcome: 'passed',
    });
    expect(f.effects()).toBe(1);
    expect(
      f.fetch.mock.calls.filter((call) => call[1]?.method === 'PATCH'),
    ).toHaveLength(1);
  });
  it('uses the same provider key across recreation, even after an external reversal', async () => {
    const f = fixture();
    await f.write();
    f.state.shippingMethodId = f.ids.before;
    await f.write();
    expect(f.effects()).toBe(1);
    const effect = (await f.effectsRegistry().resolve(context, f.intent))!;
    expect(await effect.verify(f.intent)).toMatchObject({ outcome: 'failed' });
  });
  it('namespaces provider keys by tenant and connection', async () => {
    const f = fixture();
    await f.write();
    const first = new Headers(f.fetch.mock.calls[1]![1]?.headers).get(
      'Idempotency-Key',
    );
    f.state.shippingMethodId = f.ids.before;
    f.options.connectionId = 'connection-b';
    await f.write();
    expect(
      new Headers(f.fetch.mock.calls[3]![1]?.headers).get('Idempotency-Key'),
    ).not.toBe(first);
  });
  it('retains the provider request ID in the write receipt', async () => {
    const f = fixture();
    f.fetch
      .mockResolvedValueOnce(Response.json(f.state))
      .mockResolvedValueOnce(
        Response.json(
          { salesOrderId: '10' },
          { headers: { 'x-request-id': 'provider-42' } },
        ),
      );
    expect(await f.write()).toMatchObject({
      ok: true,
      value: { providerRequestId: 'provider-42' },
    });
  });
  it('retains request identity when the provider response is inconclusive', async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(Response.json(f.state)).mockResolvedValueOnce(
      new Response('invalid', {
        status: 500,
        headers: { 'x-request-id': 'uncertain-42' },
      }),
    );
    expect(await f.write()).toMatchObject({
      ok: false,
      error: { effect: 'unknown', providerRequestId: 'uncertain-42' },
    });
  });
  it.each([429, 500, 503, 302, 200])(
    'requires reconciliation after an uncertain PATCH response %s',
    async (status) => {
      const f = fixture();
      f.fetch
        .mockResolvedValueOnce(Response.json(f.state))
        .mockResolvedValueOnce(new Response('not-json', { status }));
      expect(await f.write()).toMatchObject({
        ok: false,
        error: { effect: 'unknown', retry: 'reconcile' },
      });
      expect(f.fetch).toHaveBeenCalledTimes(2);
    },
  );
  it.each([
    [400, 'invalid_input'],
    [401, 'authentication'],
    [403, 'permission_denied'],
    [404, 'not_found'],
    [409, 'conflict'],
  ] as const)('normalizes rejected PATCH %s', async (status, code) => {
    const f = fixture();
    f.fetch
      .mockResolvedValueOnce(Response.json(f.state))
      .mockResolvedValueOnce(new Response('secret', { status }));
    expect(await f.write()).toEqual({
      ok: false,
      error: { code, effect: 'none', retry: 'never' },
    });
  });
  it('rejects mismatched response identities and missing authoritative fields', async () => {
    const f = fixture();
    f.fetch
      .mockResolvedValueOnce(Response.json(f.state))
      .mockResolvedValueOnce(Response.json({ salesOrderId: '99' }));
    expect(await f.write()).toMatchObject({
      ok: false,
      error: { code: 'invalid_response', effect: 'unknown' },
    });
    f.fetch.mockResolvedValueOnce(
      Response.json({ id: '10', isCancelled: false }),
    );
    expect(await f.write()).toMatchObject({
      ok: false,
      error: { code: 'invalid_response', effect: 'none' },
    });
  });
  it('prevents dispatch when pre-action evidence cannot be persisted', async () => {
    const f = fixture();
    f.recordObservations.mockRejectedValueOnce(new Error('store unavailable'));
    expect(await f.write()).toMatchObject({ ok: false });
    expect(f.effects()).toBe(0);
  });
  it('does not pass verification for failed reads, cancelled orders or failed evidence persistence', async () => {
    const f = fixture();
    await f.write();
    const effect = (await f.effectsRegistry().resolve(context, f.intent))!;
    f.fetch.mockRejectedValueOnce(new Error('network'));
    expect(await effect.verify(f.intent)).toMatchObject({
      outcome: 'inconclusive',
    });
    f.recordObservations.mockRejectedValueOnce(new Error('store'));
    expect(await effect.verify(f.intent)).toMatchObject({
      outcome: 'inconclusive',
    });
    f.state.isCancelled = true;
    expect(await effect.verify(f.intent)).toMatchObject({ outcome: 'failed' });
    expect(f.effects()).toBe(1);
  });
  it('keeps changed mappings and additional postconditions from passing verification', async () => {
    const f = fixture();
    const effect = (await f.effectsRegistry().resolve(context, f.intent))!;
    f.binding.map.mockResolvedValue({ ...f.input, order: ref('99') });
    expect(await effect.checkPreconditions(f.intent)).toBe(false);
    expect(await effect.verify(f.intent)).toMatchObject({
      outcome: 'inconclusive',
    });
    expect(
      await f.effectsRegistry().resolve(context, {
        ...f.intent,
        expectedPostcondition: {
          shippingMethodId: f.ids.after,
          shipped: true,
        },
      }),
    ).toBeNull();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('requires an order target and matching expected postcondition', async () => {
    const f = fixture();
    expect(
      await f.effectsRegistry().resolve(context, {
        ...f.intent,
        expectedPostcondition: { shippingMethodId: '99' },
      }),
    ).toBeNull();
    expect(
      await f.effectsRegistry().resolve(context, {
        ...f.intent,
        target: { kind: 'fulfillment', id: 'x' },
      }),
    ).toBeNull();
  });
});
