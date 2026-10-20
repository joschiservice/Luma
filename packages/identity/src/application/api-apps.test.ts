import { expect, it } from 'vitest';

import type { Membership, TenantContext } from '../domain/context.js';
import { apiAppContext, makeTenantContext } from '../domain/context.js';
import type { BuiltInRoleKey } from '../domain/roles.js';
import { builtInReference, PermissionSet } from '../domain/roles.js';
import type {
  ApiAppRecord,
  ApiAppsTransaction,
  PersonalRead,
} from './api-apps.js';
import { createApiAppsService, maxOpenApiApps } from './api-apps.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const now = new Date('2026-10-20T10:00:00.000Z');

function membership(userId: string, key: BuiltInRoleKey): Membership {
  const role = builtInReference(key);

  return {
    id: `${userId.slice(0, -1)}0`,
    organizationId: tenantId,
    userId,
    role,
    status: 'active',
    permissions: PermissionSet.forRole(role),
  };
}

const owner = membership('22222222-2222-4222-8222-222222222222', 'owner');
const member = membership('33333333-3333-4333-8333-333333333333', 'member');
const other = membership('44444444-4444-4444-8444-444444444444', 'member');

function contextFor(person: Membership): TenantContext {
  return makeTenantContext(
    { userId: person.userId, sessionId: person.id },
    {
      id: tenantId,
      name: 'Workspace',
      slug: 'workspace',
      dataRegion: 'AU',
      status: 'active',
    },
    person,
    'request',
  );
}

function fixture() {
  const members = new Map(
    [owner, member, other].map((person) => [person.userId, person]),
  );
  const apps: ApiAppRecord[] = [];
  const hashes: string[] = [];
  const commands = new Map<
    string,
    { actorId: string; request: unknown; result: unknown }
  >();
  const events: { type: string; target: string; after: unknown }[] = [];
  const notices: { appId: string; userId: string }[] = [];
  const reads: PersonalRead[] = [];
  let sequence = 0;
  const tx: ApiAppsTransaction = {
    member: async (userId) => members.get(userId) ?? null,
    list: async (userId) =>
      apps
        .filter((app) => !userId || app.userId === userId)
        .map((app) => ({ ...app, ownerName: null })),
    app: async (id) => {
      const app = apps.find((item) => item.id === id);

      return app ? { ...app, ownerName: null } : null;
    },
    openCount: async (userId) =>
      apps.filter((app) => app.userId === userId && !app.revokedAt).length,
    saveApp: async (app) => {
      apps.push({
        ...app,
        createdAt: now.toISOString(),
        revokedAt: null,
        credential: null,
        personalReads: { requests: 0, records: 0 },
      });
    },
    saveCredential: async (credential) => {
      hashes.push(credential.hash);
      const app = apps.find((item) => item.id === credential.appId)!;
      app.credential = {
        id: credential.id,
        lastFour: credential.lastFour,
        createdAt: now.toISOString(),
        expiresAt: credential.expiresAt,
        lastUsedAt: null,
        revokedAt: null,
      };
    },
    revoke: async (appId) => {
      const app = apps.find((item) => item.id === appId)!;
      app.revokedAt = now.toISOString();
    },
    notifyRevoked: async (appId, userId) => {
      notices.push({ appId, userId });
    },
    command: async (id) => commands.get(id) ?? null,
    saveCommand: async (id, actorId, request, result) => {
      commands.set(id, {
        actorId,
        request,
        result: JSON.parse(JSON.stringify(result)),
      });
    },
    audit: async (_actorId, type, target, _before, after) => {
      events.push({ type, target, after });
    },
  };
  const service = createApiAppsService({
    repository: {
      transaction: async (_tenant, _user, operation) => operation(tx),
    },
    reads: {
      record: async (read) => {
        reads.push(read);
      },
    },
    issue: () => {
      sequence += 1;

      return {
        token: `token-${sequence}`,
        hash: `hash-${sequence}`,
        lastFour: `${sequence}`.padStart(4, '0'),
      };
    },
    id: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    now: () => now,
  });

  return { service, apps, hashes, events, members, notices, reads };
}

const create = (commandId = '55555555-5555-4555-8555-555555555555') => ({
  commandId,
  name: ' Reporting ',
  scopes: ['orders.read', 'customers.read'],
  lifetimeDays: 90,
});

it('creates an app for the member with the token once and records it', async () => {
  const { service, hashes, events } = fixture();
  const result = await service.create(contextFor(member), create());

  expect(result.token).toBe('token-2');
  expect(result.app).toMatchObject({
    name: 'Reporting',
    scopes: ['customers.read', 'orders.read'],
    status: 'active',
    owner: { userId: member.userId },
    expiresAt: '2027-01-18T10:00:00.000Z',
    lastFour: '0002',
  });
  expect(hashes).toEqual(['hash-2']);
  expect(events).toEqual([
    {
      type: 'api_app.created',
      target: result.app.id,
      after: expect.not.objectContaining({ token: expect.anything() }),
    },
  ]);
});

it('returns the original app without its token when a command is repeated', async () => {
  const { service } = fixture();
  const first = await service.create(contextFor(member), create());
  const again = await service.create(contextFor(member), create());

  expect(again).toEqual({ app: first.app, token: null });
  await expect(
    service.create(contextFor(member), { ...create(), name: 'Other' }),
  ).rejects.toMatchObject({ statusCode: 409 });
});

