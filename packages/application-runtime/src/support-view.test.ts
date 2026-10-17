import { randomUUID } from 'node:crypto';

import { apiContract, contractRoutes } from '@luma/api-contract';
import { buildApp } from '@luma/application-runtime';
import type { IdentityService } from '@luma/identity';
import { builtInMembership, makeTenantContext } from '@luma/identity';
import { requestIsReadOnly } from '@luma/identity/http';
import { ServiceError } from '@luma/platform';
import { afterEach, expect, it, vi } from 'vitest';

const origin = 'http://localhost:3000';
const supportCookie = `luma.support_view=${'s'.repeat(43)}`;
const viewId = randomUUID();

// Routes support views reach without a workspace write: their own lifecycle and reads with a body.
const supportViewRoutes = new Set([
  'identity.supportView',
  'identity.redeemSupportView',
  'identity.endSupportView',
]);

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function supportApp() {
  const resolveTenant = vi.fn<IdentityService['resolveTenant']>(
    async (credentials, tenantId, requestId, options) => {
      const support =
        options?.supportView && credentials.cookie?.includes(supportCookie);
      if (!support && !credentials.cookie?.includes('session='))
        throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');

      return makeTenantContext(
        { userId: 'member', sessionId: support ? viewId : 'session' },
        {
          id: tenantId,
          name: 'Workspace',
          slug: 'workspace',
          dataRegion: 'AU',
          status: 'active',
        },
        builtInMembership(
          { id: 'membership', organizationId: tenantId, userId: 'member' },
          'owner',
        ),
        requestId,
        support
          ? {
              id: viewId,
              mode: 'consent',
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }
          : undefined,
      );
    },
  );
  const fail = () => {
    throw new Error('A support view reached an account operation.');
  };
  const identity: IdentityService = {
    resolveWorkflowContext: vi.fn(),
    refreshContext: vi.fn(async (context) => context),
    authenticate: vi.fn(fail),
    listSecurityEvents: vi.fn(fail),
    supportInspections: vi.fn(fail),
    decideSupportInspection: vi.fn(fail),
    revokeSupportInspection: vi.fn(fail),
    setLanguage: vi.fn(fail),
    listOrganizations: vi.fn(),
    createOrganization: vi.fn(fail),
    listMembers: vi.fn(),
    suspendedMembers: vi.fn(),
    changeMember: vi.fn(fail),
    provisionMember: vi.fn(fail),
    hasSupportView: (credentials) =>
      credentials.cookie?.includes(supportCookie) ?? false,
    supportView: vi.fn(),
    redeemSupportView: vi.fn(),
    endSupportView: vi.fn(),
    sweepSupportViews: vi.fn(),
    resolveTenant,
  };
  const app = buildApp({}, { identity, trustedOrigins: [origin] });
  apps.push(app);

  return { app, resolveTenant };
}

it('refuses every contract route that is not a read in a support view, before resolving access', async () => {
  const { app, resolveTenant } = supportApp();
  const writes = contractRoutes(apiContract).filter(
    (route) =>
      !['GET', 'HEAD'].includes(route.method) &&
      !route.meta.readOnly &&
      !supportViewRoutes.has(route.key),
  );
  expect(writes.length).toBeGreaterThan(80);
  const accepted: string[] = [];
  for (const route of writes) {
    const response = await app.inject({
      method: route.method as 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      url: route.path.replace(/\{\w+\}/g, () => randomUUID()),
      headers: { origin, cookie: `session=customer; ${supportCookie}` },
      payload: {},
    });
    if (response.statusCode !== 403 || response.json().code !== 'READ_ONLY')
      accepted.push(`${route.key} ${route.method} ${route.path}`);
  }
  expect(accepted).toEqual([]);
  expect(resolveTenant).not.toHaveBeenCalled();
});

it('lists every route with a request body that support views may call', () => {
  expect(
    contractRoutes(apiContract)
      .filter((route) => route.meta.readOnly)
      .map((route) => route.key)
      .sort(),
  ).toEqual([
    'adaptiveActions.preview',
    'adaptiveFields.readMany',
    'adaptivePackages.preview',
    'adaptiveViews.preview',
    'metrics.operationalQuery',
    'metrics.query',
    'metrics.summary',
    'nativeStock.verifyPurchaseReceipt',
    'procurement.incomingStock',
    'stockProtection.view',
  ]);
});

it('restricts handlers of allowed reads to read-only database transactions', async () => {
  const { app } = supportApp();
  const seen: Record<string, boolean> = {};
  app.get(
    '/v1/organizations/:organizationId/test-read',
    { config: { access: { access: 'member' } } },
    async () => {
      seen.get = requestIsReadOnly();

      return {};
    },
  );
  app.post(
    '/v1/organizations/:organizationId/test-query',
    { config: { access: { access: 'member' }, readOnly: true } },
    async () => {
      // Body parsing runs between the request hook and the handler; the scope must survive it.
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen.post = requestIsReadOnly();

      return {};
    },
  );
  const base = `/v1/organizations/${randomUUID()}`;
  const support = { origin, cookie: supportCookie };
  expect(
    (await app.inject({ url: `${base}/test-read`, headers: support }))
      .statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `${base}/test-query`,
        headers: support,
        payload: { query: 'x'.repeat(10_000) },
      })
    ).statusCode,
  ).toBe(200);
  expect(seen).toEqual({ get: true, post: true });
  await app.inject({
    url: `${base}/test-read`,
    headers: { origin, cookie: 'session=customer' },
  });
  expect(seen.get).toBe(false);
});
