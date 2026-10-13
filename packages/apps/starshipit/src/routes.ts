import '@luma/identity/http';

import { createHash, timingSafeEqual } from 'node:crypto';

import type { AppFactoryContext } from '@luma/app-host';
import { ConnectorError, secretBinding } from '@luma/connections';
import { createInstallationRepository } from '@luma/connections/composition';
import { AdmissionRejected } from '@luma/execution';
import { IdentityError } from '@luma/identity';
import { canonicalJson } from '@luma/platform';
import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';

import { installationCredentials } from './infrastructure/installation-validation.js';
import { type createStarshipitUpdates, updatePermission } from './updates.js';

/** Registers governed private commands and authenticated refresh-only shipping wakeups. */
export function registerStarshipitRoutes(
  server: FastifyInstance,
  updates: ReturnType<typeof createStarshipitUpdates>,
  context: AppFactoryContext,
) {
  for (const command of [
    'inspect',
    'preview',
    'execute',
    'approve',
    'check',
  ] as const)
    server.post(
      `/v1/organizations/:organizationId/apps/starshipit/order-update-${command}`,
      { config: { access: { permission: updatePermission } } },
      async (request, reply) => {
        reply.header('cache-control', 'no-store');
        if (!request.tenantContext)
          throw new IdentityError(
            401,
            'UNAUTHENTICATED',
            'Sign in to continue.',
          );
        try {
          return await updates[command](request.tenantContext, request.body);
        } catch (error) {
          if (error instanceof ZodError)
            throw new IdentityError(
              422,
              'CONFLICT',
              'Select existing lines and whole nonnegative quantities.',
            );
          if (error instanceof AdmissionRejected)
            throw new IdentityError(
              409,
              'CONFLICT',
              'This correction is no longer eligible. Refresh and review it again.',
            );
          if (error instanceof ConnectorError)
            throw new IdentityError(
              503,
              'SERVICE_UNAVAILABLE',
              'Starshipit could not confirm the correction. Check its status before continuing.',
            );
          throw error;
        }
      },
    );
  server.post(
    '/v1/starshipit/changes/:organizationId/:connectionId',
    { config: { authentication: 'app' }, bodyLimit: 65536 },
    async (request, reply) => {
      const params = z
        .object({
          organizationId: z.string().uuid(),
          connectionId: z.string().uuid(),
        })
        .parse(request.params);
      const payload = z
        .object({
          order_id: z
            .union([z.number().int().positive(), z.string().min(1)])
            .optional(),
          order_number: z.string().max(512).optional(),
          last_updated_date: z.string().max(100).optional(),
          event_id: z.string().max(200).optional(),
        })
        .passthrough()
        .parse(request.body);
      const record = await createInstallationRepository(context.database).get(
        params.organizationId,
        params.connectionId,
      );
      if (
        !record?.secret ||
        record.connection.status !== 'active' ||
        record.connection.appId !== 'starshipit' ||
        record.connection.target.kind !== 'starshipit'
      )
        throw new IdentityError(
          401,
          'UNAUTHENTICATED',
          'Invalid shipping webhook.',
        );
      const credentials = installationCredentials.parse(
        context.cipher.open(record.secret, secretBinding(record.connection)),
      );
      const supplied = request.headers.authorization ?? '';
      const expected = credentials.webhookSecret
        ? `Bearer ${credentials.webhookSecret}`
        : '';
      if (
        !expected ||
        !timingSafeEqual(
          createHash('sha256').update(supplied).digest(),
          createHash('sha256').update(expected).digest(),
        )
      )
        throw new IdentityError(
          401,
          'UNAUTHENTICATED',
          'Invalid shipping webhook.',
        );
      if (
        !(await context.featureEnabled?.(
          params.organizationId,
          'starshipit-fulfillment',
        ))
      )
        return reply.code(202).send({ accepted: true });
      await context.database.transaction(params.organizationId, async (tx) => {
        // Recheck installation and connection while recording the wakeup; stale, duplicate and
        // reordered events never write canonical state or become evidence of dispatch.
        const current = (
          await tx.query<{ version: number }>(
            'SELECT version FROM workspace_apps WHERE tenant_id=$1 AND app_id=$2 AND status=$3 FOR SHARE',
            [params.organizationId, 'starshipit', 'installed'],
          )
        ).rows[0];
        if (current?.version !== record.connection.appInstallationVersion)
          throw new IdentityError(
            401,
            'UNAUTHENTICATED',
            'Invalid shipping webhook.',
          );
        await tx.query(
          "INSERT INTO connector_refresh_hints(tenant_id,connection_id,event_key,capabilities,reconcile) SELECT $1,$2,$3,$4,false FROM connector_installations WHERE tenant_id=$1 AND id=$2 AND version=$5 AND document->>'status'='active' ON CONFLICT DO NOTHING",
          [
            params.organizationId,
            params.connectionId,
            createHash('sha256').update(canonicalJson(payload)).digest('hex'),
            ['orders.read', 'fulfillment.read'],
            record.connection.version,
          ],
        );
      });

      return reply.code(202).send({ accepted: true });
    },
  );
}
