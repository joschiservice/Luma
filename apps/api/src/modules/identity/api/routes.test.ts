import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { initServer } from '@ts-rest/fastify';
import { apiContract } from '@luma/api-contract';
import { afterEach, expect, it, vi } from 'vitest';
import { createIdentityService } from '../application/identity.js';
import type {
  IdentityRepository,
  IdentityTransaction,
} from '../application/identity.js';
import type { Membership, Organization } from '../domain/context.js';
import { IdentityError } from '../domain/context.js';
import { identityRoutes, registerIdentityGuards } from './routes.js';

const organization: Organization = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Organization',
  slug: 'organization',
  status: 'active',
  dataRegion: 'EU',
};
const owner: Membership = {
  id: '22222222-2222-4222-8222-222222222222',
  organizationId: organization.id,
  userId: '33333333-3333-4333-8333-333333333333',
  role: 'owner',
};
const member: Membership = {
  ...owner,
  id: '44444444-4444-4444-8444-444444444444',
  userId: '55555555-5555-4555-8555-555555555555',
  role: 'member',
};
const origin = 'http://localhost:3001';
const headers = { origin, cookie: 'session=test' };
const base = `/v1/organizations/${organization.id}`;
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fixture() {
  const tx = {
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
      .mockResolvedValue({ ...member, role: 'admin' }),
    removeMember: vi.fn<IdentityTransaction['removeMember']>(),
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
        actor: { id: owner.userId, role: 'owner' },
      });
      expect(tx.selectTenant).not.toHaveBeenCalled();
    } else {
      expect(response.json().items).toEqual([owner, member]);
      expect(tx.selectTenant).toHaveBeenCalledExactlyOnceWith(organization.id);
      expect(tx.listMembers).toHaveBeenCalledExactlyOnceWith(organization.id);
    }
  },
);

it.each([
  {
    method: 'POST' as const,
    path: '/members',
    payload: { userId: member.userId, role: 'member' },
    status: 201,
  },
  {
    method: 'PATCH' as const,
    path: `/members/${member.id}`,
    payload: { role: 'admin' },
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
        tx.findMembership.mockResolvedValue({ ...owner, role: 'member' });
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
      payload: { role: 'admin' },
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
  expect(context.actor.role).toBe('owner');
  expect(context.actor.sessionId).toBe('workflow:workflow-request');
  expect(getSession).not.toHaveBeenCalled();
  tx.findMembership.mockResolvedValue({ ...owner, role: 'member' });
  expect(
    (
      await service.resolveWorkflowContext(
        owner.userId,
        organization.id,
        'workflow-request',
      )
    ).actor.role,
  ).toBe('member');
  tx.findMembership.mockResolvedValue(null);
  await expect(
    service.resolveWorkflowContext(
      owner.userId,
      organization.id,
      'workflow-request',
    ),
  ).rejects.toThrow('Organization not found');
});
