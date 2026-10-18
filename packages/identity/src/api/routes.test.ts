import { apiContract } from '@luma/api-contract';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';

import type {
  IdentityRepository,
  IdentityTransaction,
} from '../application/identity.js';
import { createIdentityService } from '../application/identity.js';
import type { SupportViewCredentials } from '../application/support-view.js';
import type { Membership, Organization } from '../domain/context.js';
import { IdentityError } from '../domain/context.js';
import type { BuiltInRoleKey } from '../domain/roles.js';
import { builtInReference, PermissionSet } from '../domain/roles.js';
import { registerAuthHandler } from './auth-handler.js';
import { registerContractRoutes } from './contract-routes.js';
import { identityRoutes, registerIdentityGuards } from './routes.js';

const organization: Organization = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Organization',
  slug: 'organization',
  status: 'active',
  dataRegion: 'AU',
};
// An open workspace has no announced deletion.
const open = { dataDeletionAt: null, dataDeletedAt: null };

const withRole = (membership: Membership, key: BuiltInRoleKey): Membership => {
  const role = builtInReference(key);

  return { ...membership, role, permissions: PermissionSet.forRole(role) };
};

const owner: Membership = withRole(
  {
    id: '22222222-2222-4222-8222-222222222222',
    organizationId: organization.id,
    userId: '33333333-3333-4333-8333-333333333333',
  } as Membership,
  'owner',
);

const member: Membership = withRole(
  {
    ...owner,
    id: '44444444-4444-4444-8444-444444444444',
    userId: '55555555-5555-4555-8555-555555555555',
  },
  'member',
);

const dto = ({ id, organizationId, userId, role }: Membership) => ({
  id,
  organizationId,
  userId,
  role,
  status: 'active',
});

const origin = 'http://localhost:3001';

const headers = { origin, cookie: 'session=test' };

const base = `/v1/organizations/${organization.id}`;

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fixture() {
  const listMembers = vi
    .fn<IdentityTransaction['listMembers']>()
    .mockResolvedValue([owner, member]);
  const tx = {
    memberCommand: vi.fn<IdentityTransaction['memberCommand']>(),
    saveMemberCommand: vi.fn<IdentityTransaction['saveMemberCommand']>(),
    auditMember: vi.fn<IdentityTransaction['auditMember']>(),
    listOrganizations: vi.fn<IdentityTransaction['listOrganizations']>(),
    profile: vi
      .fn<IdentityTransaction['profile']>()
      .mockResolvedValue({ name: 'Owner', email: 'owner@example.test' }),
    createOrganization: vi.fn<IdentityTransaction['createOrganization']>(),
    findMembership: vi
      .fn<IdentityTransaction['findMembership']>()
      .mockResolvedValue(owner),
    accountErased: vi
      .fn<IdentityTransaction['accountErased']>()
      .mockResolvedValue(false),
    findOrganization: vi
      .fn<IdentityTransaction['findOrganization']>()
      .mockResolvedValue(organization),
    selectTenant: vi.fn<IdentityTransaction['selectTenant']>(),
    lockOrganization: vi.fn<IdentityTransaction['lockOrganization']>(),
    listMembers,
    suspendedMembers: vi
      .fn<IdentityTransaction['suspendedMembers']>()
      .mockImplementation(async (_organizationId, userIds) =>
        (await listMembers(organization.id))
          .filter(
            (item) =>
              item.status === 'suspended' && userIds.includes(item.userId),
          )
          .map((item) => item.userId),
      ),
    addMember: vi
      .fn<IdentityTransaction['addMember']>()
      .mockResolvedValue(member),
    updateMember: vi
      .fn<IdentityTransaction['updateMember']>()
      .mockResolvedValue(withRole(member, 'admin')),
    removeMember: vi.fn<IdentityTransaction['removeMember']>(),
    findRole: vi
      .fn<IdentityTransaction['findRole']>()
      .mockImplementation(async (_organizationId, roleId) => {
        const reference = builtInReference(roleId as BuiltInRoleKey);

        return {
          reference,
          permissions: PermissionSet.forRole(reference),
          archived: false,
        };
      }),
  };
  const getSession = vi
    .fn<IdentityRepository['getSession']>()
    .mockResolvedValue({
      userId: owner.userId,
      sessionId: '66666666-6666-4666-8666-666666666666',
    });
  const supportViews = {
    token: (credentials: Readonly<Record<string, string>>) =>
      /support=([A-Za-z0-9_-]{43})/.exec(credentials.cookie ?? '')?.[1] ?? null,
    cookie: (token: string | null) => `support=${token ?? ''}`,
    resolve: vi.fn<SupportViewCredentials['resolve']>().mockResolvedValue({
      state: 'active',
      id: viewId,
      tenantId: organization.id,
      userId: owner.userId,
      mode: 'consent',
      expiresAt: '2026-10-10T12:30:00.000Z',
    }),
    redeem: vi.fn<SupportViewCredentials['redeem']>(),
    end: vi.fn<SupportViewCredentials['end']>(),
    sweep: vi.fn<SupportViewCredentials['sweep']>(),
  } satisfies SupportViewCredentials;
  const regionForTenant = vi
    .fn<NonNullable<IdentityRepository['placement']>['regionForTenant']>()
    .mockResolvedValue('AU');
  const service = createIdentityService({
    placement: { regionForTenant },
    getSession,
    supportViews,
    listSecurityEvents: async () => [],
    setLanguage: async () => undefined,
    withUser: async (_userId, operation) => operation(tx),
  });
  const app = Fastify();
  apps.push(app);
  registerIdentityGuards(app, service, [origin]);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof IdentityError)
      return reply.status(error.statusCode).send({ code: error.code });
    throw error;
  });
  registerContractRoutes(app, apiContract.identity, identityRoutes(service));

  return { app, tx, getSession, service, supportViews, regionForTenant };
}

