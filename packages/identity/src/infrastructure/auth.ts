import { randomUUID } from 'node:crypto';

import { passkey } from '@better-auth/passkey';
import type { BetterAuthPlugin } from 'better-auth';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { organization, twoFactor } from 'better-auth/plugins';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import * as schema from './schema.js';

export interface AuthSettings {
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
  /** Separates sessions for applications sharing a hostname. */
  cookiePrefix?: string;
  /** Reviewed server plugins, e.g. regional SSO/SCIM adapters. */
  plugins?: BetterAuthPlugin[];
}

// Trusted devices and session-less code checks would let a second factor be skipped later.
const rejectedFactorOptions = createAuthMiddleware(async (ctx) => {
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

/**
 * Configures email and password sign-in, authenticator-app two-factor authentication, passkeys
 * and organization support using the supplied database and trusted origins. Passkeys use the
 * `baseURL` host as relying-party ID and accept assertions only from trusted origins.
 */
export function createAuth(
  db: NodePgDatabase<typeof schema>,
  settings: AuthSettings,
  provisionId?: string,
) {
  return betterAuth({
    secret: settings.secret,
    baseURL: settings.baseURL,
    basePath: '/auth',
    appName: 'Luma',
    trustedOrigins: settings.trustedOrigins,
    database: drizzleAdapter(db, { provider: 'pg', schema, transaction: true }),
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
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
    hooks: { before: rejectedFactorOptions },
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
      ...(settings.plugins ?? []),
    ],
  });
}
