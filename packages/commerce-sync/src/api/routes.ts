import '@luma/identity/http';

import {
  apiContract,
  autoLinkPreviewSchema,
  autoLinkRuleSchema,
  autoLinkRulesSchema,
  identityDetailSchema,
  linkRequestSchema,
  syncConnectionCommandResultSchema,
  syncOverviewSchema,
  syncRecordListSchema,
  syncRunHistorySchema,
  syncStreamSchema,
} from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';
import type { FastifyRequest } from 'fastify';

import type { SyncService } from '../application/service.js';

/** Exposes sync status to members, and sync controls and link requests to people with `sync.manage`. */
export function syncRoutes(service?: SyncService) {
  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Data sync is unavailable. Try again later.',
      );

    return { context: request.tenantContext, service };
  }

  const os = implement(apiContract.sync).$context<HttpContext>();

  return os.router({
    autoLinkRules: os.autoLinkRules.handler(
      async ({ context: { request } }) => {
        const s = use(request);

        return autoLinkRulesSchema.parse(
          await s.service.autoLinkRules(s.context),
        );
      },
    ),
    previewAutoLinks: os.previewAutoLinks.handler(
      async ({ context: { request }, input: { body } }) => {
        const s = use(request);

        return autoLinkPreviewSchema.parse(
          await s.service.previewAutoLinks(s.context, body),
        );
      },
    ),
    saveAutoLinkRule: os.saveAutoLinkRule.handler(
      async ({ context: { request }, input: { body } }) => {
        const s = use(request);

        return autoLinkRuleSchema.parse(
          await s.service.saveAutoLinkRule(s.context, body),
        );
      },
    ),
    overview: os.overview.handler(async ({ context: { request } }) => {
      const s = use(request);

      return syncOverviewSchema.parse(await s.service.overview(s.context));
    }),
    runs: os.runs.handler(
      async ({ context: { request }, input: { params, query } }) => {
        const s = use(request);

        return syncRunHistorySchema.parse(
          await s.service.runs(s.context, params.streamId, query.before),
        );
      },
    ),
    records: os.records.handler(
      async ({ context: { request }, input: { params, query } }) => {
        const s = use(request);

        return syncRecordListSchema.parse(
          await s.service.records(
            s.context,
            params.streamId,
            query.state,
            query.cursor,
          ),
        );
      },
    ),
    connectionCommand: os.connectionCommand.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return syncConnectionCommandResultSchema.parse(
          await s.service.commandConnection(
            s.context,
            params.connectionId,
            body.command,
          ),
        );
      },
    ),
    command: os.command.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return syncStreamSchema.parse(
          await s.service.command(s.context, params.streamId, body.command),
        );
      },
    ),
    identity: os.identity.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return identityDetailSchema.parse(
          await s.service.identity(s.context, params.kind, params.entityId),
        );
      },
    ),
    requestLink: os.requestLink.handler(
      async ({ context: { request }, input: { body } }) => {
        const s = use(request);

        return linkRequestSchema.parse(
          await s.service.requestLink(s.context, body),
        );
      },
    ),
    linkRequest: os.linkRequest.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return linkRequestSchema.parse(
          await s.service.linkRequest(s.context, params.requestId),
        );
      },
    ),
  });
}
