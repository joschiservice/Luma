import { staffContract } from '@luma/api-contract/staff';
import type { HttpContext } from '@luma/identity/http';
import { registerContractRoutes } from '@luma/identity/http';
import { implement } from '@orpc/server';
import { APIError } from 'better-auth/api';
import type { FastifyInstance } from 'fastify';

import type { StaffRuntime } from '../application/staff.js';
import type { StaffContext, StaffPermission } from '../domain/access.js';
import { requireStaffPermission, StaffError } from '../domain/access.js';

declare module 'fastify' {
  interface FastifyRequest {
    staffContext?: StaffContext;
    staffUser?: { id: string; name: string; email: string };
  }
}
const protectedRoutes = new Set([
  'GET /v1/staff/session',
  'GET /v1/staff/directory',
  'GET /v1/staff/workspaces/:workspaceId/placement',
  'POST /v1/staff/workspaces/:workspaceId/access-requests',
  'GET /v1/staff/workspaces/:workspaceId/access-requests/latest',
  'POST /v1/staff/workspaces/:workspaceId/access',
  'GET /v1/staff/workspaces/:workspaceId',
  'POST /v1/staff/workspaces/:workspaceId/users/:userId/revoke-sessions',
  'POST /v1/staff/workspaces/:workspaceId/users/:userId/suspend-membership',
  'POST /v1/staff/workspaces/:workspaceId/users/:userId/reactivate-membership',
  'POST /v1/staff/workspaces/:workspaceId/users/:userId/support-view',
  'POST /v1/staff/workspaces/:workspaceId/support-access-requests',
  'GET /v1/staff/workspaces/:workspaceId/health',
  'GET /v1/staff/workspaces/:workspaceId/access-history',
  'GET /v1/staff/audit',
  'POST /v1/staff/accounts/:userId/access-requests',
  'GET /v1/staff/accounts/:userId/access-requests/latest',
  'POST /v1/staff/accounts/:userId/access',
  'GET /v1/staff/accounts/:userId',
  'GET /v1/staff/accounts/:userId/security-events',
  'POST /v1/staff/accounts/:userId/disable',
  'POST /v1/staff/accounts/:userId/enable',
  'POST /v1/staff/accounts/:userId/deletion',
  'POST /v1/staff/accounts/:userId/restore',
  'POST /v1/staff/accounts/:userId/erasure',
]);
const routePermissions: Record<string, StaffPermission[]> = {
  'GET /v1/staff/session': [],
  'GET /v1/staff/directory': ['staff.directory.read'],
  'GET /v1/staff/workspaces/:workspaceId/placement': ['staff.directory.read'],
  'POST /v1/staff/workspaces/:workspaceId/access-requests': [
    'staff.workspace.inspect',
    'staff.directory.read',
  ],
  'GET /v1/staff/workspaces/:workspaceId/access-requests/latest': [
    'staff.workspace.inspect',
  ],
  // Emergency access additionally needs `staff.inspect.emergency`, checked by the service.
  'POST /v1/staff/workspaces/:workspaceId/access': [
    'staff.workspace.inspect',
    'staff.directory.read',
  ],
  'GET /v1/staff/workspaces/:workspaceId': ['staff.workspace.inspect'],
  'POST /v1/staff/workspaces/:workspaceId/users/:userId/revoke-sessions': [
    'staff.workspace.inspect',
    'staff.sessions.revoke',
  ],
  'POST /v1/staff/workspaces/:workspaceId/users/:userId/suspend-membership': [
    'staff.workspace.inspect',
    'staff.memberships.manage',
  ],
  'POST /v1/staff/workspaces/:workspaceId/users/:userId/reactivate-membership':
    ['staff.workspace.inspect', 'staff.memberships.manage'],
  // The service requires `staff.view-as` or the emergency permission, by mode.
  'POST /v1/staff/workspaces/:workspaceId/users/:userId/support-view': [
    'staff.workspace.inspect',
  ],
  'POST /v1/staff/workspaces/:workspaceId/support-access-requests': [
    'staff.workspace.inspect',
    'staff.view-as',
  ],
  'GET /v1/staff/workspaces/:workspaceId/health': ['staff.workspace.inspect'],
  'GET /v1/staff/workspaces/:workspaceId/access-history': [
    'staff.workspace.inspect',
  ],
  'GET /v1/staff/audit': ['staff.audit.read'],
  'POST /v1/staff/accounts/:userId/access-requests': [
    'staff.accounts.inspect',
    'staff.directory.read',
  ],
  'GET /v1/staff/accounts/:userId/access-requests/latest': [
    'staff.accounts.inspect',
  ],
  // Emergency access additionally needs `staff.inspect.emergency`, checked by the service.
  'POST /v1/staff/accounts/:userId/access': [
    'staff.accounts.inspect',
    'staff.directory.read',
  ],
  'GET /v1/staff/accounts/:userId': ['staff.accounts.inspect'],
  'GET /v1/staff/accounts/:userId/security-events': ['staff.accounts.inspect'],
  'POST /v1/staff/accounts/:userId/disable': [
    'staff.accounts.inspect',
    'staff.accounts.manage',
  ],
  'POST /v1/staff/accounts/:userId/enable': [
    'staff.accounts.inspect',
    'staff.accounts.manage',
  ],
  'POST /v1/staff/accounts/:userId/deletion': [
    'staff.accounts.inspect',
    'staff.accounts.delete',
  ],
  'POST /v1/staff/accounts/:userId/restore': [
    'staff.accounts.inspect',
    'staff.accounts.delete',
  ],
  'POST /v1/staff/accounts/:userId/erasure': [
    'staff.accounts.inspect',
    'staff.accounts.delete',
  ],
};
const publicRoutes = new Set([
  'GET /health',
  'GET /ready',
  'GET /v1/staff/config',
  'GET /auth/*',
  'POST /auth/*',
]);