const viewId = '77777777-7777-4777-8777-777777777777';

const supportHeaders = {
  origin,
  cookie: `session=test; support=${'a'.repeat(43)}`,
};

it('resolves a support view as the viewed member, read-only, and records the read once allowed', async () => {
  const { app, getSession, supportViews } = fixture();
  const response = await app.inject({
    url: `${base}/context?ignored=1`,
    headers: supportHeaders,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    actor: { id: owner.userId, sessionId: viewId },
    supportView: { id: viewId, mode: 'consent' },
  });
  expect(getSession).not.toHaveBeenCalled();
  expect(supportViews.resolve.mock.calls).toEqual([
    ['a'.repeat(43), organization.id, null, expect.any(String)],
    ['a'.repeat(43), organization.id, `${base}/context`, expect.any(String)],
  ]);
});

it.each([
  {
    method: 'POST' as const,
    path: '/members',
    payload: { userId: member.userId, roleId: 'member' },
  },
  { method: 'PATCH' as const, path: `/members/${member.id}`, payload: {} },
  { method: 'DELETE' as const, path: `/members/${member.id}` },
])(
  'refuses $method in a support view before resolving access',
  async ({ method, path, ...body }) => {
    const { app, tx, supportViews } = fixture();
    const response = await app.inject({
      method,
      url: `${base}${path}`,
      headers: supportHeaders,
      ...body,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ code: 'READ_ONLY' });
    expect(supportViews.resolve).not.toHaveBeenCalled();
    expect(tx.lockOrganization).not.toHaveBeenCalled();
  },
);

it('does not record a read the viewed member may not make', async () => {
  const { app, tx, supportViews } = fixture();
  tx.findMembership.mockResolvedValue(member);
  supportViews.resolve.mockResolvedValue({
    state: 'active',
    id: viewId,
    tenantId: organization.id,
    userId: member.userId,
    mode: 'consent',
    expiresAt: '2026-10-10T12:30:00.000Z',
  });
  app.get(
    '/v1/organizations/:organizationId/restricted',
    { config: { access: { permission: 'members.manage' } } },
    async () => ({ ok: true }),
  );
  const response = await app.inject({
    url: `${base}/restricted`,
    headers: supportHeaders,
  });
  expect(response.statusCode).toBe(403);
  expect(supportViews.resolve).toHaveBeenCalledExactlyOnceWith(
    'a'.repeat(43),
    organization.id,
    null,
    expect.any(String),
  );
});

