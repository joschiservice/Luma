import { createHash, createHmac, randomUUID } from 'node:crypto';

import { Pool } from 'pg';

import { createIdentityService } from './application/identity.js';
import type { MailProvider } from './application/mail.js';
import type { AppPermissionSource } from './application/roles.js';
import { createRolesService } from './application/roles.js';
import { createSettingsService } from './application/settings.js';
import { eraseDueAccounts } from './infrastructure/account-deletion.js';
import type { AuthSettings } from './infrastructure/auth.js';
import { createResendMail } from './infrastructure/mail.js';
import { createMailDelivery } from './infrastructure/mail-delivery.js';
import { createRepository } from './infrastructure/repository.js';
import { createRolesRepository } from './infrastructure/roles.js';
import { purgeSecurityEvents } from './infrastructure/security-events.js';
import { createSettingsRepository } from './infrastructure/settings.js';

/**
 * Creates identity services, an authentication handler, and readiness checks. Call close to
 * release the owned database pool.
 */
export function createIdentity(
  settings: AuthSettings & {
    databaseUrl: string;
    mail?: { apiKey: string; from: string; origin: string };
    mailProvider?: MailProvider;
    mailOrigin?: string;
    /** Reports whether the current request may only read, as in a support view. */
    readOnly?: () => boolean;
  },
) {
  const pool = new Pool({
    connectionString: settings.databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    idle_in_transaction_session_timeout: 10000,
  });
  const { repository, auth } = createRepository(pool, settings);

  const service = createIdentityService(repository);
  const provider =
    settings.mailProvider ??
    (settings.mail ? createResendMail(settings.mail) : undefined);
  const token = (tenantId: string, id: string, generation: number) =>
    createHmac('sha256', settings.secret)
      .update(`invitation:${tenantId}:${id}:${generation}`)
      .digest('hex');
  const workspaceSettings = createSettingsService({
    repository: createSettingsRepository(pool, !!provider, settings.readOnly),
    identity: service,
    deliveryAvailable: !!provider,
    now: () => new Date(),
    id: randomUUID,
    token,
    hash: (value) => createHash('sha256').update(value).digest('hex'),
  });
  const mailDelivery = createMailDelivery(
    pool,
    provider,
    settings.mail?.origin ?? settings.mailOrigin ?? settings.baseURL,
    token,
  );

  return {
    service,
    settings: workspaceSettings,
    /** Creates the roles service; app permissions come from the workspace app host. */
    roles: (appPermissions: AppPermissionSource = async () => []) =>
      createRolesService({
        repository: createRolesRepository(pool),
        appPermissions,
        id: randomUUID,
        now: () => new Date(),
      }),
    mailDelivery,
    /**
     * Applies security event retention as of `now`: clears IP addresses and user agents after
     * 90 days and deletes events after a year. Safe to run repeatedly and concurrently.
     */
    purgeSecurityEvents: (now: Date = new Date()) =>
      purgeSecurityEvents(pool, now),
    /**
     * Erases accounts whose deletion is due, after their completion notice when mail is
     * configured. Safe to run repeatedly and concurrently; an interrupted erasure is repeated.
     */
    eraseDueAccounts: () => eraseDueAccounts(pool, !!provider),
    trustedOrigins: settings.trustedOrigins,
    handler: auth.handler,
    baseURL: settings.baseURL,
    /** Registers an idle database connection error handler without coupling identity to HTTP. */
    onDatabaseError(handler: () => void) {
      pool.on('error', handler);
    },
    async checkReadiness() {
      const result = await pool.query<{ safe: boolean }>(`SELECT
        NOT r.rolsuper AND NOT r.rolbypassrls
        AND pg_has_role(current_user, 'luma_identity', 'MEMBER')
        AND NOT EXISTS (SELECT FROM pg_class c WHERE c.oid IN ('users'::regclass, 'organizations'::regclass, 'memberships'::regclass) AND pg_has_role(current_user, c.relowner, 'MEMBER')) AS safe
        FROM pg_roles r WHERE r.rolname = current_user`);
      await pool.query('SELECT id FROM sessions LIMIT 0');

      return result.rows[0]?.safe === true;
    },
    async close() {
      await pool.end();
    },
  };
}

export { builtInMembership, makeTenantContext } from './domain/context.js';
