import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import type { Pool } from 'pg';

import {
  passwordFailureLimit,
  passwordSignInLocked,
} from '../domain/sign-in-protection.js';

type Database = Pick<Pool, 'query'>;

/**
 * Counts an email address's recent wrong-password sign-ins from recorded security events, since
 * the account's last successful sign-in or password reset. Unknown addresses count by their
 * keyed email hash, so known and unknown addresses are limited alike.
 */
async function recentPasswordFailures(
  db: Database,
  email: string,
  emailHash: (email: string) => string,
) {
  const user = (
    await db.query<{ id: string }>('SELECT id FROM users WHERE email=$1', [
      email,
    ])
  ).rows[0];
  const window = `${passwordFailureLimit.windowMinutes} minutes`;
  const result = user
    ? await db.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM account_security_events WHERE user_id=$1
         AND event_type='sign-in.password' AND outcome='failed' AND reason_code='invalid-credentials'
         AND created_at>GREATEST(now()-$2::interval,COALESCE((SELECT max(created_at) FROM account_security_events
           WHERE user_id=$1 AND outcome='succeeded' AND (event_type LIKE 'sign-in.%' OR event_type='password.reset')),'-infinity'))`,
        [user.id, window],
      )
    : await db.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM account_security_events WHERE email_hash=$1
         AND event_type='sign-in.password' AND outcome='failed' AND reason_code='invalid-credentials' AND created_at>now()-$2::interval`,
        [emailHash(email), window],
      );

  return result.rows[0]?.count ?? 0;
}

/**
 * Refuses password sign-ins for an email address with too many recent wrong passwords, before
 * the password is checked. The refusal is the same for known and unknown addresses and names no
 * account. Passkey sign-in and password reset stay available. Failures are counted from the
 * events the security events plugin records, so the limit holds across API instances.
 */
export function signInLockoutPlugin(
  db: Database,
  emailHash: (email: string) => string,
): BetterAuthPlugin {
  return {
    id: 'luma-sign-in-lockout',
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === '/sign-in/email',
          handler: createAuthMiddleware(async (ctx) => {
            const body: unknown = ctx.body;
            const email =
              body && typeof body === 'object' && 'email' in body
                ? body.email
                : undefined;
            if (typeof email !== 'string') return;
            const normalized = email.trim().toLowerCase();
            if (
              normalized &&
              passwordSignInLocked(
                await recentPasswordFailures(db, normalized, emailHash),
              )
            )
              throw new APIError('TOO_MANY_REQUESTS', {
                code: 'SIGN_IN_LOCKED',
                message:
                  'Too many sign-in attempts. Wait 15 minutes, sign in with a passkey, or reset your password.',
              });
          }),
        },
      ],
    },
  };
}