it('rejects an ended support view without falling back to the customer session', async () => {
  const { app, getSession, supportViews } = fixture();
  supportViews.resolve.mockResolvedValue({
    state: 'ended',
    reason: 'consent_revoked',
    tenantId: organization.id,
  });
  const response = await app.inject({
    url: `${base}/members`,
    headers: supportHeaders,
  });
  expect(response.statusCode).toBe(401);
  expect(getSession).not.toHaveBeenCalled();
});

it('refuses personal account routes and lists only the viewed workspace in a support view', async () => {
  const { app, tx } = fixture();
  tx.listOrganizations.mockResolvedValue([
    { ...organization, ...open, membershipStatus: 'active' },
    {
      ...organization,
      ...open,
      id: '88888888-8888-4888-8888-888888888888',
      membershipStatus: 'active',
    },
  ]);
  const security = await app.inject({
    url: '/v1/account/security-events',
    headers: supportHeaders,
  });
  expect(security.statusCode).toBe(403);
  expect(security.json()).toEqual({ code: 'READ_ONLY' });
  const create = await app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: supportHeaders,
    payload: { name: 'New', slug: 'new' },
  });
  expect(create.statusCode).toBe(403);
  const list = await app.inject({
    url: '/v1/organizations',
    headers: supportHeaders,
  });
  expect(list.statusCode).toBe(200);
  expect(list.json().items.map((item: { id: string }) => item.id)).toEqual([
    organization.id,
  ]);
});

it('ignores a support cookie for another workspace', async () => {
  const { app, supportViews } = fixture();
  supportViews.resolve.mockResolvedValue({
    state: 'other',
    tenantId: '88888888-8888-4888-8888-888888888888',
  });
  const response = await app.inject({
    url: `${base}/context`,
    headers: supportHeaders,
  });
  expect(response.statusCode).toBe(404);
});

it.each(['context', 'members'])(
  'resolves identity once for the %s read',
  async (resource) => {
    const { app, tx, getSession } = fixture();
    const response = await app.inject({ url: `${base}/${resource}`, headers });
    expect(response.statusCode).toBe(200);
    expect(getSession).toHaveBeenCalledExactlyOnceWith({
      cookie: headers.cookie,
    });
    expect(tx.findMembership).toHaveBeenCalledExactlyOnceWith(organization.id);
    expect(tx.findOrganization).toHaveBeenCalledExactlyOnceWith(
      organization.id,
    );
    if (resource === 'context') {
      expect(response.json()).toMatchObject({
        tenantId: organization.id,
        actor: { id: owner.userId, role: { id: 'owner', name: 'Owner' } },
        allAppPermissions: true,
      });
      expect(response.json().permissions).toContain('roles.manage');
      expect(tx.selectTenant).not.toHaveBeenCalled();
    } else {
      expect(response.json().items).toEqual([dto(owner), dto(member)]);
      expect(tx.selectTenant).toHaveBeenCalledExactlyOnceWith(organization.id);
      expect(tx.listMembers).toHaveBeenCalledExactlyOnceWith(organization.id);
    }
  },
);

it.each([
  {
    method: 'POST' as const,
    path: '/members',
    payload: { userId: member.userId, roleId: 'member' },
    status: 201,
  },
  {
    method: 'PATCH' as const,
    path: `/members/${member.id}`,
    payload: { roleId: 'admin' },
    status: 200,
  },
  { method: 'DELETE' as const, path: `/members/${member.id}`, status: 204 },
])(
  'authenticates once and rechecks membership after locking for $method',
  async ({ method, path, status, ...body }) => {
    const { app, tx, getSession } = fixture();
    tx.lockOrganization.mockImplementation(async () => {
      expect(tx.findMembership).toHaveBeenCalledTimes(1);
      expect(tx.findOrganization).toHaveBeenCalledTimes(1);
    });
    const response = await app.inject({
      method,
      url: `${base}${path}`,
      headers,
      ...body,
    });
    expect(response.statusCode).toBe(status);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(tx.selectTenant).toHaveBeenCalledExactlyOnceWith(organization.id);
    expect(tx.lockOrganization).toHaveBeenCalledExactlyOnceWith(
      organization.id,
    );
    expect(tx.findMembership).toHaveBeenCalledTimes(2);
    expect(tx.findOrganization).toHaveBeenCalledTimes(2);
  },
);

