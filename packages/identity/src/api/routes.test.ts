import { apiContract } from '@luma/api-contract';
import { initServer } from '@ts-rest/fastify';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';

import type {
  IdentityRepository,
  IdentityTransaction,
} from '../application/identity.js';
import { createIdentityService } from '../application/identity.js';
import type { Membership, Organization } from '../domain/context.js';
import { IdentityError } from '../domain/context.js';
import type { BuiltInRoleKey } from '../domain/roles.js';
import { builtInReference, PermissionSet } from '../domain/roles.js';
import { identityRoutes, registerIdentityGuards } from './routes.js';

const organization: Organization = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Organization',
  slug: 'organization',
  status: 'active',
  dataRegion: 'EU',
};

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
});

const origin = 'http://localhost:3001';

const headers = { origin, cookie: 'session=test' };

const base = `/v1/organizations/${organization.id}`;

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fixture() {
  const tx = {
    memberCommand: vi.fn<IdentityTransaction['memberCommand']>(),
    saveMemberCommand: vi.fn<IdentityTransaction['saveMemberCommand']>(),
    auditMember: vi.fn<IdentityTransaction['auditMember']>(),
    listOrganizations: vi.fn<IdentityTransaction['listOrganizations']>(),
    createOrganization: vi.fn<IdentityTransaction['createOrganization']>(),
    findMembership: vi
      .fn<IdentityTransaction['findMembership']>()
      .mockResolvedValue(owner),
    findOrganization: vi
      .fn<IdentityTransaction['findOrganization']>()
      .mockResolvedValue(organization),
    selectTenant: vi.fn<IdentityTransaction['selectTenant']>(),
    lockOrganization: vi.fn<IdentityTransaction['lockOrganization']>(),
    listMembers: vi
      .fn<IdentityTransaction['listMembers']>()
      .mockResolvedValue([owner, member]),
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
  const service = createIdentityService({
    getSession,
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
  app.register(async (router) => {
    initServer().registerRouter(
      apiContract.identity,
      identityRoutes(service),
      router,
    );
  });

  return { app, tx, getSession, service };
}

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

it.each(['revoked', 'demoted', 'suspended'] as const)(
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
    });
    const response = await app.inject({
      method: 'PATCH',
      url: `${base}/members/${member.id}`,
      headers,
      payload: { roleId: 'admin' },
    });
    expect(response.statusCode).toBe(change === 'demoted' ? 403 : 404);
    expect(tx.updateMember).not.toHaveBeenCalled();
  },
);

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
