import { apiContract, homeModuleIds } from '@luma/api-contract';
import { implement } from '@orpc/server';
import type { FastifyRequest } from 'fastify';

import type { SettingsService } from '../application/settings.js';
import { IdentityError } from '../domain/context.js';
import type { WorkspaceLayout } from '../domain/settings.js';
import type { HttpContext } from './contract-routes.js';
import { credentials } from './routes.js';

const knownModules = new Set<string>(homeModuleIds);

/** Drops Home modules that are no longer offered so older saved layouts still load. */
function currentLayout(layout: WorkspaceLayout) {
  return {
    ...layout,
    home:
      layout.home?.flatMap((module) =>
        knownModules.has(module.id)
          ? [{ ...module, id: module.id as (typeof homeModuleIds)[number] }]
          : [],
      ) ?? null,
  };
}

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

  const os = implement(apiContract.settings).$context<HttpContext>();

  return os.router({
    receipt: os.receipt.handler(
      async ({ context: { request }, input: { params } }) =>
        await use().receipt(context(request), params.commandId),
    ),
    get: os.get.handler(
      async ({ context: { request } }) => await use().get(context(request)),
    ),
    updateWorkspace: os.updateWorkspace.handler(
      async ({ context: { request }, input: { body } }) =>
        await use().updateWorkspace(context(request), body),
    ),
    updateApprovals: os.updateApprovals.handler(
      async ({ context: { request }, input: { body } }) =>
        await use().updateApprovals(context(request), body),
    ),
    updateNotifications: os.updateNotifications.handler(
      async ({ context: { request }, input: { body } }) =>
        await use().updateNotifications(context(request), body),
    ),
    layout: os.layout.handler(async ({ context: { request } }) =>
      currentLayout(await use().layout(context(request))),
    ),
    saveLayout: os.saveLayout.handler(
      async ({ context: { request }, input: { body } }) =>
        currentLayout(await use().saveLayout(context(request), body)),
    ),
    testEmail: os.testEmail.handler(
      async ({ context: { request }, input: { body } }) =>
        await use().testEmail(context(request), body),
    ),
    invitations: os.invitations.handler(async ({ context: { request } }) => ({
      items: await use().invitations(context(request)),
    })),
    invite: os.invite.handler(
      async ({ context: { request }, input: { body } }) =>
        await use().invite(context(request), body),
    ),
    changeInvitation: os.changeInvitation.handler(
      async ({ context: { request }, input: { params, body } }) =>
        await use().changeInvitation(
          context(request),
          params.invitationId,
          body,
        ),
    ),
    previewInvitation: os.previewInvitation.handler(
      async ({ context: { request }, input: { body } }) =>
        await use().previewInvitation(credentials(request), body),
    ),
    acceptInvitation: os.acceptInvitation.handler(
      async ({ context: { request }, input: { body } }) =>
        await use().acceptInvitation(credentials(request), body),
    ),
  });
}