it.each(['revoked', 'demoted', 'suspended', 'member-suspended'] as const)(
  'rejects mutations when access is %s while waiting for the lock',
  async (change) => {
    const { app, tx } = fixture();
    tx.lockOrganization.mockImplementation(async () => {
      if (change === 'revoked') tx.findMembership.mockResolvedValue(null);
      if (change === 'demoted')
        tx.findMembership.mockResolvedValue(withRole(owner, 'member'));
      if (change === 'suspended')
        tx.findOrganization.mockResolvedValue({
          ...organization,
          status: 'suspended',
        });
      if (change === 'member-suspended')
        tx.findMembership.mockResolvedValue({ ...owner, status: 'suspended' });
    });
    const response = await app.inject({
      method: 'PATCH',
      url: `${base}/members/${member.id}`,
      headers,
      payload: { roleId: 'admin' },
    });
    expect(response.statusCode).toBe(
      change === 'demoted' || change === 'member-suspended' ? 403 : 404,
    );
    expect(tx.updateMember).not.toHaveBeenCalled();
  },
);

it('rejects a suspended member on the next request and lists the workspace as suspended', async () => {
  const { app, tx } = fixture();
  tx.findMembership.mockResolvedValue({ ...owner, status: 'suspended' });
  tx.listOrganizations.mockResolvedValue([
    { ...organization, ...open, membershipStatus: 'suspended' },
  ]);
  const response = await app.inject({ url: `${base}/context`, headers });
  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ code: 'ACCESS_SUSPENDED' });
  const list = await app.inject({ url: '/v1/organizations', headers });
  expect(list.json().items).toEqual([
    { ...organization, ...open, membershipStatus: 'suspended' },
  ]);
});

it('keeps the last active owner when another owner is suspended', async () => {
  const { app, tx, service } = fixture();
  const suspendedOwner: Membership = {
    ...owner,
    id: '99999999-9999-4999-8999-999999999999',
    userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    status: 'suspended',
  };
  tx.listMembers.mockResolvedValue([owner, suspendedOwner, member]);
  const demote = await app.inject({
    method: 'PATCH',
    url: `${base}/members/${owner.id}`,
    headers,
    payload: { roleId: 'admin' },
  });
  expect(demote.statusCode).toBe(409);
  expect(tx.updateMember).not.toHaveBeenCalled();
  // The suspended owner can be demoted; the active owner remains.
  const other = await app.inject({
    method: 'PATCH',
    url: `${base}/members/${suspendedOwner.id}`,
    headers,
    payload: { roleId: 'admin' },
  });
  expect(other.statusCode).toBe(200);
  const context = await service.resolveWorkflowContext(
    owner.userId,
    organization.id,
    'suspended-read',
  );
  expect(
    await service.suspendedMembers(context, [
      owner.userId,
      suspendedOwner.userId,
      'operator',
    ]),
  ).toEqual(new Set([suspendedOwner.userId]));
  expect(tx.suspendedMembers).toHaveBeenLastCalledWith(organization.id, [
    owner.userId,
    suspendedOwner.userId,
  ]);
});

it('rehydrates workflow identity from current membership without a serialized session', async () => {
  const { service, tx, getSession } = fixture();
  const context = await service.resolveWorkflowContext(
    owner.userId,
    organization.id,
    'workflow-request',
  );
  expect(context.actor.role.key).toBe('owner');
  expect(context.actor.sessionId).toBe('workflow:workflow-request');
  expect(getSession).not.toHaveBeenCalled();
  tx.findMembership.mockResolvedValue(withRole(owner, 'member'));
  const demoted = await service.resolveWorkflowContext(
    owner.userId,
    organization.id,
    'workflow-request',
  );
  expect(demoted.actor.role.key).toBe('member');
  expect(demoted.permissions.has('actions.execute')).toBe(false);
  tx.findMembership.mockResolvedValue(null);
  await expect(
    service.resolveWorkflowContext(
      owner.userId,
      organization.id,
      'workflow-request',
    ),
  ).rejects.toThrow('Organization not found');
});