function retryAfter(headers: Headers) {
  const value = headers.get('retry-after') ?? headers.get('x-retry-after');

  return value && /^[0-9]{1,5}$/.test(value) ? value : '60';
}

function context(value: StaffContext | undefined): StaffContext {
  if (!value) throw new StaffError(401, 'Staff sign-in required.');

  return value;
}

function headersFrom(headers: Record<string, string | string[] | undefined>) {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers))
    if (value !== undefined)
      result.set(name, Array.isArray(value) ? value.join(', ') : value);

  return result;
}

/** Registers a deny-by-default staff-only HTTP surface and an explicitly restricted auth bridge. */
export function registerStaffHttp(app: FastifyInstance, staff: StaffRuntime) {
  app.addHook('onRequest', async (request, reply) => {
    reply
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('X-Frame-Options', 'DENY');
    const route = `${request.method} ${request.routeOptions.url}`;
    if (!publicRoutes.has(route) && !protectedRoutes.has(route))
      throw new StaffError(404, 'Route not found.');
    if (
      request.method !== 'GET' &&
      request.method !== 'HEAD' &&
      request.headers.origin !== staff.settings.publicOrigin
    )
      throw new StaffError(403, 'Staff origin required.');
    if (protectedRoutes.has(route)) {
      const session = await staff.resolveSession(
        headersFrom(request.headers),
        request.id,
      );
      for (const permission of routePermissions[route] ?? [])
        requireStaffPermission(session.context, permission);
      request.staffContext = session.context;
      request.staffUser = session.user;
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof APIError && error.statusCode === 429)
      return reply
        .status(429)
        .header('Retry-After', retryAfter(new Headers(error.headers)))
        .send({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many sign-in attempts. Try again shortly.',
          requestId: request.id,
        });
    if (error instanceof StaffError)
      return reply.status(error.status).send({
        code:
          error.status === 400
            ? 'VALIDATION_ERROR'
            : error.status === 401
              ? 'UNAUTHENTICATED'
              : error.status === 403
                ? 'FORBIDDEN'
                : error.status === 404
                  ? 'NOT_FOUND'
                  : error.status === 409
                    ? 'CONFLICT'
                    : 'SERVICE_UNAVAILABLE',
        message: error.message,
        requestId: request.id,
      });
    if (
      error &&
      typeof error === 'object' &&
      'statusCode' in error &&
      error.statusCode === 400
    )
      return reply.status(400).send({
        code: 'VALIDATION_ERROR',
        message: 'Invalid request.',
        requestId: request.id,
      });
    app.log.error({ requestId: request.id }, 'Staff request failed');

    return reply.status(503).send({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Staff service unavailable.',
      requestId: request.id,
    });
  });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_request, reply) => {
    const ready = await staff.checkReadiness();

    return reply
      .status(ready ? 200 : 503)
      .send({ status: ready ? 'ready' : 'unavailable' });
  });
  app.route({
    method: ['GET', 'POST'],
    url: '/auth/*',
    async handler(request, reply) {
      const incoming = new URL(request.url, staff.settings.publicOrigin);
      const path = incoming.pathname.slice('/auth'.length);
      const allowed =
        staff.settings.mode === 'local'
          ? new Set(['POST /sign-in/email', 'POST /sign-out'])
          : new Set([
              'POST /sign-in/social',
              'GET /callback/google',
              'POST /sign-out',
            ]);
      if (!allowed.has(`${request.method} ${path}`))
        throw new StaffError(404, 'Route not found.');
      if (path === '/sign-in/social') {
        const body = request.body;
        if (
          !body ||
          typeof body !== 'object' ||
          !('provider' in body) ||
          body.provider !== 'google' ||
          Object.keys(body).some(
            (key) =>
              !['provider', 'callbackURL', 'errorCallbackURL'].includes(key),
          )
        )
          throw new StaffError(403, 'Unsupported staff sign-in request.');
        for (const key of ['callbackURL', 'errorCallbackURL']) {
          if (key in body) {
            const value = Reflect.get(body, key);
            if (
              typeof value !== 'string' ||
              new URL(value, staff.settings.publicOrigin).origin !==
                staff.settings.publicOrigin
            )
              throw new StaffError(403, 'Staff callback origin required.');
          }
        }
      }
      const regionalOrigin =
        staff.settings.regionalApiOrigins?.[staff.settings.region ?? 'AU'];
      const url = regionalOrigin
        ? new URL(request.url, regionalOrigin)
        : new URL('/api' + request.url, staff.settings.publicOrigin);
      const authHeaders = headersFrom(request.headers);
      authHeaders.set('x-luma-staff-request-id', request.id);
      authHeaders.set('x-luma-staff-client-ip', request.ip);
      authHeaders.delete('x-forwarded-for');
      authHeaders.delete('forwarded');
      authHeaders.delete('x-real-ip');
      const response = await staff.authHandler(
        new Request(url, {
          method: request.method,
          headers: authHeaders,
          ...(request.body !== undefined
            ? { body: JSON.stringify(request.body) }
            : {}),
        }),
      );
      reply.status(response.status);
      response.headers.forEach((value, key) => {
        if (
          ![
            'set-cookie',
            'cache-control',
            'content-type',
            'content-length',
            'x-retry-after',
          ].includes(key)
        )
          reply.header(key, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header('set-cookie', cookies);

      if (path !== '/callback/google' || response.status >= 400)
        reply.type('application/json');
      if (response.status === 429)
        return reply.header('Retry-After', retryAfter(response.headers)).send({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many sign-in attempts. Try again shortly.',
          requestId: request.id,
        });
      if (response.status >= 400)
        return reply.send({ message: 'Staff sign-in failed.' });
      if (path === '/sign-in/email' || path === '/sign-out')
        return reply.send({ success: true });
      if (path === '/sign-in/social') {
        const payload: unknown = await response.json();
        if (
          !payload ||
          typeof payload !== 'object' ||
          !('url' in payload) ||
          typeof payload.url !== 'string' ||
          new URL(payload.url).protocol !== 'https:' ||
          new URL(payload.url).hostname !== 'accounts.google.com'
        )
          throw new StaffError(503, 'Identity provider unavailable.');

        return reply.send({ url: payload.url, redirect: true });
      }

      return reply.send('');
    },
  });
  const os = implement(staffContract).$context<HttpContext>();
  const router = os.router({
    config: os.config.handler(async () => ({
      regionalDirectoryEnabled: await staff.regionalDirectoryEnabled(),
      region: staff.settings.region ?? 'AU',
      regionalApiOrigins: staff.settings.regionalApiOrigins ?? {},
      mode: staff.settings.mode,
      providerId: staff.settings.mode === 'google' ? ('google' as const) : null,
    })),
    session: os.session.handler(async ({ context: { request } }) => {
      const staffContext = context(request.staffContext);
      if (!request.staffUser)
        throw new StaffError(401, 'Staff sign-in required.');

      return {
        user: request.staffUser,
        permissions: staffContext.permissions,
      };
    }),
    workspacePlacement: os.workspacePlacement.handler(
      async ({ context: { request }, input: { params } }) =>
        staff.service.workspacePlacement(
          context(request.staffContext),
          params.workspaceId,
        ),
    ),
    directory: os.directory.handler(
      async ({ context: { request }, input: { query } }) =>
        await staff.service.directory(
          context(request.staffContext),
          query.query,
        ),
    ),
    requestAccess: os.requestAccess.handler(
      async ({ context: { request }, input: { params, body } }) =>
        await staff.service.requestAccess(
          context(request.staffContext),
          params.workspaceId,
          body.reason,
        ),
    ),
    accessRequest: os.accessRequest.handler(
      async ({ context: { request }, input: { params } }) => ({
        request: await staff.service.accessRequest(
          context(request.staffContext),
          params.workspaceId,
        ),
      }),
    ),
    grantAccess: os.grantAccess.handler(
      async ({ context: { request }, input: { params, body } }) =>
        await staff.service.grant(
          context(request.staffContext),
          params.workspaceId,
          body,
        ),
    ),
    workspace: os.workspace.handler(
      async ({ context: { request }, input: { params, query } }) =>
        await staff.service.workspace(
          context(request.staffContext),
          params.workspaceId,
          query.grantId,
        ),
    ),
    revokeSessions: os.revokeSessions.handler(
      async ({ context: { request }, input: { params, body } }) =>
        await staff.service.revoke(context(request.staffContext), {
          ...params,
          ...body,
        }),
    ),
    suspendMembership: os.suspendMembership.handler(
      async ({ context: { request }, input: { params, body } }) =>
        await staff.service.changeMembership(context(request.staffContext), {
          ...params,
          ...body,
          action: 'suspend',
        }),
    ),
    reactivateMembership: os.reactivateMembership.handler(
      async ({ context: { request }, input: { params, body } }) =>
        await staff.service.changeMembership(context(request.staffContext), {
          ...params,
          ...body,
          action: 'reactivate',
          acknowledgeLastOwner: false,
        }),
    ),
    startSupportView: os.startSupportView.handler(
      async ({ context: { request }, input: { params, body } }) =>
        await staff.service.startSupportView(context(request.staffContext), {
          ...params,
          ...body,
        }),
    ),
    requestSupportAccess: os.requestSupportAccess.handler(
      async ({ context: { request }, input: { params, body } }) =>
        await staff.service.requestSupportAccess(
          context(request.staffContext),
          { ...params, ...body },
        ),
    ),
    health: os.health.handler(
      async ({ context: { request }, input: { params, query } }) =>
        await staff.service.health(
          context(request.staffContext),
          params.workspaceId,
          query.grantId,
        ),
    ),
    accessHistory: os.accessHistory.handler(
      async ({ context: { request }, input: { params, query } }) =>
        await staff.service.accessHistory(
          context(request.staffContext),
          params.workspaceId,
          query.grantId,
          query.cursor ?? null,
        ),
    ),
    audit: os.audit.handler(
      async ({ context: { request }, input: { query } }) =>
        await staff.service.audit(context(request.staffContext), query),
    ),
    requestAccountAccess: os.requestAccountAccess.handler(
      async ({ context: { request }, input: { params, body } }) =>
        await staff.service.requestAccountAccess(
          context(request.staffContext),
          params.userId,
          body.reason,
        ),
    ),
    accountAccessRequest: os.accountAccessRequest.handler(
      async ({ context: { request }, input: { params } }) => ({
        request: await staff.service.accountAccessRequest(
          context(request.staffContext),
          params.userId,
        ),
      }),
    ),
    grantAccountAccess: os.grantAccountAccess.handler(
      async ({ context: { request }, input: { params, body } }) =>
        await staff.service.accountGrant(
          context(request.staffContext),
          params.userId,
          body,
        ),
    ),
    account: os.account.handler(
      async ({ context: { request }, input: { params, query } }) =>
        await staff.service.account(
          context(request.staffContext),
          params.userId,
          query.grantId,
        ),
    ),
    accountSecurityEvents: os.accountSecurityEvents.handler(
      async ({ context: { request }, input: { params, query } }) =>
        await staff.service.accountSecurityEvents(
          context(request.staffContext),
          params.userId,
          query.grantId,
          query.cursor,
        ),
    ),
    disableAccount: os.disableAccount.handler(
      async ({ context: { request }, input: { params, body } }) =>
        await staff.service.changeAccount(context(request.staffContext), {
          ...params,
          ...body,
          action: 'disable',
        }),
    ),
    enableAccount: os.enableAccount.handler(
      async ({ context: { request }, input: { params, body } }) =>
        await staff.service.changeAccount(context(request.staffContext), {
          ...params,
          ...body,
          action: 'enable',
        }),
    ),
    scheduleAccountDeletion: os.scheduleAccountDeletion.handler(
      async ({ context: { request }, input: { params, body } }) =>
        await staff.service.changeAccountDeletion(
          context(request.staffContext),
          { ...params, ...body, action: 'schedule' },
        ),
    ),
    restoreAccount: os.restoreAccount.handler(
      async ({ context: { request }, input: { params, body } }) =>
        await staff.service.changeAccountDeletion(
          context(request.staffContext),
          { ...params, ...body, action: 'restore' },
        ),
    ),
    eraseAccountNow: os.eraseAccountNow.handler(
      async ({ context: { request }, input: { params, body } }) =>
        await staff.service.changeAccountDeletion(
          context(request.staffContext),
          { ...params, ...body, action: 'erase_now' },
        ),
    ),
  });
  registerContractRoutes(app, staffContract, router);
}
