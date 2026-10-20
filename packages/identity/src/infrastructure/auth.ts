import { randomUUID } from 'node:crypto';

import { passkey } from '@better-auth/passkey';
import type { AtomicStore } from '@luma/platform';
import type {
  BetterAuthOptions,
  BetterAuthPlugin,
  DBAdapter,
} from 'better-auth';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import {
  APIError,
  type AuthMiddleware,
  createAuthEndpoint,
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
  sensitiveSessionMiddleware,
} from 'better-auth/api';
import { organization, twoFactor } from 'better-auth/plugins';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { DataRegion } from '../domain/context.js';
import { describeUserAgent } from '../domain/sessions.js';
import {
  authRateRules,
  clientAddressHeader,
} from '../domain/sign-in-protection.js';
import { requestLocale } from './locale.js';
import type { SecurityMail } from './password-mail.js';
import {
  emailVerificationSeconds,
  failTransactionsOnOutboxError,
  passwordMailLocale,
  queueSecurityMail,
  securityMailSchema,
} from './password-mail.js';
import { createRateLimitStorage } from './rate-limit.js';
import * as schema from './schema.js';

export interface AuthSettings {
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
  region?: DataRegion;
  enabledRegions?: DataRegion[];
  passkeyRpId?: string;
  regionalOrigins?: Partial<Record<DataRegion, string>>;
  /** Separates sessions for applications sharing a hostname. */
  cookiePrefix?: string;
  /** Reviewed server plugins, e.g. regional SSO/SCIM adapters. */
  plugins?: BetterAuthPlugin[];
  /**
   * Queues account recovery, email confirmation and security notices in the account mail
   * outbox, without network I/O in auth requests; set it only when a mail provider delivers
   * the outbox. Without it, passwords can't be reset and new addresses can't be confirmed.
   */
  passwordMail?: boolean;
  /**
   * Per-client limits on credential and mail endpoints; on unless `enabled` is false. Counters
   * live in `store` when given, so every instance shares them, and in process memory otherwise.
   */
  rateLimit?: { enabled?: boolean; store?: AtomicStore };
}

// Trusted devices and session-less code checks would let a second factor be skipped later.
function accountSecurityMiddleware(
  db: NodePgDatabase<typeof schema>,
  settings: AuthSettings,
): AuthMiddleware {
  return createAuthMiddleware(async (ctx) => {
    if (ctx.path === '/sign-up/email') {
      const region = settings.region ?? 'AU';
      if (
        ctx.body?.dataRegion !== region ||
        !(settings.enabledRegions ?? [region]).includes(region)
      )
        throw new APIError('UNPROCESSABLE_ENTITY', {
          code: 'REGION_UNAVAILABLE',
          message:
            'Confirm an available data region before creating your account.',
        });
    }
    if (ctx.path === '/change-password') {
      const session = await getAuthoritativeSessionFromCtx(ctx);
      if (session?.user.twoFactorEnabled) {
        // Password changes rotate sessions; rotation alone must not extend second-factor proof.
        const proof = await db.execute(
          sql`SELECT 1 FROM account_security_events WHERE user_id=${session.user.id} AND session_id=${session.session.id} AND outcome='succeeded' AND event_type IN ('sign-in.two-factor','sign-in.passkey','two-factor.enabled') AND created_at>now()-interval '15 minutes' LIMIT 1`,
        );
        if (
          !proof.rows.length ||
          Date.now() - new Date(session.session.createdAt).getTime() >=
            15 * 60_000
        )
          throw new APIError('FORBIDDEN', {
            code: 'SESSION_NOT_FRESH',
            message:
              'Sign out and sign in again before changing your password.',
          });
      }
    }
    if (!ctx.path.startsWith('/two-factor/verify-')) return;
    const body: unknown = ctx.body;
    if (
      body &&
      typeof body === 'object' &&
      (('trustDevice' in body && body.trustDevice !== undefined) ||
        ('disableSession' in body && body.disableSession !== undefined))
    )
      throw new APIError('BAD_REQUEST', {
        code: 'UNSUPPORTED_OPTION',
        message: 'This sign-in option is not supported.',
      });
  });
}

/**
 * Refuses every new session of a disabled account or of one whose email address isn't
 * confirmed: password, passkey and two-factor sign-ins fail with `ACCOUNT_DISABLED` or
 * `EMAIL_NOT_VERIFIED` after their credentials were checked. The disabled message names no
 * reason.
 */
function refuseUnavailableAccounts(db: NodePgDatabase<typeof schema>) {
  return async (session: { userId: string }) => {
    const account = (
      await db.execute<{ disabled: boolean; verified: boolean }>(
        sql`SELECT EXISTS(SELECT FROM account_disablements WHERE user_id=${session.userId}) AS disabled,
          COALESCE((SELECT email_verified FROM users WHERE id=${session.userId}),false) AS verified`,
      )
    ).rows[0];
    if (account?.disabled)
      throw new APIError('FORBIDDEN', {
        code: 'ACCOUNT_DISABLED',
        message:
          'This account is disabled. Contact your workspace owner or Luma support.',
      });
    if (!account?.verified)
      throw new APIError('FORBIDDEN', {
        code: 'EMAIL_NOT_VERIFIED',
        message:
          'Confirm your email address with the link Luma sent you before signing in.',
      });
  };
}

