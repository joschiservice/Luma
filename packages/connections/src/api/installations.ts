import '@luma/identity/http';

import { apiContract, installedConnectionSchema } from '@luma/api-contract';
import type { TenantContext } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { ServiceError, unavailable } from '@luma/platform';
import { implement } from '@orpc/server';
import type { FastifyRequest } from 'fastify';

import type { CoverageReader } from '../application/coverage.js';
import type { InstallationService } from '../application/installations.js';

type ConnectionManagement = Omit<
  InstallationService,
  'credential' | 'recordFailure'
>;

/**
 * Creates authenticated connection-management handlers; returns service unavailable when
 * management is not configured.
 */
export function connectionRoutes(
  service?: ConnectionManagement,
  internalOrdersEnabled: (
    context: TenantContext,
  ) => Promise<boolean> = async () => false,
  coverage?: CoverageReader,
) {
  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service) throw unavailable('Connection service is unavailable');

    return { service, context: request.tenantContext };
  }

  // Parse summaries before serialization so credentials can never become response fields.
  const summary = (value: unknown) => installedConnectionSchema.parse(value);

  const os = implement(apiContract.connections).$context<HttpContext>();

  return os.router({
    updateWriteMode: os.updateWriteMode.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const { service, context } = use(request);

        return summary(
          await service.updateWriteMode(
            context,
            params.connectionId,
            body.version,
            body.writeMode,
          ),
        );
      },
    ),
    rename: os.rename.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const { service, context } = use(request);

        return summary(
          await service.rename(
            context,
            params.connectionId,
            body.version,
            body.label,
          ),
        );
      },
    ),
    list: os.list.handler(async ({ context: { request } }) => {
      const { service, context } = use(request);

      const enabled = await internalOrdersEnabled(context);
      const health = new Map(
        ((await coverage?.(context, new Date().toISOString())) ?? []).map(
          (item) => [item.id, item],
        ),
      );

      return {
        items: (await service.list(context))
          .filter((connection) => connection.provider !== 'luma-erp' || enabled)
          .map((connection) => ({
            ...summary(connection),
            coverage: health.get(connection.id),
          })),
      };
    }),
    install: os.install.handler(
      async ({ context: { request }, input: { body } }) => {
        const { service, context } = use(request);

        return summary(await service.install(context, body));
      },
    ),
    check: os.check.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const { service, context } = use(request);

        return summary(
          await service.check(context, params.connectionId, body.version),
        );
      },
    ),
    rotate: os.rotate.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const { service, context } = use(request);

        return summary(
          await service.rotate(
            context,
            params.connectionId,
            body.version,
            body.credentials,
          ),
        );
      },
    ),
    disconnect: os.disconnect.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const { service, context } = use(request);

        return summary(
          await service.disconnect(context, params.connectionId, body.version),
        );
      },
    ),
  });
}
