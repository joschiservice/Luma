import { randomBytes } from 'node:crypto';

import type { AppFactoryContext } from '@luma/app-host';
import { secretBinding } from '@luma/connections';
import { createInstallationRepository } from '@luma/connections/composition';
import type { TenantContext } from '@luma/identity';
import { requireChangesAllowed } from '@luma/identity';
import { notFound, ServiceError } from '@luma/platform';
import { z } from 'zod';

import { installationCredentials } from './domain/installation-validation.js';

const request = z
  .object({
    connectionId: z.string().uuid(),
    version: z.number().int().positive(),
  })
  .strict();

/** Lifecycle event that records a generated webhook secret in workspace Activity. */
const webhookSecretGenerated = 'webhook_secret_generated';

/**
 * Generates refresh-wakeup bearer secrets for Starshipit connections. Luma never stores a
 * readable copy outside the encrypted connection credentials, so this is the only response
 * that contains a secret.
 */
export function createWebhookSecrets(
  context: Pick<
    AppFactoryContext,
    'database' | 'cipher' | 'refreshContext' | 'requirePermission'
  >,
  {
    repository = createInstallationRepository(context.database),
    now = () => new Date(),
  }: {
    repository?: ReturnType<typeof createInstallationRepository>;
    now?: () => Date;
  } = {},
) {
  return {
    /**
     * Replaces the connection's webhook secret with 32 random bytes and returns the wakeup path
     * and Authorization header once. The previous secret stops working immediately. Requires
     * current `connections.manage`, a writable session and the connection version the caller
     * reviewed; records a `webhook_secret_generated` lifecycle event without the secret. Rejects
     * disconnected or revoked connections (404) and stale versions (409).
     */
    async generate(tenant: TenantContext, body: unknown) {
      const fresh = await context.refreshContext(tenant);
      requireChangesAllowed(fresh);
      await context.requirePermission(fresh, {
        app: 'starshipit',
        permission: 'connections.manage',
      });
      const parsed = request.safeParse(body);
      if (!parsed.success)
        throw new ServiceError(422, 'CONFLICT', 'Select a connection.');
      const { connectionId, version } = parsed.data;
      const record = await repository.get(fresh.tenantId, connectionId);
      if (
        !record?.secret ||
        record.connection.status === 'disconnected' ||
        record.connection.status === 'revoked' ||
        record.connection.appId !== 'starshipit' ||
        record.connection.target.kind !== 'starshipit'
      )
        throw notFound('Connection not found.');
      if (record.connection.version !== version) throw conflict();
      const credentials = installationCredentials.parse(
        context.cipher.open(record.secret, secretBinding(record.connection)),
      );
      const secret = randomBytes(32).toString('base64url');
      // API keys are unchanged, so the credential version and its binding stay the same.
      const connection = {
        ...record.connection,
        version: version + 1,
        updatedAt: now().toISOString(),
      };
      const saved = await repository.save(
        {
          connection,
          secret: context.cipher.seal(
            { ...credentials, webhookSecret: secret },
            secretBinding(connection),
          ),
        },
        version,
        fresh.actor.id,
        webhookSecretGenerated,
      );
      if (!saved) throw conflict();

      return {
        version: connection.version,
        path: `/v1/starshipit/changes/${fresh.tenantId}/${connectionId}`,
        authorization: `Bearer ${secret}`,
      };
    },
  };
}

const conflict = () =>
  new ServiceError(409, 'CONFLICT', 'Connection changed; reload and retry.');