/**
 * Ends every session after a password reset. A reset proves control of the mailbox, so the
 * address becomes confirmed. If it wasn't confirmed before, someone else may have created the
 * account and added sign-in factors, so its passkeys and authenticator app are removed too.
 */
async function secureResetAccount(
  db: NodePgDatabase<typeof schema>,
  userId: string,
) {
  await db.transaction(async (tx) => {
    const account = (
      await tx.execute<{ email_verified: boolean }>(
        sql`SELECT email_verified FROM users WHERE id=${userId} FOR UPDATE`,
      )
    ).rows[0];
    if (account && !account.email_verified) {
      await tx.execute(sql`DELETE FROM passkeys WHERE user_id=${userId}`);
      await tx.execute(sql`DELETE FROM two_factors WHERE user_id=${userId}`);
      await tx.execute(
        sql`UPDATE users SET email_verified=true,two_factor_enabled=false,updated_at=now() WHERE id=${userId}`,
      );
    }
    await tx.execute(sql`DELETE FROM sessions WHERE user_id=${userId}`);
  });
}

/**
 * Records the language of the browser a person signs in with, so email sent later uses it. A
 * language picked in Luma replaces the stored one; a browser preference only fills an empty
 * one. Failing to record it never blocks sign-in.
 */
function recordLanguage(db: NodePgDatabase<typeof schema>) {
  return async (
    session: { userId: string },
    context: { headers?: Headers | undefined } | null,
  ) => {
    if (!context?.headers) return;
    const { locale, chosen } = requestLocale(context.headers);
    await db
      .execute(
        chosen
          ? sql`UPDATE users SET locale=${locale} WHERE id=${session.userId} AND locale IS DISTINCT FROM ${locale}`
          : sql`UPDATE users SET locale=${locale} WHERE id=${session.userId} AND locale IS NULL`,
      )
      .catch(() => undefined);
  };
}

// Factors are reached only through the auth bridge, so server callers need no plugin API types.
function factorPlugins(settings: AuthSettings): BetterAuthPlugin[] {
  return [
    twoFactor(),
    passkey({
      rpID: settings.passkeyRpId ?? new URL(settings.baseURL).hostname,
      origin: settings.trustedOrigins,
    }),
  ];
}

// Unlike credential registration, reading or ending one's sessions does not need a fresh sign-in.
// Sessions are addressed by ID; their tokens are bearer credentials and never reach the browser.
function accountSessionsPlugin(
  db: NodePgDatabase<typeof schema>,
): BetterAuthPlugin {
  return {
    id: 'luma-account-sessions',
    endpoints: {
      listSessions: createAuthEndpoint(
        '/list-sessions',
        {
          method: 'GET',
          use: [sensitiveSessionMiddleware],
        },
        async (ctx) => {
          const result = await db.execute<{
            id: string;
            created_at: string;
            last_active_at: string | null;
            ip_address: string | null;
            user_agent: string | null;
          }>(
            sql`SELECT id,created_at,last_active_at,ip_address,user_agent FROM sessions WHERE user_id=${ctx.context.session.user.id} AND expires_at>now() ORDER BY COALESCE(last_active_at,created_at) DESC,id`,
          );

          return ctx.json(
            result.rows.map((row) => ({
              id: row.id,
              current: row.id === ctx.context.session.session.id,
              lastActiveAt: new Date(
                row.last_active_at ?? row.created_at,
              ).toISOString(),
              ipAddress: row.ip_address,
              ...describeUserAgent(row.user_agent),
            })),
          );
        },
      ),
      /**
       * Ends one of the signed-in person's sessions by ID. IDs of other people's or expired
       * sessions get the same response and change nothing.
       */
      revokeSessionById: createAuthEndpoint(
        '/revoke-session-by-id',
        {
          method: 'POST',
          use: [sensitiveSessionMiddleware],
          requireHeaders: true,
        },
        async (ctx) => {
          const body: unknown = ctx.body;
          const sessionId =
            body && typeof body === 'object' && 'sessionId' in body
              ? body.sessionId
              : undefined;
          if (typeof sessionId !== 'string')
            throw new APIError('BAD_REQUEST', {
              code: 'INVALID_SESSION_ID',
              message: 'Choose a session to sign out.',
            });
          const result = await db.execute<{ token: string }>(
            sql`SELECT token FROM sessions WHERE id::text=${sessionId} AND user_id=${ctx.context.session.user.id}`,
          );
          const token = result.rows[0]?.token;
          if (token) await ctx.context.internalAdapter.deleteSession(token);

          return ctx.json({ status: true });
        },
      ),
    },
  };
}

