import { apiContract } from '@luma/api-contract';
import { initServer } from '@ts-rest/fastify';
import type { FastifyRequest } from 'fastify';

import type { SettingsService } from '../application/settings.js';
import { IdentityError } from '../domain/context.js';
import { credentials } from './routes.js';

/** Routes workspace controls through fresh membership checks; invitations require a matching session. */
export function settingsRoutes(service?: SettingsService) {
  const use = () => {
    if (!service)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Settings are unavailable',
      );

    return service;
  };
  const context = (request: FastifyRequest) => {
    if (!request.tenantContext)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');

    return request.tenantContext;
  };

  return initServer().router(apiContract.settings, {
    receipt: async ({ request, params }) => ({
      status: 200,
      body: await use().receipt(context(request), params.commandId),
    }),
    get: async ({ request }) => ({
      status: 200,
      body: await use().get(context(request)),
    }),
    updateWorkspace: async ({ request, body }) => ({
      status: 200,
      body: await use().updateWorkspace(context(request), body),
    }),
    updateApprovals: async ({ request, body }) => ({
      status: 200,
      body: await use().updateApprovals(context(request), body),
    }),
    updateNotifications: async ({ request, body }) => ({
      status: 200,
      body: await use().updateNotifications(context(request), body),
    }),
    testEmail: async ({ request, body }) => ({
      status: 200,
      body: await use().testEmail(context(request), body),
    }),
    invitations: async ({ request }) => ({
      status: 200,
      body: { items: await use().invitations(context(request)) },
    }),
    invite: async ({ request, body }) => ({
      status: 200,
      body: await use().invite(context(request), body),
    }),
    changeInvitation: async ({ request, params, body }) => ({
      status: 200,
      body: await use().changeInvitation(
        context(request),
        params.invitationId,
        body,
      ),
    }),
    previewInvitation: async ({ request, body }) => ({
      status: 200,
      body: await use().previewInvitation(credentials(request), body),
    }),
    acceptInvitation: async ({ request, body }) => ({
      status: 200,
      body: await use().acceptInvitation(credentials(request), body),
    }),
  });
}
