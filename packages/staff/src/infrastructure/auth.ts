import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { createGoogleWorkspaceAuthPlugin } from '@luma/identity-provider/composition';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

import * as schema from './schema.js';
import type { StaffSettings } from './settings.js';

interface StaffAuth {
  /** Handles a namespaced authentication request with its own verified identity scope. */
  handler(request: Request): Promise<Response>;
  api: {
    /** Reads the uncached session without changing its lifetime. */
    getSession(input: {
      headers: Headers;
      query: { disableCookieCache: boolean; disableRefresh: boolean };
    }): Promise<{
      user: { id: string; name: string; email: string };
      session: { id: string };
    } | null>;
  };
}

/** Configures a separate session namespace and only server-admitted Google identities or local credentials. */
export function createStaffAuth(
  pool: Pool,
  settings: StaffSettings,
): StaffAuth {
  const db = drizzle(pool, { schema });
  const identityScope = new AsyncLocalStorage<{ subject?: string }>();

  const regionalOrigin = settings.regionalApiOrigins?.[settings.region ?? 'AU'];
  const auth = betterAuth({
    secret: settings.secret,
    baseURL: regionalOrigin
      ? regionalOrigin + '/auth'
      : settings.publicOrigin + '/api/auth',
    basePath: '/auth',
    appName: 'Luma staff',
    logger: { disabled: true },
    trustedOrigins: [
      settings.publicOrigin,
      ...(regionalOrigin ? [regionalOrigin] : []),
    ],
    database: drizzleAdapter(db, { provider: 'pg', schema, transaction: true }),
    emailAndPassword: {
      enabled: settings.mode === 'local',
      disableSignUp: true,
      minPasswordLength: 12,
    },
    account: {
      accountLinking: { enabled: false },
      storeAccountCookie: false,
      storeStateStrategy: 'database',
      encryptOAuthTokens: true,
    },
    session: {
      additionalFields: {
        providerSubject: {
          type: 'string',
          required: false,
          input: false,
          returned: false,
        },
      },
      expiresIn: 8 * 60 * 60,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    advanced: {
      cookiePrefix: settings.cookiePrefix,
      crossSubDomainCookies: { enabled: false },
      ipAddress: { ipAddressHeaders: ['x-luma-staff-client-ip'] },
      useSecureCookies: settings.mode === 'google',
      database: { generateId: () => randomUUID() },
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        secure: settings.mode === 'google',
      },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const subject = identityScope.getStore()?.subject;
            if (settings.mode === 'google' && !subject) return false;

            return { data: { ...session, providerSubject: subject ?? null } };
          },
        },
      },
      account: {
        create: {
          before: async (account) => ({
            data: {
              ...account,
              accessToken: null,
              refreshToken: null,
              idToken: null,
            },
          }),
        },
        update: {
          before: async (account) => ({
            data: {
              ...account,
              accessToken: null,
              refreshToken: null,
              idToken: null,
            },
          }),
        },
      },
    },
    rateLimit: { enabled: true, window: 60, max: 10 },
    plugins:
      settings.mode === 'google'
        ? [
            createGoogleWorkspaceAuthPlugin({
              clientId: settings.googleClientId ?? '',
              clientSecret: settings.googleClientSecret ?? '',
              hostedDomain: settings.googleHostedDomain ?? '',
              validateIdentity: async (identity) => {
                const result = await pool.query(
                  'SELECT 1 FROM staff_access WHERE email=$1 AND provider_subject=$2 AND active',
                  [identity.email.toLowerCase(), identity.subject],
                );

                const scope = identityScope.getStore();
                if (result.rowCount !== 1 || !scope) return false;
                scope.subject = identity.subject;

                return true;
              },
            }),
          ]
        : [],
  });

  return {
    api: { getSession: auth.api.getSession },
    handler: (request: Request) =>
      identityScope.run({}, () => auth.handler(request)),
  };
}

/** Records staff authentication outcomes before session cookies are delivered, without retaining tokens or OAuth parameters. */
export function createAuditedStaffAuthHandler(
  auth: {
    handler(request: Request): Promise<Response>;
    api: {
      getSession(input: {
        headers: Headers;
        query: { disableCookieCache: boolean; disableRefresh: boolean };
      }): Promise<{ user: { id: string }; session: { id: string } } | null>;
    };
  },
  pool: { query(sql: string, values: unknown[]): Promise<unknown> },
) {
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    const signIn =
      path.endsWith('/sign-in/email') || path.endsWith('/callback/google');
    const signOut = path.endsWith('/sign-out');
    const previous = signOut
      ? await auth.api.getSession({
          headers: request.headers,
          query: { disableCookieCache: true, disableRefresh: true },
        })
      : null;
    const response = await auth.handler(request);
    if (!signIn && !signOut) return response;
    const cookies = response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0])
      .join('; ');
    const current =
      signIn && response.status < 400 && cookies
        ? await auth.api.getSession({
            headers: new Headers({ cookie: cookies }),
            query: { disableCookieCache: true, disableRefresh: true },
          })
        : null;
    const session = signOut ? previous : current;
    await pool.query(
      'INSERT INTO staff_audit(staff_user_id,staff_session_id,event,request_id,details) VALUES($1,$2,$3,$4,$5)',
      [
        session?.user.id ?? null,
        session?.session.id ?? null,
        signOut
          ? 'staff.signed-out'
          : session
            ? 'staff.signed-in'
            : 'staff.sign-in.failed',
        request.headers.get('x-luma-staff-request-id') ?? randomUUID(),
        JSON.stringify({
          method: path.endsWith('/callback/google') ? 'google' : 'local',
        }),
      ],
    );

    return response;
  };
}