it.each([
  {
    name: 'a permission API apps can’t be granted',
    input: { scopes: ['orders.read', 'members.manage'] },
    status: 422,
  },
  {
    name: 'an unsupported lifetime',
    input: { lifetimeDays: 400 },
    status: 422,
  },
  { name: 'a blank name', input: { name: '   ' }, status: 422 },
])('refuses $name', async ({ input, status }) => {
  const { service } = fixture();

  await expect(
    service.create(contextFor(member), { ...create(), ...input }),
  ).rejects.toMatchObject({ statusCode: status });
});

it('refuses roles without the permission, API apps themselves and support views', async () => {
  const { service, members } = fixture();
  members.set(member.userId, {
    ...member,
    permissions: new PermissionSet(['orders.read', 'customers.read']),
  });
  await expect(
    service.create(contextFor(member), create()),
  ).rejects.toMatchObject({ statusCode: 403 });
  const app = apiAppContext(contextFor(owner), {
    id: '66666666-6666-4666-8666-666666666666',
    credentialId: '77777777-7777-4777-8777-777777777777',
    scopes: ['orders.read'],
  });
  await expect(service.list(app)).rejects.toMatchObject({ statusCode: 403 });
  const view = makeTenantContext(
    { userId: owner.userId, sessionId: owner.id },
    {
      id: tenantId,
      name: 'Workspace',
      slug: 'workspace',
      dataRegion: 'AU',
      status: 'active',
    },
    owner,
    'request',
    { id: owner.id, mode: 'consent', expiresAt: now.toISOString() },
  );
  await expect(service.create(view, create())).rejects.toMatchObject({
    code: 'READ_ONLY',
  });
});

it(`limits each member to ${maxOpenApiApps} apps that aren't revoked`, async () => {
  const { service } = fixture();
  for (let index = 0; index < maxOpenApiApps; index += 1)
    await service.create(
      contextFor(member),
      create(`55555555-5555-4555-8555-${String(index).padStart(12, '0')}`),
    );

  await expect(
    service.create(
      contextFor(member),
      create('55555555-5555-4555-8555-999999999999'),
    ),
  ).rejects.toMatchObject({ statusCode: 409 });
});

it('lists own apps, and every app for people who manage apps', async () => {
  const { service } = fixture();
  await service.create(contextFor(member), create());
  await service.create(
    contextFor(other),
    create('88888888-8888-4888-8888-888888888888'),
  );

  expect(await service.list(contextFor(member))).toHaveLength(1);
  expect(await service.list(contextFor(owner))).toHaveLength(2);
});

it('rotates only for the person the app acts for, and never a revoked app', async () => {
  const { service, hashes } = fixture();
  const { app } = await service.create(contextFor(member), create());
  const command = { commandId: '99999999-9999-4999-8999-999999999999' };
  const rotated = await service.rotate(contextFor(member), app.id, {
    ...command,
    lifetimeDays: 7,
  });

  expect(rotated.token).not.toBeNull();
  expect(rotated.app.expiresAt).toBe('2026-10-27T10:00:00.000Z');
  expect(hashes).toHaveLength(2);
  await expect(
    service.rotate(contextFor(owner), app.id, {
      commandId: '99999999-9999-4999-8999-999999999990',
      lifetimeDays: 7,
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
  await service.revoke(contextFor(member), app.id, {
    commandId: '99999999-9999-4999-8999-999999999991',
  });
  await expect(
    service.rotate(contextFor(member), app.id, {
      commandId: '99999999-9999-4999-8999-999999999992',
      lifetimeDays: 7,
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
});

it('lets the member and people who manage apps revoke, and hides apps from others', async () => {
  const { service, events, notices } = fixture();
  const { app } = await service.create(contextFor(member), create());

  await expect(
    service.revoke(contextFor(other), app.id, {
      commandId: '99999999-9999-4999-8999-999999999993',
    }),
  ).rejects.toMatchObject({ statusCode: 404 });
  expect(
    await service.revoke(contextFor(owner), app.id, {
      commandId: '99999999-9999-4999-8999-999999999994',
    }),
  ).toMatchObject({ status: 'revoked' });
  await service.revoke(contextFor(member), app.id, {
    commandId: '99999999-9999-4999-8999-999999999995',
  });
  expect(events.map((event) => event.type)).toEqual([
    'api_app.created',
    'api_app.revoked',
  ]);
  expect(notices).toEqual([{ appId: app.id, userId: member.userId }]);
});

it('doesn’t email people who revoke their own app', async () => {
  const { service, notices } = fixture();
  const { app } = await service.create(contextFor(member), create());

  await service.revoke(contextFor(member), app.id, {
    commandId: '99999999-9999-4999-8999-999999999996',
  });

  expect(notices).toEqual([]);
});

it('records personal data reads only for API apps that can read customers', async () => {
  const { service, reads } = fixture();
  const app = { id: 'app', credentialId: 'credential' };
  const withCustomers = apiAppContext(contextFor(member), {
    ...app,
    scopes: ['customers.read', 'orders.read'],
  });
  const ordersOnly = apiAppContext(contextFor(member), {
    ...app,
    scopes: ['orders.read'],
  });
  const route = '/v1/organizations/{organizationId}/orders';

  await service.recordPersonalRead(withCustomers, route, {
    items: [{}, {}, {}],
  });
  await service.recordPersonalRead(withCustomers, `${route}/{orderId}`, {
    id: 'order',
  });
  await service.recordPersonalRead(ordersOnly, route, { items: [{}] });
  await service.recordPersonalRead(contextFor(member), route, { items: [{}] });

  expect(reads).toEqual([
    {
      tenantId,
      userId: member.userId,
      appId: 'app',
      credentialId: 'credential',
      route: '/orders',
      records: 3,
    },
    {
      tenantId,
      userId: member.userId,
      appId: 'app',
      credentialId: 'credential',
      route: '/orders/{orderId}',
      records: 1,
    },
  ]);
});
