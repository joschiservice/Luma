import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { request } from 'node:https';
import { Readable } from 'node:stream';

import type { InstallationCapability } from '@luma/connections';
import * as connectorPublic from '@luma/connections';
import { ConnectorError } from '@luma/connections';
import type { StoredInstallation } from '@luma/connections/composition';
import * as connectorComposition from '@luma/connections/composition';
import {
  createInstallationService,
  createInstalledRuntime,
  createInstalledShippingMethodEffects,
  createSecretCipher,
} from '@luma/connections/composition';
import { makeTenantContext } from '@luma/identity/composition';
import { describe, expect, it, vi } from 'vitest';

it('keeps raw runtime and handler factories out of application entry points', () => {
  for (const exports of [connectorPublic, connectorComposition]) {
    expect(exports).not.toHaveProperty('createCapabilityRuntime');
    expect(exports).not.toHaveProperty('createJtlConnector');
    expect(exports).not.toHaveProperty('createShopifyConnector');
  }
});

vi.mock('node:https', () => ({ request: vi.fn() }));

function pinnedProvider(fetch: typeof globalThis.fetch) {
  vi.mocked(request).mockImplementation((url, options, callback) => {
    const req = new EventEmitter();

    return Object.assign(req, {
      end: (body?: string) => {
        void fetch(String(url), {
          method: options.method ?? 'GET',
          headers: options.headers as Record<string, string>,
          ...(body ? { body } : {}),
        })
          .then(async (response) => {
            callback!(
              Object.assign(
                Readable.from([Buffer.from(await response.arrayBuffer())]),
                {
                  statusCode: response.status,
                  headers: Object.fromEntries(response.headers),
                },
              ) as never,
            );
          })
          .catch((error) => req.emit('error', error));
      },
    }) as never;
  });
}

const context = (
  tenantId: string = randomUUID(),
  role: 'admin' | 'member' = 'admin',
) =>
  makeTenantContext(
    { userId: 'user', sessionId: 'session' },
    {
      id: tenantId,
      name: 'Store',
      slug: 'store',
      dataRegion: 'EU',
      status: 'active',
    },
    { id: 'membership', organizationId: tenantId, userId: 'user', role },
    'request',
  );

const input = {
  label: 'Shop',
  target: { kind: 'shopify', shop: 'example.myshopify.com' },
  permissions: ['products.read'],
  credentials: { token: 'secret-token' },
};

function fixture() {
  const records = new Map<string, StoredInstallation>();
  const events: unknown[] = [];
  const refreshContext = vi.fn(async (c: ReturnType<typeof context>) => c);
  const verify = vi.fn(async (): Promise<InstallationCapability[]> => [
    'products.read',
  ]);
  const service = createInstallationService({
    repository: {
      list: async (tenantId) =>
        [...records.values()]
          .filter((r) => r.connection.tenantId === tenantId)
          .map((r) => structuredClone(r.connection)),
      get: async (tenantId, id) =>
        structuredClone(records.get(`${tenantId}/${id}`) ?? null),
      save: async (record, version, actor, event) => {
        const key = `${record.connection.tenantId}/${record.connection.id}`;
        if ((records.get(key)?.connection.version ?? null) !== version)
          return false;
        records.set(key, structuredClone(record));
        events.push({ actor, event, version: record.connection.version });

        return true;
      },
    },
    cipher: createSecretCipher('key1', new Map([['key1', randomBytes(32)]])),
    refreshContext,
    verify,
    now: () => new Date('2026-09-18T00:00:00Z'),
    id: randomUUID,
  });

  return { records, events, refreshContext, verify, service, ctx: context() };
}