it('denies routes for callers without the declared permission', async () => {
  const { app, tx } = fixture();
  tx.findMembership.mockResolvedValue(withRole(owner, 'member'));
  const response = await app.inject({
    method: 'PATCH',
    url: `${base}/members/${member.id}`,
    headers,
    payload: { roleId: 'admin' },
  });
  expect(response.statusCode).toBe(403);
  expect(tx.lockOrganization).not.toHaveBeenCalled();
});

it('keeps admins from granting ownership or changing owners', async () => {
  const { app, tx } = fixture();
  const admin = withRole(
    { ...owner, id: '77777777-7777-4777-8777-777777777777' },
    'admin',
  );
  tx.findMembership.mockResolvedValue(admin);
  tx.listMembers.mockResolvedValue([owner, admin, member]);
  for (const [path, roleId] of [
    [`/members/${member.id}`, 'owner'],
    [`/members/${owner.id}`, 'member'],
  ] as const) {
    const response = await app.inject({
      method: 'PATCH',
      url: `${base}${path}`,
      headers,
      payload: { roleId },
    });
    expect(response.statusCode).toBe(403);
  }
  expect(tx.updateMember).not.toHaveBeenCalled();
});

it('rejects assigning a custom role with permissions the actor lacks', async () => {
  const { app, tx } = fixture();
  const manager = {
    ...owner,
    role: {
      id: '88888888-8888-4888-8888-888888888888',
      key: 'custom' as const,
      name: 'Team lead',
      builtIn: false,
      revision: 2,
    },
    permissions: new PermissionSet(['members.manage', 'orders.read']),
  };
  tx.findMembership.mockResolvedValue(manager);
  tx.listMembers.mockResolvedValue([manager, member]);
  const response = await app.inject({
    method: 'PATCH',
    url: `${base}/members/${member.id}`,
    headers,
    payload: { roleId: 'admin' },
  });
  expect(response.statusCode).toBe(403);
  expect(tx.updateMember).not.toHaveBeenCalled();
});

it('rejects another cell before reading membership or workspace state', async () => {
  const { app, tx, regionForTenant } = fixture();
  regionForTenant.mockResolvedValue('EU');
  const response = await app.inject({ url: `${base}/context`, headers });
  expect(response.statusCode).toBe(503);
  expect(response.json()).toMatchObject({ code: 'REGION_UNAVAILABLE' });
  expect(tx.findMembership).not.toHaveBeenCalled();
  expect(tx.findOrganization).not.toHaveBeenCalled();
});

it('creates workspaces only in the cell and rejects a different or disabled choice', async () => {
  const { service, tx } = fixture();
  await expect(
    service.createOrganization(headers, {
      name: 'Workspace',
      slug: 'workspace',
      dataRegion: 'EU',
    }),
  ).rejects.toMatchObject({ statusCode: 422, code: 'REGION_UNAVAILABLE' });
  expect(tx.createOrganization).not.toHaveBeenCalled();
  tx.createOrganization.mockResolvedValue(organization);
  await service.createOrganization(headers, {
    name: 'Workspace',
    slug: 'workspace',
    dataRegion: 'AU',
  });
  expect(tx.createOrganization).toHaveBeenCalledWith({
    name: 'Workspace',
    slug: 'workspace',
    dataRegion: 'AU',
  });
});

it('serves the exact public region configuration route before authentication with no session', async () => {
  const { app, getSession } = fixture();
  const handler = vi.fn(async () => new Response('unused'));
  const regionConfig = {
    region: 'AU' as const,
    enabledRegions: ['AU' as const],
    regionalOrigins: { AU: 'https://au.app.example.test' },
  };
  registerAuthHandler(app, handler, origin, regionConfig);
  const response = await app.inject({ url: '/auth/region-config' });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(regionConfig);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['set-cookie']).toBeUndefined();
  expect(getSession).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
  expect((await app.inject({ url: '/auth/region-private' })).statusCode).toBe(
    404,
  );
});
