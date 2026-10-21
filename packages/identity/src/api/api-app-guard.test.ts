import { apiContract } from '@luma/api-contract';
import { RateLimitedError, ServiceError } from '@luma/platform';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';

import type { ApiCredential, ApiCredentials } from '../application/api-apps.js';
import type { IdentityTransaction } from '../application/identity.js';
import { createIdentityService } from '../application/identity.js';
import type { Membership, Organization } from '../domain/context.js';
import type { BuiltInRoleKey } from '../domain/roles.js';
import { builtInReference, PermissionSet } from '../domain/roles.js';
import { apiAppsRoutes } from './api-apps.js';
import { registerContractRoutes } from './contract-routes.js';
import { identityRoutes, registerIdentityGuards } from './routes.js';

const organization: Organization = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Organization',
  slug: 'organization',
  status: 'active',
  dataRegion: 'AU',
};
const otherOrganization = '99999999-9999-4999-8999-999999999999';
const base = `/v1/organizations/${organization.id}`;
const token = `luma_au_${'a'.repeat(43)}00000000`;
const bearer = { authorization: `Bearer ${token}` };

const membership = (key: BuiltInRoleKey): Membership => {
  const role = builtInReference(key);

  return {
    id: '22222222-2222-4222-8222-222222222222',
    organizationId: organization.id,
    userId: '33333333-3333-4333-8333-333333333333',
    role,
    status: 'active',
    permissions: PermissionSet.forRole(role),
  };
};

const credential: ApiCredential = {
  id: '44444444-4444-4444-8444-444444444444',
  tenantId: organization.id,
  appId: '55555555-5555-4555-8555-555555555555',
  userId: membership('owner').userId,
  scopes: ['orders.read', 'customers.read'],
  status: 'active',
};

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fixture() {
  const findMembership = vi
    .fn<IdentityTransaction['findMembership']>()
    .mockResolvedValue(membership('owner'));
  const tx = {
    findMembership,
    accountErased: vi.fn().mockResolvedValue(false),
    findOrganization: vi.fn().mockResolvedValue(organization),
  } as Partial<IdentityTransaction> as IdentityTransaction;
  const apiCredentials = {
    resolve: vi
      .fn<ApiCredentials['resolve']>()
      .mockResolvedValue({ state: 'found', credential }),
    find: vi.fn<ApiCredentials['find']>().mockResolvedValue(credential),
    admit: vi.fn<ApiCredentials['admit']>().mockResolvedValue(null),
  };
  const getSession = vi.fn().mockResolvedValue(null);
  const service = createIdentityService({
    placement: { regionForTenant: async () => 'AU' },
    getSession,
    supportViews: {
      token: () => null,
      cookie: () => '',
      resolve: vi.fn(),
      redeem: vi.fn(),
      end: vi.fn(),
      sweep: vi.fn(),
    },
    accountInspections: {
      list: async () => [],
      decide: async () => 'conflict',
      revoke: async () => 'conflict',
    },
    listSecurityEvents: async () => [],
    setLanguage: async () => undefined,
    withUser: async (_userId, operation) => operation(tx),
    apiCredentials,
  });
  const app = Fastify();
  apps.push(app);
  registerIdentityGuards(app, service, ['http://localhost:3001']);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RateLimitedError)
      reply.header('retry-after', String(error.retryAfterSeconds));
    if (error instanceof ServiceError)
      return reply
        .status(error.statusCode)
        .send({ code: error.code, message: error.message });
    throw error;
  });
  registerContractRoutes(app, apiContract.identity, identityRoutes(service));
  registerContractRoutes(app, apiContract.apiApps, apiAppsRoutes());
  app.post(
    '/v1/organizations/:organizationId/probe',
    { config: { publicApi: true, access: { permission: 'orders.read' } } },
    async (request) => ({
      permissions: [...request.tenantContext!.permissions],
      apiApp: request.tenantContext!.apiApp,
    }),
  );
  app.get(
    '/v1/organizations/:organizationId/manage',
    { config: { publicApi: true, access: { permission: 'members.manage' } } },
    async () => ({ ok: true }),
  );

  return { app, apiCredentials, findMembership, getSession, service };
}

it('acts for the member with the app’s scopes, without an Origin header', async () => {
  const { app, apiCredentials, getSession } = fixture();
  const response = await app.inject({
    method: 'POST',
    url: `${base}/probe`,
    headers: bearer,
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    permissions: ['customers.read', 'orders.read'],
    apiApp: {
      id: credential.appId,
      credentialId: credential.id,
      scopes: credential.scopes,
    },
  });
  expect(apiCredentials.resolve).toHaveBeenCalledWith(token);
  expect(apiCredentials.admit).toHaveBeenCalledWith(
    organization.id,
    credential.id,
  );
  expect(getSession).not.toHaveBeenCalled();
});

it('reports the narrowed context on the public context route', async () => {
  const { app } = fixture();
  const response = await app.inject({
    url: `${base}/context`,
    headers: bearer,
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    actor: {
      id: credential.userId,
      sessionId: credential.id,
    },
    permissions: ['customers.read', 'orders.read'],
    allAppPermissions: false,
    apiApp: { id: credential.appId, scopes: credential.scopes },
  });
});