describe('installed connection lifecycle', () => {
  it('encrypts setup, verifies grants, rotates, and deletes credentials on disconnect', async () => {
    const { service, ctx, records, events } = fixture();
    const pending = await service.install(ctx, input);
    expect(pending.status).toBe('pending');
    expect(JSON.stringify([...records.values()])).not.toContain('secret-token');
    expect(JSON.stringify(await service.list(ctx))).not.toContain('secret');
    await expect(
      service.credential(ctx, pending.id, 'products.read'),
    ).rejects.toThrow();
    const active = await service.check(ctx, pending.id, 1);
    expect(active.status).toBe('active');
    expect(
      (await service.credential(ctx, pending.id, 'products.read')).credentials
        .token,
    ).toBe('secret-token');
    await expect(
      service.credential(ctx, pending.id, 'orders.read'),
    ).rejects.toThrow();
    const rotated = await service.rotate(ctx, active.id, 2, {
      token: 'replacement',
    });
    expect(rotated).toMatchObject({
      status: 'pending',
      granted: [],
      credentialVersion: 2,
    });
    await expect(
      service.credential(ctx, active.id, 'products.read'),
    ).rejects.toThrow();
    await service.check(ctx, active.id, 3);
    expect(
      (await service.credential(ctx, active.id, 'products.read')).credentials
        .token,
    ).toBe('replacement');
    await service.disconnect(ctx, active.id, 4);
    expect(records.get(`${ctx.tenantId}/${active.id}`)?.secret).toBeNull();
    await expect(service.check(ctx, active.id, 5)).rejects.toThrow();
    expect(events).toHaveLength(5);
    expect(JSON.stringify(events)).not.toContain('replacement');
  });
  it('isolates tenants and refreshes admin membership before changes', async () => {
    const { service, ctx, refreshContext } = fixture();
    const connection = await service.install(ctx, input);
    expect(await service.list(context())).toEqual([]);
    await expect(
      service.rotate(context(), connection.id, 1, { token: 'new' }),
    ).rejects.toMatchObject({ statusCode: 404 });
    refreshContext.mockResolvedValue(context(ctx.tenantId, 'member'));
    await expect(
      service.disconnect(ctx, connection.id, 1),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.install(ctx, input)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
  it('fails closed on missing grants and provider failures without leaking errors', async () => {
    const { service, ctx, verify } = fixture();
    const connection = await service.install(ctx, input);
    verify.mockResolvedValueOnce([]);
    expect(await service.check(ctx, connection.id, 1)).toMatchObject({
      status: 'degraded',
    });
    verify.mockRejectedValueOnce(new Error('Authorization: secret-token'));
    const result = await service.check(ctx, connection.id, 2);
    expect(result.status).toBe('degraded');
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });
  it('cannot resurrect a connection revoked during verification', async () => {
    const { service, ctx, verify } = fixture();
    const connection = await service.install(ctx, input);
    verify.mockImplementationOnce(async () => {
      await service.disconnect(ctx, connection.id, 1, 'revoked');

      return ['products.read'];
    });
    await expect(service.check(ctx, connection.id, 1)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect((await service.list(ctx))[0]?.status).toBe('revoked');
    await expect(
      service.rotate(ctx, connection.id, 2, { token: 'new' }),
    ).rejects.toThrow();
  });
  it.each([
    { ...input, permissions: ['orders.write'] },
    { ...input, credentials: { token: '\r\nAuthorization: injected' } },
    { ...input, target: { kind: 'shopify', shop: 'example.com' } },
    {
      ...input,
      target: {
        kind: 'jtl-onprem',
        baseUrl: 'http://host/db/',
        appId: 'app',
        appVersion: '1',
      },
    },
  ])('rejects invalid setup without persisting it', async (settings) => {
    const { service, ctx, records } = fixture();
    await expect(service.install(ctx, settings)).rejects.toThrow();
    expect(records.size).toBe(0);
  });
  it('supports JTL cloud and on-premise credentials', async () => {
    const { service, ctx } = fixture();
    for (const target of [
      { kind: 'jtl-cloud', jtlTenantId: randomUUID() },
      {
        kind: 'jtl-onprem',
        baseUrl: 'https://erp.example.test/db/',
        appId: 'app',
        appVersion: '1',
      },
    ]) {
      const connection = await service.install(ctx, {
        ...input,
        target,
        credentials: { token: 'api-key', challengeCode: 'challenge' },
      });
      await service.check(ctx, connection.id, 1);
      expect(
        (await service.credential(ctx, connection.id, 'products.read'))
          .credentials.token,
      ).toBe('api-key');
    }
  });
  it.each(['shopify', 'jtl-cloud', 'jtl-onprem'] as const)(
    'dispatches %s reads with current encrypted credentials',
    async (kind) => {
      const { service, ctx } = fixture();
      const target =
        kind === 'shopify'
          ? input.target
          : kind === 'jtl-cloud'
            ? { kind, jtlTenantId: randomUUID() }
            : {
                kind,
                baseUrl: 'https://erp.example.test/db/',
                appId: 'app',
                appVersion: '1',
              };
      const connection = await service.install(ctx, {
        ...input,
        target,
        credentials: { token: 'initial-token', challengeCode: 'challenge' },
      });
      await service.check(ctx, connection.id, 1);
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        Response.json(
          kind === 'shopify'
            ? {
                data: {
                  page: {
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              }
            : { items: [], totalItems: 0, pageNumber: 1, pageSize: 1 },
        ),
      );
      if (kind === 'jtl-onprem') pinnedProvider(fetch);
      const approve = vi.fn(async () => {});
      const recordObservations = vi.fn(async () => {});
      const record = vi.fn(async () => {});
      const runtime = createInstalledRuntime({
        installations: service,
        record,
        recordObservations,
        approveJtlEndpoint: approve,
        jtlEndpoints: [
          {
            tenantId: ctx.tenantId,
            baseUrl: 'https://erp.example.test/db/',
            addresses: ['10.0.0.5'],
          },
        ],
        fetch,
      });
      const read = () =>
        runtime.read(ctx, {
          connectionId: connection.id,
          capability: 'products.read',
          version: '0',
          input: { limit: 1 },
        });
      expect(await read()).toMatchObject({ ok: true });
      expect(recordObservations).toHaveBeenCalledOnce();
      await service.rotate(ctx, connection.id, 2, {
        token: 'rotated-token',
        challengeCode: 'new-challenge',
      });
      await service.check(ctx, connection.id, 3);
      expect(await read()).toMatchObject({ ok: true });
      const headers = new Headers(fetch.mock.calls.at(-1)?.[1]?.headers);
      expect(
        kind === 'shopify'
          ? headers.get('X-Shopify-Access-Token')
          : headers.get('Authorization'),
      ).toContain('rotated-token');
      if (kind === 'jtl-onprem') {
        expect(headers.get('x-challengecode')).toBe('new-challenge');
        expect(approve).toHaveBeenCalledTimes(2);
        approve.mockRejectedValueOnce(new Error('Destination not approved'));
        expect(await read()).toMatchObject({ ok: false });
        expect(fetch).toHaveBeenCalledTimes(2);
      }
      expect(JSON.stringify(record.mock.calls)).not.toContain('token');
    },
  );
  it.each(['revoked', 'disconnected', 'rotated', 'grants-cleared'] as const)(
    'returns unavailable when a connection is %s during resolution',
    async (change) => {
      for (const operation of ['read', 'discover'] as const) {
        const { service, ctx, records } = fixture();
        const connection = await service.install(ctx, input);
        await service.check(ctx, connection.id, 1);
        const list = service.list.bind(service);
        vi.spyOn(service, 'list').mockImplementationOnce(async (context) => {
          const snapshot = await list(context);
          if (change === 'rotated') {
            await service.rotate(ctx, connection.id, 2, {
              token: 'replacement',
            });
          } else if (change === 'grants-cleared') {
            records.get(
              `${ctx.tenantId}/${connection.id}`,
            )!.connection.granted = [];
          } else {
            await service.disconnect(ctx, connection.id, 2, change);
          }

          return snapshot;
        });
        const fetch = vi.fn();
        const record = vi.fn();
        const recordObservations = vi.fn();
        const runtime = createInstalledRuntime({
          installations: service,
          record,
          recordObservations,
          approveJtlEndpoint: vi.fn(),
          jtlEndpoints: [],
          fetch,
        });
        if (operation === 'discover') {
          await expect(runtime.discover(ctx, connection.id)).resolves.toEqual(
            [],
          );
        } else {
          await expect(
            runtime.read(ctx, {
              connectionId: connection.id,
              capability: 'products.read',
              version: '0',
              input: { limit: 1 },
            }),
          ).resolves.toEqual({
            ok: false,
            error: { code: 'unavailable', effect: 'none', retry: 'never' },
          });
        }
        expect(fetch).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
        expect(recordObservations).not.toHaveBeenCalled();
      }
    },
  );
  it('preserves unexpected credential resolution failures', async () => {
    const { service, ctx } = fixture();
    const connection = await service.install(ctx, input);
    await service.check(ctx, connection.id, 1);
    const error = new Error('Credential store unavailable');
    vi.spyOn(service, 'credential').mockRejectedValue(error);
    const runtime = createInstalledRuntime({
      installations: service,
      record: vi.fn(),
      recordObservations: vi.fn(),
      approveJtlEndpoint: vi.fn(),
      jtlEndpoints: [],
      fetch: vi.fn(),
    });
    await expect(runtime.discover(ctx, connection.id)).rejects.toBe(error);
    await expect(
      runtime.read(ctx, {
        connectionId: connection.id,
        capability: 'products.read',
        version: '0',
        input: { limit: 1 },
      }),
    ).rejects.toBe(error);
  });
  it('discovers only permitted capabilities and blocks a held runtime after revocation', async () => {
    const { service, ctx } = fixture();
    const connection = await service.install(ctx, input);
    await service.check(ctx, connection.id, 1);
    const fetch = vi.fn();
    const runtime = createInstalledRuntime({
      installations: service,
      record: vi.fn(),
      recordObservations: vi.fn(),
      approveJtlEndpoint: vi.fn(),
      jtlEndpoints: [],
      fetch,
    });
    expect(
      (await runtime.discover(ctx, connection.id)).map((c) => c.capability),
    ).toEqual(['products.read']);
    await service.disconnect(ctx, connection.id, 2, 'revoked');
    expect(await runtime.discover(ctx, connection.id)).toEqual([]);
    expect(
      await runtime.read(ctx, {
        connectionId: connection.id,
        capability: 'products.read',
        version: '0',
        input: { limit: 1 },
      }),
    ).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(fetch).not.toHaveBeenCalled();
  });
});

it('authenticates ciphertext binding and retains old key support during key rotation', () => {
  const keys = new Map([
    ['old', randomBytes(32)],
    ['new', randomBytes(32)],
  ]);
  const old = createSecretCipher('old', keys);
  const cipher = createSecretCipher('new', keys);
  const encrypted = old.seal(
    { token: 'sensitive' },
    'tenant/connection/version',
  );
  expect(cipher.open(encrypted, 'tenant/connection/version')).toEqual({
    token: 'sensitive',
  });
  expect(() =>
    cipher.open(encrypted, 'other-tenant/connection/version'),
  ).toThrow('Connection credentials unavailable');
  const tampered = JSON.parse(encrypted);
  tampered.ciphertext = Buffer.from('tampered').toString('base64');
  expect(() =>
    cipher.open(JSON.stringify(tampered), 'tenant/connection/version'),
  ).toThrow();
  expect(() => createSecretCipher('missing', keys)).toThrow();
  expect(() =>
    createSecretCipher('old', new Map([['old', randomBytes(16)]])),
  ).toThrow();
});

describe('installed shipping-method permissions', () => {
  const actionInput = {
    label: 'JTL',
    target: {
      kind: 'jtl-cloud',
      jtlTenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
    },
    credentials: { token: 'secret' },
    permissions: [
      'orders.shipping-method.read',
      'orders.shipping-method.write',
    ],
  };
  it('requires JTL and the authoritative read permission', async () => {
    const f = fixture();
    await expect(
      f.service.install(f.ctx, { ...actionInput, target: input.target }),
    ).rejects.toThrow();
    await expect(
      f.service.install(f.ctx, {
        ...actionInput,
        permissions: ['orders.shipping-method.write'],
      }),
    ).rejects.toThrow();
  });
  it('requires verified grants and rechecks revocation before PATCH', async () => {
    const f = fixture();
    f.verify.mockResolvedValue([
      'orders.shipping-method.read',
      'orders.shipping-method.write',
    ]);
    const connection = await f.service.install(f.ctx, actionInput);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      await f.service.disconnect(f.ctx, connection.id, 2, 'revoked');

      return Response.json({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000010',
        shippingMethodId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000007',
        isCancelled: false,
        shippingDetails: { shippingDate: null },
      });
    });
    const options = {
      installations: f.service,
      fetch,
      record: vi.fn(),
      recordObservations: vi.fn(),
      approveJtlEndpoint: vi.fn(),
      jtlEndpoints: [],
    };
    const runtime = createInstalledRuntime(options);
    expect(await runtime.discover(f.ctx, connection.id)).toEqual([]);
    await f.service.check(f.ctx, connection.id, 1);
    expect(
      (await runtime.discover(f.ctx, connection.id)).map((c) => c.capability),
    ).toEqual(actionInput.permissions);
    const ref = (externalId: string) => ({ externalId, scopeKey: '' });
    expect(
      await installedWrite(options, f.ctx, {
        connectionId: connection.id,
        capability: 'orders.shipping-method.write',
        version: '0',
        idempotencyKey: 'key',
        input: {
          order: ref('aaaaaaaa-aaaa-4aaa-8aaa-000000000010'),
          expectedShippingMethod: ref('aaaaaaaa-aaaa-4aaa-8aaa-000000000007'),
          shippingMethod: ref('aaaaaaaa-aaaa-4aaa-8aaa-000000000008'),
        },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'unavailable', effect: 'none' },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('GET');
  });
});

describe('installed JTL address pins', () => {
  const target = {
    kind: 'jtl-onprem' as const,
    baseUrl: 'https://erp.example.test/db/',
    appId: 'app',
    appVersion: '1',
  };

  function assertPin(address: string) {
    const options = vi.mocked(request).mock.calls.at(-1)![1];
    const callback = vi.fn();
    (
      options.lookup as (
        host: string,
        options: { all: boolean },
        callback: (...args: unknown[]) => void,
      ) => void
    )('erp.example.test', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address, family: 4 }]);
  }

  it('pins every page, rechecks tenant approval and never uses the generic transport', async () => {
    const f = fixture();
    const installed = await f.service.install(f.ctx, {
      ...input,
      target,
      credentials: { token: 'private-token', challengeCode: 'challenge' },
    });
    await f.service.check(f.ctx, installed.id, 1);
    const provider = vi.fn<typeof globalThis.fetch>(async (url) => {
      const pageNumber = Number(
        new URL(String(url)).searchParams.get('pageNumber'),
      );

      return Response.json({
        items: [
          {
            id: pageNumber,
            sKU: 'SKU',
            isActive: true,
            isInventoryManagementActive: true,
          },
        ],
        totalItems: 2,
        pageNumber,
        pageSize: 1,
      });
    });
    pinnedProvider(provider);
    const genericFetch = vi.fn();
    const endpoints = [
      {
        tenantId: f.ctx.tenantId,
        baseUrl: target.baseUrl,
        addresses: ['10.0.0.5'],
      },
    ];
    const runtime = createInstalledRuntime({
      installations: f.service,
      record: vi.fn(),
      recordObservations: vi.fn(),
      approveJtlEndpoint: vi.fn(),
      jtlEndpoints: endpoints,
      fetch: genericFetch,
    });
    const read = (cursor?: string) =>
      runtime.read(f.ctx, {
        connectionId: installed.id,
        capability: 'products.read',
        version: '0',
        input: { limit: 1, ...(cursor ? { cursor } : {}) },
      });
    const first = await read();
    expect(first.ok).toBe(true);
    if (!first.ok || !first.value.nextCursor)
      throw new Error('Expected a second page');
    assertPin('10.0.0.5');
    endpoints[0]!.addresses = ['10.0.0.6'];
    expect(await read(first.value.nextCursor)).toMatchObject({
      ok: true,
      value: { nextCursor: null },
    });
    assertPin('10.0.0.6');
    endpoints[0]!.tenantId = randomUUID();
    expect(await read()).toMatchObject({
      ok: false,
      error: { code: 'permission_denied' },
    });
    endpoints.length = 0;
    expect(await read()).toMatchObject({
      ok: false,
      error: { code: 'permission_denied' },
    });
    expect(provider).toHaveBeenCalledTimes(2);
    expect(genericFetch).not.toHaveBeenCalled();
  });
  it('pins both precondition GET and authorized PATCH and preserves the write body', async () => {
    const f = fixture();
    f.verify.mockResolvedValue([
      'orders.shipping-method.read',
      'orders.shipping-method.write',
    ]);
    const installed = await f.service.install(f.ctx, {
      ...input,
      target,
      credentials: { token: 'private-token', challengeCode: 'challenge' },
      permissions: [
        'orders.shipping-method.read',
        'orders.shipping-method.write',
      ],
    });
    await f.service.check(f.ctx, installed.id, 1);
    const provider = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      assertPin('10.0.0.5');

      return Response.json(
        init?.method === 'PATCH'
          ? { salesOrderId: '10' }
          : {
              id: '10',
              shippingMethodId: '7',
              isCancelled: false,
              shippingDetails: { shippingDate: null },
            },
      );
    });
    pinnedProvider(provider);
    const genericFetch = vi.fn();
    const options = {
      installations: f.service,
      record: vi.fn(),
      recordObservations: vi.fn(),
      approveJtlEndpoint: vi.fn(),
      jtlEndpoints: [
        {
          tenantId: f.ctx.tenantId,
          baseUrl: target.baseUrl,
          addresses: ['10.0.0.5'],
        },
      ],
      fetch: genericFetch,
    };
    const runtime = createInstalledRuntime(options);
    expect(Object.keys(runtime).sort()).toEqual(['discover', 'read']);
    expect(
      await runtime.read(f.ctx, {
        connectionId: installed.id,
        capability: 'orders.shipping-method.write',
        version: '0',
        input: {},
      } as never),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(provider).not.toHaveBeenCalled();
    const ref = (externalId: string) => ({ externalId, scopeKey: '' });
    expect(
      await installedWrite(options, f.ctx, {
        connectionId: installed.id,
        capability: 'orders.shipping-method.write',
        version: '0',
        idempotencyKey: 'logical-key',
        input: {
          order: ref('10'),
          expectedShippingMethod: ref('7'),
          shippingMethod: ref('8'),
        },
      }),
    ).toMatchObject({ ok: true });
    expect(provider).toHaveBeenCalledTimes(2);
    const init = provider.mock.calls[1]![1]!;
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({
      shippingMethodId: '8',
      disableAutomaticWorkflows: true,
    });
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Wawi private-token');
    expect(headers.get('x-challengecode')).toBe('challenge');
    expect(headers.get('idempotency-key')).toMatch(/^[a-f0-9]{64}$/);
    expect(genericFetch).not.toHaveBeenCalled();
  });
});

it('records Shopify authorization failures without overwriting newer credentials', async () => {
  const f = fixture();
  const installed = await f.service.install(f.ctx, input);
  await f.service.check(f.ctx, installed.id, 1);
  await f.service.rotate(f.ctx, installed.id, 2, { token: 'new-token' });
  await f.service.check(f.ctx, installed.id, 3);
  await f.service.recordFailure(f.ctx, installed.id, 1, 'authentication');
  expect((await f.service.list(f.ctx))[0]!.status).toBe('active');
  await f.service.recordFailure(f.ctx, installed.id, 2, 'permission_denied');
  expect((await f.service.list(f.ctx))[0]!.status).toBe('degraded');
  await f.service.check(f.ctx, installed.id, 5);
  await f.service.recordFailure(f.ctx, installed.id, 2, 'authentication');
  expect((await f.service.list(f.ctx))[0]!.status).toBe('revoked');
  await expect(
    f.service.credential(f.ctx, installed.id, 'products.read'),
  ).rejects.toThrow();
});

async function installedWrite(
  options: Parameters<typeof createInstalledRuntime>[0],
  context: Parameters<ReturnType<typeof createInstalledRuntime>['read']>[0],
  request: {
    connectionId: string;
    capability: 'orders.shipping-method.write';
    version: '0';
    idempotencyKey: string;
    input: import('@luma/connections').CapabilityInput<'orders.shipping-method.write'>;
  },
) {
  const registry = createInstalledShippingMethodEffects(options, {
    map: async () => request.input,
    checkPreconditions: async () => true,
  });
  const intent = {
    tenantId: context.tenantId,
    connectionId: request.connectionId,
    capability: request.capability,
    capabilityVersion: request.version,
    target: { kind: 'order', id: randomUUID() },
    parameters: {},
    preconditions: {
      evidenceRefs: [randomUUID()],
      validUntil: new Date(Date.now() + 60000).toISOString(),
    },
    expectedPostcondition: {
      shippingMethodId: request.input.shippingMethod.externalId,
    },
  };
  const adapter = await registry.resolve(context, intent);
  if (!adapter) throw new Error('Test effect unavailable');
  try {
    return {
      ok: true,
      value: await adapter.execute(intent, request.idempotencyKey),
    };
  } catch (error) {
    if (error instanceof ConnectorError)
      return { ok: false, error: error.failure };
    throw error;
  }
}
