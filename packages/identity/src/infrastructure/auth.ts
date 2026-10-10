import { randomUUID } from 'node:crypto';

import { passkey } from '@better-auth/passkey';
import type { BetterAuthPlugin } from 'better-auth';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
  sensitiveSessionMiddleware,
} from 'better-auth/api';
import { organization, twoFactor } from 'better-auth/plugins';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { describeUserAgent } from '../domain/sessions.js';
import { passwordMailLocale } from './password-mail.js';
import * as schema from './schema.js';

export interface AuthSettings {
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
  /** Separates sessions for applications sharing a hostname. */
  cookiePrefix?: string;
  /** Reviewed server plugins, e.g. regional SSO/SCIM adapters. */
  plugins?: BetterAuthPlugin[];
  /** Queues account recovery and security notices without network I/O in auth requests. */
  passwordMail?: {
    reset(userId: string, token: string, locale: 'en' | 'de'): Promise<void>;
    changed(userId: string, locale: 'en' | 'de'): Promise<void>;
  };
}

// Trusted devices and session-less code checks would let a second factor be skipped later.
function accountSecurityMiddleware(db: NodePgDatabase<typeof schema>) {
  return createAuthMiddleware(async (ctx) => {
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
 * Refuses every new session of a disabled account: password, passkey and two-factor sign-ins
 * fail with `ACCOUNT_DISABLED` after their credentials were checked. The message names no reason.
 */
function refuseDisabledAccounts(db: NodePgDatabase<typeof schema>) {
  return async (session: { userId: string }) => {
    const disabled = await db.execute(
      sql`SELECT 1 FROM account_disablements WHERE user_id=${session.userId}`,
    );
    if (disabled.rows.length)
      throw new APIError('FORBIDDEN', {
        code: 'ACCOUNT_DISABLED',
        message:
          'This account is disabled. Contact your workspace owner or Luma support.',
      });
  };
}

// Factors are reached only through the auth bridge, so server callers need no plugin API types.
function factorPlugins(settings: AuthSettings): BetterAuthPlugin[] {
  return [
    twoFactor(),
    passkey({
      rpID: new URL(settings.baseURL).hostname,
      origin: settings.trustedOrigins,
    }),
  ];
}

// Unlike credential registration, reading one's sessions does not need a fresh sign-in.
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
            token: string;
            created_at: string;
            last_active_at: string | null;
            ip_address: string | null;
            user_agent: string | null;
          }>(
            sql`SELECT id,token,created_at,last_active_at,ip_address,user_agent FROM sessions WHERE user_id=${ctx.context.session.user.id} AND expires_at>now() ORDER BY COALESCE(last_active_at,created_at) DESC,id`,
          );

          return ctx.json(
            result.rows.map((row) => ({
              id: row.id,
              token: row.token,
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
    },
  };
}

/**
 * Configures email and password sign-in, authenticator-app two-factor authentication, passkeys
 * and organization support using the supplied database and trusted origins. Passkeys use the
 * `baseURL` host as relying-party ID and accept assertions only from trusted origins.
 * Disabled accounts get no new session. `observers` run after every other plugin, so their hooks
 * see final responses.
 */
export function createAuth(
  db: NodePgDatabase<typeof schema>,
  settings: AuthSettings,
  provisionId?: string,
  observers: BetterAuthPlugin[] = [],
) {
  const passwordMail = settings.passwordMail;

  return betterAuth({
    secret: settings.secret,
    baseURL: settings.baseURL,
    basePath: '/auth',
    appName: 'Luma',
    trustedOrigins: settings.trustedOrigins,
    database: drizzleAdapter(db, { provider: 'pg', schema, transaction: true }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      resetPasswordTokenExpiresIn: 15 * 60,
      revokeSessionsOnPasswordReset: true,
      ...(passwordMail
        ? {
            sendResetPassword: async ({ user, token }, request) =>
              passwordMail.reset(user.id, token, passwordMailLocale(request)),
            onPasswordReset: async ({ user }, request) => {
              // Revocation must happen even if queuing the mandatory notice fails.
              await db.execute(
                sql`DELETE FROM sessions WHERE user_id=${user.id}`,
              );
              await passwordMail.changed(user.id, passwordMailLocale(request));
            },
          }
        : {}),
    },
    rateLimit: {
      enabled: true,
      customRules: {
        '/request-password-reset': { window: 60, max: 3 },
        '/reset-password': { window: 60, max: 5 },
        ...(process.env.NODE_ENV !== 'production'
          ? { '/**': false as const }
          : {}),
      },
    },
    account: { accountLinking: { enabled: false } },
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
    hooks: { before: accountSecurityMiddleware(db) },
    databaseHooks: {
      session: { create: { before: refuseDisabledAccounts(db) } },
    },
    advanced: {
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
                defaultValue: 'EU',
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
      ...(settings.plugins ?? []),
      ...observers,
    ],
  });
}
