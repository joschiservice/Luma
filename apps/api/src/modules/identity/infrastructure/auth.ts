import { randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import type { BetterAuthPlugin } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
export interface AuthSettings {
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
  /** Reviewed server plugins, e.g. regional SSO/SCIM adapters. */
  plugins?: BetterAuthPlugin[];
}
export function createAuth(
  db: NodePgDatabase<typeof schema>,
  settings: AuthSettings,
  provisionId?: string,
) {
  return betterAuth({
    secret: settings.secret,
    baseURL: settings.baseURL,
    basePath: '/auth',
    trustedOrigins: settings.trustedOrigins,
    database: drizzleAdapter(db, { provider: 'pg', schema, transaction: true }),
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    account: { accountLinking: { enabled: false } },
    session: { cookieCache: { enabled: false } },
    advanced: {
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
      ...(settings.plugins ?? []),
    ],
  });
}