/**
 * Configures email and password sign-in, authenticator-app two-factor authentication, passkeys
 * and organization support using the supplied database and trusted origins. Passkeys use the
 * explicitly configured relying-party ID and accept assertions only from trusted origins.
 * Disabled accounts and accounts without a confirmed email address get no new session. Rate
 * limits count requests per client address and path. `observers` run after every other plugin,
 * so their hooks see final responses.
 */
export function createAuth(
  db: NodePgDatabase<typeof schema>,
  settings: AuthSettings,
  provisionId?: string,
  observers: BetterAuthPlugin[] = [],
) {
  let adapter: DBAdapter | undefined;
  // Writes through the active auth transaction, so sign-up commits its confirmation link with
  // the account; see queueSecurityMail.
  const queueMail = async (
    mail: SecurityMail,
    request: Request | undefined,
  ) => {
    if (!adapter) throw new Error('The auth database is not initialized.');
    await queueSecurityMail(
      adapter,
      settings.secret,
      mail,
      passwordMailLocale(request),
    );
  };

  const rpId = settings.passkeyRpId ?? new URL(settings.baseURL).hostname;
  for (const origin of [settings.baseURL, ...settings.trustedOrigins]) {
    const host = new URL(origin).hostname;
    if (host !== rpId && !host.endsWith(`.${rpId}`))
      throw new Error(
        'Passkey relying-party ID must contain every trusted origin.',
      );
  }

  return betterAuth({
    secret: settings.secret,
    baseURL: settings.baseURL,
    basePath: '/auth',
    appName: 'Luma',
    trustedOrigins: settings.trustedOrigins,
    database: (options: BetterAuthOptions) =>
      (adapter = failTransactionsOnOutboxError(
        drizzleAdapter(db, { provider: 'pg', schema, transaction: true })(
          options,
        ),
      )),
    emailAndPassword: {
      enabled: true,
      // Sign-up creates no session; sign-in needs a confirmed address.
      requireEmailVerification: true,
      minPasswordLength: 12,
      resetPasswordTokenExpiresIn: 15 * 60,
      revokeSessionsOnPasswordReset: true,
      ...(settings.passwordMail
        ? {
            sendResetPassword: async ({ user, token }, request) =>
              queueMail({ kind: 'reset', userId: user.id, token }, request),
            onPasswordReset: async ({ user }, request) => {
              // Revocation must happen even if queuing the mandatory notice fails.
              await secureResetAccount(db, user.id);
              await queueMail({ kind: 'changed', userId: user.id }, request);
            },
          }
        : {}),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: false,
      // Confirming creates no session, so a second factor can't be skipped through the link.
      autoSignInAfterVerification: false,
      expiresIn: emailVerificationSeconds,
      ...(settings.passwordMail
        ? {
            // During sign-up this runs in the account's transaction: a failed write fails it.
            sendVerificationEmail: async ({ user, token }, request) =>
              queueMail({ kind: 'verify', userId: user.id, token }, request),
          }
        : {}),
    },
    rateLimit: {
      enabled: settings.rateLimit?.enabled ?? true,
      customStorage: createRateLimitStorage(settings.rateLimit?.store),
      customRules: authRateRules,
    },
    account: { accountLinking: { enabled: false } },
    user: {
      additionalFields: {
        dataRegion: { type: 'string', required: false, input: true },
        regionConfirmedAt: {
          type: 'date',
          required: false,
          input: false,
          defaultValue: () => new Date(),
        },
      },
    },
    session: {
      cookieCache: { enabled: false },
      // Session resolution advances this at a bounded rate; see sessionActivityDue.
      additionalFields: {
        lastActiveAt: {
          type: 'date',
          required: false,
          input: false,
          defaultValue: () => new Date(),
        },
      },
    },
    hooks: { before: accountSecurityMiddleware(db, settings) },
    databaseHooks: {
      session: {
        create: {
          before: refuseUnavailableAccounts(db),
          after: recordLanguage(db),
        },
      },
    },
    advanced: {
      useSecureCookies: new URL(settings.baseURL).protocol === 'https:',
      crossSubDomainCookies: { enabled: false },
      // The auth bridge sets this from the socket or the configured proxy header.
      ipAddress: { ipAddressHeaders: [clientAddressHeader] },
      ...(settings.cookiePrefix ? { cookiePrefix: settings.cookiePrefix } : {}),
      database: {
        generateId: ({ model }) =>
          model === 'organization' && provisionId ? provisionId : randomUUID(),
      },
    },
    plugins: [
      organization({
        schema: {
          organization: {
            additionalFields: {
              dataRegion: {
                type: 'string',
                required: true,
                defaultValue: settings.region ?? 'AU',
                input: false,
              },
              status: {
                type: 'string',
                required: true,
                defaultValue: 'active',
                input: false,
              },
            },
          },
        },
      }),
      ...factorPlugins(settings),
      accountSessionsPlugin(db),
      { id: 'luma-security-mail', schema: securityMailSchema },
      ...(settings.plugins ?? []),
      ...observers,
    ],
  });
}
