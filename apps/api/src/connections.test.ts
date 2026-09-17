import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { makeTenantContext } from './modules/identity/composition.js';
import {
  createInstallationService,
  createSecretCipher,
  createInstalledRuntime,
} from './modules/connectors/composition.js';
import type { StoredInstallation } from './modules/connectors/composition.js';
import type { ReadCapability } from './modules/connectors/index.js';

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
  const verify = vi.fn(async (): Promise<ReadCapability[]> => [
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
      const approve = vi.fn(async () => {});
      const recordObservations = vi.fn(async () => {});
      const record = vi.fn(async () => {});
      const runtime = createInstalledRuntime({
        installations: service,
        record,
        recordObservations,
        approveJtlEndpoint: approve,
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
