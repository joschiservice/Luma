import { randomUUID } from 'node:crypto';

import type { AtomicStore } from '@luma/platform';
import { Pool } from 'pg';

import { createApiAppsService } from './application/api-apps.js';
import { createIdentityService } from './application/identity.js';
import type { MailProvider } from './application/mail.js';
import type { MorningBriefSource } from './application/morning-brief.js';
import type { AppPermissionSource } from './application/roles.js';
import { createRolesService } from './application/roles.js';
import { createSettingsService } from './application/settings.js';
import type { DataRegion } from './domain/context.js';
import { eraseDueAccounts } from './infrastructure/account-deletion.js';
import {
  createApiAppReads,
  createApiAppsRepository,
  createApiCredentials,
  queueApiAppExpiryNotices,
} from './infrastructure/api-apps.js';
import { createApiToken } from './infrastructure/api-tokens.js';
import type { AuthSettings } from './infrastructure/auth.js';
import {
  createInvitationToken,
  hashInvitationToken,
} from './infrastructure/invitation-token.js';
import {
  type AwsRequestSigner,
  createResendMail,
  createSesMail,
} from './infrastructure/mail.js';
import { createMailDelivery } from './infrastructure/mail-delivery.js';
import { createMailEvents } from './infrastructure/mail-events.js';
import { createMorningBriefScheduler } from './infrastructure/morning-brief.js';
import { createRepository } from './infrastructure/repository.js';
import { createRolesRepository } from './infrastructure/roles.js';
import { purgeSecurityEvents } from './infrastructure/security-events.js';
import { createSettingsRepository } from './infrastructure/settings.js';
import { createWorkflowIdentityRepository } from './infrastructure/workflow-identity.js';

/**
 * Creates identity services, an authentication handler, and readiness checks. Errors from idle
 * pool clients, such as a database restart, go to `onDatabaseError` instead of crashing the
 * process. Throws when `mail` uses Amazon SES without `signAwsRequest`. Call close to release
 * the owned database pool.
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
    /** The configured mail provider: Resend, or Amazon SES in the cell's own AWS region. */
    mail?: { from: string; origin: string } & (
      | { provider: 'resend'; apiKey: string; webhookSecret?: string }
      | {
          provider: 'ses';
          region: string;
          credentials: { accessKeyId: string; secretAccessKey: string };
          configurationSet?: string;
        }
    );
    mailProvider?: MailProvider;
    mailOrigin?: string;
    morningBriefEnabled?: (tenantId: string) => Promise<boolean>;
    /** Reports whether the current request may only read, as in a support view. */
    readOnly?: () => boolean;
  },
  dependencies: {
    onDatabaseError: (error: Error) => void;
    /** Signs Amazon SES requests; required when `mail` uses SES. */
    signAwsRequest?: AwsRequestSigner;
  },
) {
  const mail = settings.mail;
  if (
    mail?.provider === 'ses' &&
    !settings.mailProvider &&
    !dependencies.signAwsRequest
  )
    throw new Error('Amazon SES mail needs an AWS request signer');
  const provider =
    settings.mailProvider ??
    (mail?.provider === 'resend'
      ? createResendMail(mail)
      : mail?.provider === 'ses' && dependencies.signAwsRequest
        ? createSesMail(mail, { sign: dependencies.signAwsRequest })
        : undefined);
  const pool = new Pool({
    connectionString: settings.databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    idle_in_transaction_session_timeout: 10000,
  });
  pool.on('error', dependencies.onDatabaseError);
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
  const service = createIdentityService(
    {
      ...repository,
      apiCredentials: createApiCredentials(pool, region, {
        enabled: settings.rateLimit?.enabled ?? true,
        ...(rateLimitStore ? { store: rateLimitStore } : {}),
      }),
    },
    { region, enabledRegions: settings.enabledRegions ?? [region] },
  );
  const apiApps = createApiAppsService({
    repository: createApiAppsRepository(pool, settings.readOnly),
    reads: createApiAppReads(pool),
    issue: () => createApiToken(region),
    id: randomUUID,
    now: () => new Date(),
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
    /** Personal API apps: tokens that act for one member within the permissions they chose. */
    apiApps,
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
    /** Records Resend delivery events; absent without Resend and its webhook secret. */
    mailEvents:
      settings.mail?.provider === 'resend' && settings.mail.webhookSecret
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
    /**
     * Queues a notice for each API app token that expires within a week and hasn't had one.
     * Safe to run repeatedly and concurrently.
     */
    queueApiAppExpiryNotices: () => queueApiAppExpiryNotices(pool),
    trustedOrigins: settings.trustedOrigins,
    regionConfig: {
      region,
      enabledRegions: settings.enabledRegions ?? [region],
      regionalOrigins: settings.regionalOrigins ?? {},
    },
    handler: auth.handler,
    baseURL: settings.baseURL,
    clientIpHeader: settings.clientIpHeader,
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

/**
 * Creates the identity service background workers use, on a pool opened with `databaseUrl`, a
 * login with `luma_workflow_identity`. It resolves workflow contexts and reads the selected
 * workspace's members without names or emails. It needs no auth secret and has no session,
 * support view, credential or member change access; those methods throw. Errors from idle pool
 * clients go to `onDatabaseError` instead of crashing the process. Call close to release the
 * owned database pool.
 */
export function createWorkflowIdentity(
  settings: {
    databaseUrl: string;
    region?: DataRegion;
    enabledRegions?: readonly DataRegion[];
  },
  dependencies: { onDatabaseError: (error: Error) => void },
) {
  const pool = new Pool({
    connectionString: settings.databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    idle_in_transaction_session_timeout: 10000,
  });
  pool.on('error', dependencies.onDatabaseError);
  const region = settings.region ?? 'AU';

  return {
    service: createIdentityService(createWorkflowIdentityRepository(pool), {
      region,
      enabledRegions: settings.enabledRegions ?? [region],
    }),
    async close() {
      await pool.end();
    },
  };
}

export { builtInMembership, makeTenantContext } from './domain/context.js';

export { createRoleIdentityReader } from './infrastructure/role-identities.js';

export { createDetectionSettingsReader } from './infrastructure/detection-settings.js';

export { createMorningBriefReader } from './application/morning-brief.js';