it('drops scopes the member’s role no longer grants', async () => {
  const { app, findMembership } = fixture();
  const limited = membership('member');
  findMembership.mockResolvedValue({
    ...limited,
    permissions: new PermissionSet(['customers.read']),
  });
  const response = await app.inject({
    method: 'POST',
    url: `${base}/probe`,
    headers: bearer,
  });

  expect(response.statusCode).toBe(403);
  expect(response.json().message).toContain('This API app');
});

it('refuses permissions outside the app’s scopes even when the member holds them', async () => {
  const { app } = fixture();
  const response = await app.inject({
    url: `${base}/manage`,
    headers: bearer,
  });

  expect(response.statusCode).toBe(403);
});

it.each([
  { name: 'a session-only workspace route', url: `${base}/members` },
  { name: 'an account route', url: '/v1/organizations' },
  { name: 'API app management', url: `${base}/api-apps` },
])('refuses $name before resolving the token', async ({ url }) => {
  const { app, apiCredentials } = fixture();
  const response = await app.inject({ url, headers: bearer });

  expect(response.statusCode).toBe(403);
  expect(apiCredentials.resolve).not.toHaveBeenCalled();
});

it('refuses a token sent together with cookies', async () => {
  const { app, apiCredentials } = fixture();
  const response = await app.inject({
    url: `${base}/context`,
    headers: { ...bearer, cookie: 'session=test' },
  });

  expect(response.statusCode).toBe(401);
  expect(apiCredentials.resolve).not.toHaveBeenCalled();
});

it.each([
  { name: 'another authorization scheme', authorization: `Basic ${token}` },
  { name: 'a bearer token of another service', authorization: 'Bearer abc' },
])('ignores $name, as before API apps', async ({ authorization }) => {
  const { app, apiCredentials, getSession } = fixture();
  const response = await app.inject({
    url: `${base}/context`,
    headers: { authorization },
  });

  expect(response.statusCode).toBe(401);
  expect(getSession).toHaveBeenCalled();
  expect(apiCredentials.resolve).not.toHaveBeenCalled();
});

it.each([
  { state: 'expired' as const, status: 401 },
  { state: 'revoked' as const, status: 401 },
])('refuses an $state credential', async ({ state, status }) => {
  const { app, apiCredentials } = fixture();
  apiCredentials.resolve.mockResolvedValue({
    state: 'found',
    credential: { ...credential, status: state },
  });
  const response = await app.inject({
    url: `${base}/context`,
    headers: bearer,
  });

  expect(response.statusCode).toBe(status);
  expect(apiCredentials.admit).not.toHaveBeenCalled();
});

it('refuses unknown tokens and names the region of another cell’s token', async () => {
  const { app, apiCredentials } = fixture();
  apiCredentials.resolve.mockResolvedValueOnce({ state: 'invalid' });
  expect(
    (await app.inject({ url: `${base}/context`, headers: bearer })).statusCode,
  ).toBe(401);
  apiCredentials.resolve.mockResolvedValueOnce({ state: 'other_cell' });
  const response = await app.inject({
    url: `${base}/context`,
    headers: bearer,
  });

  expect(response.statusCode).toBe(503);
  expect(response.json().code).toBe('REGION_UNAVAILABLE');
});

it('hides other workspaces from a token', async () => {
  const { app, findMembership } = fixture();
  const response = await app.inject({
    url: `/v1/organizations/${otherOrganization}/context`,
    headers: bearer,
  });

  expect(response.statusCode).toBe(404);
  expect(findMembership).not.toHaveBeenCalled();
});

it('refuses a token whose member was suspended', async () => {
  const { app, findMembership } = fixture();
  findMembership.mockResolvedValue({
    ...membership('owner'),
    status: 'suspended',
  });
  const response = await app.inject({
    url: `${base}/context`,
    headers: bearer,
  });

  expect(response.statusCode).toBe(403);
  expect(response.json().code).toBe('ACCESS_SUSPENDED');
});

it('reports the tighter rate limit on every token response', async () => {
  const { app, apiCredentials } = fixture();
  apiCredentials.admit.mockResolvedValue({
    limit: 600,
    remaining: 598,
    reset: 41,
  });
  const response = await app.inject({
    url: `${base}/context`,
    headers: bearer,
  });

  expect(response.statusCode).toBe(200);
  expect(response.headers).toMatchObject({
    'ratelimit-limit': '600',
    'ratelimit-remaining': '598',
    'ratelimit-reset': '41',
  });
});

it('answers 429 with Retry-After when a limit is exhausted', async () => {
  const { app, apiCredentials } = fixture();
  apiCredentials.admit.mockResolvedValue({
    limit: 600,
    remaining: -1,
    reset: 17,
  });
  const response = await app.inject({
    url: `${base}/context`,
    headers: bearer,
  });

  expect(response.statusCode).toBe(429);
  expect(response.headers['retry-after']).toBe('17');
});

it('keeps the narrowing when a context is refreshed, and stops after revocation', async () => {
  const { service, apiCredentials } = fixture();
  const { context } = await service.resolveApiApp(token, organization.id, 'r1');
  const fresh = await service.refreshContext(context);

  expect([...fresh.permissions]).toEqual(['customers.read', 'orders.read']);
  expect(fresh.apiApp?.credentialId).toBe(credential.id);
  apiCredentials.find.mockResolvedValue({ ...credential, status: 'revoked' });
  await expect(service.refreshContext(context)).rejects.toMatchObject({
    statusCode: 401,
  });
});
