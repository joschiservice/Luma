import { randomUUID } from 'node:crypto';

import type { AtomicStore } from '@luma/platform';
import { Pool } from 'pg';

import { createIdentityService } from './application/identity.js';
import type { MailProvider } from './application/mail.js';
import type { MorningBriefSource } from './application/morning-brief.js';
import type { AppPermissionSource } from './application/roles.js';
import { createRolesService } from './application/roles.js';
import { createSettingsService } from './application/settings.js';
import { eraseDueAccounts } from './infrastructure/account-deletion.js';
import type { AuthSettings } from './infrastructure/auth.js';
import {
  createInvitationToken,
  hashInvitationToken,
} from './infrastructure/invitation-token.js';
import { createResendMail } from './infrastructure/mail.js';
import { createMailDelivery } from './infrastructure/mail-delivery.js';
import { createMailEvents } from './infrastructure/mail-events.js';
import { createMorningBriefScheduler } from './infrastructure/morning-brief.js';
import { createRepository } from './infrastructure/repository.js';
import { createRolesRepository } from './infrastructure/roles.js';
import { purgeSecurityEvents } from './infrastructure/security-events.js';
import { createSettingsRepository } from './infrastructure/settings.js';

/**
 * Creates identity services, an authentication handler, and readiness checks. Call close to
 * release the owned database pool.
 */
export function createIdentity(
  settings: Omit<AuthSettings, 'rateLimit'> & {
    /**
     * Per-client limits on credential and mail endpoints; on unless `enabled` is false. `store`
     * is the configured shared counter location; the HTTP composition opens it and passes it as
     * `rateLimitStore`. Without that, each process counts in memory.
     */
    rateLimit?: {
      enabled?: boolean;
      store?: { url: string; cluster: boolean };
    };
    /** Shared Valkey counters for rate limits; the caller owns and closes it. */
    rateLimitStore?: AtomicStore;
    /** Header in which the proxy in front of the API sets the client address. */
    clientIpHeader?: string;
    databaseUrl: string;
    mail?: {
      apiKey: string;
      from: string;
      origin: string;
      webhookSecret?: string;
    };
    mailProvider?: MailProvider;
    mailOrigin?: string;
    morningBriefEnabled?: (tenantId: string) => Promise<boolean>;
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
  const provider =
    settings.mailProvider ??
    (settings.mail ? createResendMail(settings.mail) : undefined);
  const rateLimitStore = settings.rateLimitStore;
  const { repository, auth } = createRepository(pool, {
    ...settings,
    rateLimit: {
      enabled: settings.rateLimit?.enabled ?? true,
      ...(rateLimitStore ? { store: rateLimitStore } : {}),
    },
    passwordMail: !!provider,
  });
  const region = settings.region ?? 'AU';
  const service = createIdentityService(repository, {
    region,
    enabledRegions: settings.enabledRegions ?? [region],
  });
  const invitationToken = createInvitationToken(settings.secret);
  const workspaceSettings = createSettingsService({
    repository: createSettingsRepository(pool, !!provider, settings.readOnly),
    identity: service,
    deliveryAvailable: !!provider,
    ...(settings.morningBriefEnabled
      ? { morningBriefEnabled: settings.morningBriefEnabled }
      : {}),
    now: () => new Date(),
    id: randomUUID,
    token: invitationToken,
    hash: hashInvitationToken,
  });
  const mailOrigin =
    settings.mail?.origin ?? settings.mailOrigin ?? settings.baseURL;
  const mailDelivery = createMailDelivery(
    pool,
    provider,
    mailOrigin,
    settings.secret,
    invitationToken,
    settings.morningBriefEnabled,
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
    /** Composes the daily schedule with the existing authorized operational readers. */
    morningBriefScheduler: (source: MorningBriefSource) => {
      const schedule = createMorningBriefScheduler(pool, source);

      return (now?: Date) => (provider ? schedule(now) : Promise.resolve());
    },
    /** Records Resend delivery events; absent without a webhook secret. */
    mailEvents: settings.mail?.webhookSecret
      ? createMailEvents(pool, {
          apiKey: settings.mail.apiKey,
          webhookSecret: settings.mail.webhookSecret,
        })
      : undefined,
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
    regionConfig: {
      region,
      enabledRegions: settings.enabledRegions ?? [region],
      regionalOrigins: settings.regionalOrigins ?? {},
    },
    handler: auth.handler,
    baseURL: settings.baseURL,
    clientIpHeader: settings.clientIpHeader,
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

      const cell = await pool.query<{ region: string }>(
        'SELECT region FROM luma_cell_region',
      );

      return (
        result.rows[0]?.safe === true &&
        cell.rows.length === 1 &&
        cell.rows[0]?.region === region
      );
    },
    async close() {
      await pool.end();
    },
  };
}

export { builtInMembership, makeTenantContext } from './domain/context.js';

export { createRoleIdentityReader } from './infrastructure/role-identities.js';

export { createDetectionSettingsReader } from './infrastructure/detection-settings.js';

export { createMorningBriefReader } from './application/morning-brief.js';
