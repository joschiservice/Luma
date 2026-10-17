import { randomUUID } from 'node:crypto';

import type { AppFactoryContext } from '@luma/app-host';
import { type InstalledConnection, secretBinding } from '@luma/connections';
import type { StoredInstallation } from '@luma/connections/composition';
import type { TenantContext } from '@luma/identity';
import { IdentityError } from '@luma/identity';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { createStarshipitProvider } from './index.js';
import { installationCredentials } from './infrastructure/installation-validation.js';
import { registerStarshipitRoutes } from './routes.js';
import type { createStarshipitUpdates } from './updates.js';
import { createWebhookSecrets } from './webhook-secrets.js';

const keys = { token: 'api-key', subscriptionKey: 'subscription-key' };
const strong = 'f3c1a9e07b5d2864f3c1a9e07b5d2864f3c1a9e0';
const input = {
  label: 'Shipping',
  target: { kind: 'starshipit', accountId: 'account' },
  credentials: keys,
  permissions: ['orders.read' as const],
};
const tenantId = randomUUID();
const connectionId = randomUUID();
const tenant = {
  tenantId,
  actor: { id: 'user-1' },
} as unknown as TenantContext;
const connection = {
  id: connectionId,
  tenantId,
  appId: 'starshipit',
  provider: 'starshipit',
  label: 'Shipping',
  target: { kind: 'starshipit', accountId: 'account' },
  permissions: ['orders.read'],
  granted: ['orders.read'],
  status: 'active',
  version: 3,
  credentialVersion: 2,
  appInstallationVersion: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as InstalledConnection;
// Readable stand-in for the real cipher: binds the payload to its connection identity.
const cipher = {
  seal: (value: unknown, binding: string) => JSON.stringify({ value, binding }),
  open: (value: string, binding: string) => {
    const sealed = JSON.parse(value) as { value: unknown; binding: string };
    if (sealed.binding !== binding) throw new Error('binding mismatch');

    return sealed.value;
  },
};

function memoryRepository(record: StoredInstallation | null) {
  const events: { event: string; actorId: string; version: number }[] = [];
  let current = record;

  return {
    events,
    current: () => current,
    repository: {
      list: async () => (current ? [current.connection] : []),
      get: async () => current,
      save: async (
        next: StoredInstallation,
        expected: number | null,
        actorId: string,
        event: string,
      ) => {
        if (current?.connection.version !== expected) return false;
        current = next;
        events.push({ event, actorId, version: next.connection.version });

        return true;
      },
    },
  };
}

function secrets(
  record: StoredInstallation | null,
  overrides: Partial<AppFactoryContext> = {},
) {
  const memory = memoryRepository(record);
  const service = createWebhookSecrets(
    {
      database: {} as AppFactoryContext['database'],
      cipher: cipher as unknown as AppFactoryContext['cipher'],
      refreshContext: async (context) => context,
      requirePermission: async () => {},
      ...overrides,
    },
    { repository: memory.repository, now: () => new Date('2026-02-01') },
  );

  return { ...memory, service };
}

const stored = (webhookSecret?: string): StoredInstallation => ({
  connection,
  secret: cipher.seal(
    { ...keys, ...(webhookSecret ? { webhookSecret } : {}) },
    secretBinding(connection),
  ),
});

describe('Starshipit webhook secret validation', () => {
  const provider = createStarshipitProvider({});

  it('stores browser-entered keys without inventing an unreadable secret', () => {
    expect(provider.validate(input).credentials).toEqual(keys);
    expect(provider.credentials(input.target, keys)).toEqual(keys);
  });

  it('refuses weak supplied or stored secrets and keeps strong ones', () => {
    for (const webhookSecret of ['x', 'short-secret', 'ab'.repeat(20)]) {
      expect(() =>
        provider.validate({
          ...input,
          credentials: { ...keys, webhookSecret },
        }),
      ).toThrow();
      expect(() =>
        installationCredentials.parse({ ...keys, webhookSecret }),
      ).toThrow();
    }
    expect(
      provider.credentials(input.target, { ...keys, webhookSecret: strong })
        .webhookSecret,
    ).toBe(strong);
  });
});

describe('Starshipit webhook secret generation', () => {
  it('returns a new 32-byte secret once, keeps the keys and records the event without it', async () => {
    const { service, current, events } = secrets(stored(strong));

    const result = await service.generate(tenant, {
      connectionId,
      version: 3,
    });

    expect(result.path).toBe(
      `/v1/starshipit/changes/${tenantId}/${connectionId}`,
    );
    expect(result.authorization).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/);
    expect(result.version).toBe(4);
    const saved = current()!;
    expect(saved.connection).toMatchObject({
      version: 4,
      credentialVersion: 2,
      status: 'active',
    });
    // The old secret stops working at once: only the new one remains stored.
    expect(
      cipher.open(saved.secret!, JSON.parse(saved.secret!).binding),
    ).toEqual({
      ...keys,
      webhookSecret: result.authorization.slice('Bearer '.length),
    });
    expect(events).toEqual([
      { event: 'webhook_secret_generated', actorId: 'user-1', version: 4 },
    ]);
    expect(JSON.stringify(events)).not.toContain(result.authorization.slice(7));

    const next = await service.generate(tenant, { connectionId, version: 4 });
    expect(next.authorization).not.toBe(result.authorization);
  });

  it('adds a secret to connections saved without one', async () => {
    const { service } = secrets(stored());

    await expect(
      service.generate(tenant, { connectionId, version: 3 }),
    ).resolves.toMatchObject({
      authorization: expect.stringMatching(/^Bearer /),
    });
  });

  it('rejects stale versions, unavailable connections, missing permission and support views', async () => {
    await expect(
      secrets(stored(strong)).service.generate(tenant, {
        connectionId,
        version: 2,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      secrets({
        connection: { ...connection, status: 'revoked' },
        secret: null,
      }).service.generate(tenant, { connectionId, version: 3 }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      secrets({
        connection: { ...connection, appId: 'shopify' },
        secret: stored(strong).secret,
      }).service.generate(tenant, { connectionId, version: 3 }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      secrets(stored(strong)).service.generate(tenant, { connectionId }),
    ).rejects.toMatchObject({ statusCode: 422 });

    const denied = secrets(stored(strong), {
      requirePermission: async () => {
        throw new IdentityError(403, 'FORBIDDEN', 'Missing connections.manage');
      },
    });
    await expect(
      denied.service.generate(tenant, { connectionId, version: 3 }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(denied.events).toEqual([]);

    const support = secrets(stored(strong));
    await expect(
      support.service.generate(
        { ...tenant, supportView: {} } as unknown as TenantContext,
        { connectionId, version: 3 },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(support.events).toEqual([]);
  });
});

describe('Starshipit webhook authentication', () => {
  function server(record: StoredInstallation | null) {
    const query = vi.fn(async () => ({
      rows: record
        ? [{ document: record.connection, secret: record.secret }]
        : [],
    }));
    const database = {
      transaction: vi.fn(
        async (
          _tenant: string,
          run: (tx: { query: typeof query }) => unknown,
        ) => await run({ query }),
      ),
      query,
    };
    const open = vi.fn(cipher.open);
    const app = Fastify();
    registerStarshipitRoutes(
      app,
      {} as ReturnType<typeof createStarshipitUpdates>,
      {
        database,
        cipher: { ...cipher, open },
      } as unknown as AppFactoryContext,
    );

    return { app, database, open };
  }

  const url = `/v1/starshipit/changes/${tenantId}/${connectionId}`;

  it('refuses malformed bearer headers before reading the connection', async () => {
    const { app, database, open } = server(stored(strong));

    for (const authorization of [
      undefined,
      'Bearer x',
      'Basic dXNlcjpwYXNzd29yZC1sb25nLWVub3VnaC10by1wYXNz',
      `Bearer ${'a'.repeat(31)}`,
    ]) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: authorization ? { authorization } : {},
        payload: { order_id: 1 },
      });
      expect(response.statusCode, authorization).toBe(401);
    }
    expect(database.transaction).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    await app.close();
  });

  it('accepts only the stored secret and refuses connections holding a short legacy secret', async () => {
    const valid = server(stored(strong));
    const accepted = await valid.app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${strong}` },
      payload: { order_id: 1 },
    });
    // Without the fulfillment release the wakeup is acknowledged and not stored.
    expect(accepted.statusCode).toBe(202);
    const wrong = await valid.app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${strong.replace('f', 'e')}` },
      payload: { order_id: 1 },
    });
    expect(wrong.statusCode).toBe(401);
    await valid.app.close();

    const legacy = server(stored('legacy-short-secret'));
    const refused = await legacy.app.inject({
      method: 'POST',
      url,
      headers: {
        authorization: `Bearer ${'legacy-short-secret'.padEnd(40, '0')}`,
      },
      payload: { order_id: 1 },
    });
    expect(refused.statusCode).toBe(401);
    await legacy.app.close();

    const missing = server(stored());
    const unconfigured = await missing.app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${strong}` },
      payload: { order_id: 1 },
    });
    expect(unconfigured.statusCode).toBe(401);
    await missing.app.close();
  });
});
