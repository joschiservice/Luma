import { createHmac, randomUUID } from 'node:crypto';

import type { BetterAuthPlugin } from 'better-auth';
import {
  APIError,
  createAuthMiddleware,
  getIP,
  isAPIError,
} from 'better-auth/api';
import type { Pool } from 'pg';

import type {
  SecurityEvent,
  SecurityEventCursor,
  SecurityEventReason,
  SecurityEventRecord,
  SecurityEventType,
} from '../domain/security-events.js';
import {
  securityEventNetworkRetentionDays,
  securityEventRetentionDays,
  signInFailureReason,
} from '../domain/security-events.js';
import type { AuthSettings } from './auth.js';
import { passwordMailLocale } from './password-mail.js';

type Database = Pick<Pool, 'query'>;

/** Writes one event; a repeated successful sign-in for the same session is ignored. */
export async function recordSecurityEvent(
  db: Database,
  event: SecurityEventRecord,
) {
  await db.query(
    `INSERT INTO account_security_events(id,user_id,email_hash,event_type,outcome,reason_code,session_id,ip_address,user_agent,request_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
    [
      randomUUID(),
      event.userId,
      event.emailHash,
      event.type,
      event.outcome,
      event.reason,
      event.sessionId,
      event.ipAddress?.slice(0, 64) ?? null,
      event.userAgent?.slice(0, 512) ?? null,
      event.requestId.slice(0, 200),
    ],
  );
}

interface EventRow {
  id: string;
  event_type: SecurityEventType;
  outcome: 'succeeded' | 'failed';
  reason_code: SecurityEventReason | null;
  session_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  request_id: string;
  staff_command_id: string | null;
  created_at: Date;
}

/** Reads one account's events, newest first, after an optional cursor. */
export async function listSecurityEvents(
  db: Database,
  userId: string,
  after: SecurityEventCursor | null,
  limit: number,
): Promise<SecurityEvent[]> {
  const result = await db.query<EventRow>(
    `SELECT id,event_type,outcome,reason_code,session_id,ip_address,user_agent,request_id,staff_command_id,created_at
     FROM account_security_events WHERE user_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid))
     ORDER BY created_at DESC,id DESC LIMIT $4`,
    [userId, after?.createdAt ?? null, after?.id ?? null, limit],
  );

  return result.rows.map(eventFromRow);
}

/** Converts a stored event row; shared with the staff read adapter's column names. */
export function eventFromRow(row: EventRow): SecurityEvent {
  return {
    id: row.id,
    type: row.event_type,
    outcome: row.outcome,
    reason: row.reason_code,
    sessionId: row.session_id,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    requestId: row.request_id,
    staffCommandId: row.staff_command_id,
    createdAt: row.created_at,
  };
}

const batchSize = 1000;

/**
 * Applies retention relative to `now`: clears IP addresses and user agents after 90 days and
 * deletes events after a year. Works in bounded batches so a backlog never holds long locks.
 */
export async function purgeSecurityEvents(db: Database, now: Date) {
  const day = 86_400_000;
  const networkCutoff = new Date(
    now.getTime() - securityEventNetworkRetentionDays * day,
  );
  const eventCutoff = new Date(
    now.getTime() - securityEventRetentionDays * day,
  );
  let deleted = 0;
  let cleared = 0;
  for (;;) {
    const result = await db.query(
      `DELETE FROM account_security_events WHERE id IN (SELECT id FROM account_security_events WHERE created_at<$1 LIMIT ${batchSize})`,
      [eventCutoff],
    );
    deleted += result.rowCount ?? 0;
    if ((result.rowCount ?? 0) < batchSize) break;
  }
  for (;;) {
    const result = await db.query(
      `UPDATE account_security_events SET ip_address=NULL,user_agent=NULL WHERE id IN (SELECT id FROM account_security_events WHERE created_at<$1 AND (ip_address IS NOT NULL OR user_agent IS NOT NULL) LIMIT ${batchSize})`,
      [networkCutoff],
    );
    cleared += result.rowCount ?? 0;
    if ((result.rowCount ?? 0) < batchSize) break;
  }

  return { deleted, cleared };
}

/** State read before an endpoint runs, so only real changes are recorded. */
interface Snapshot {
  session: { id: string; userId: string; twoFactorEnabled: boolean } | null;
  /** The account behind a pending two-factor sign-in challenge. */
  challengeUserId: string | null;
  /** Sessions a revocation would end, or whether a passkey to remove exists. */
  targets: number;
  resetUserId?: string;
}

const sessionPaths = new Set([
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
  '/two-factor/disable',
  '/two-factor/generate-backup-codes',
  '/passkey/verify-registration',
  '/passkey/delete-passkey',
  '/change-password',
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
  '/reset-password',
]);
const trackedPaths = new Set([
  ...sessionPaths,
  '/sign-in/email',
  '/passkey/verify-authentication',
]);

/** Names the change a successful session-authenticated request made, if it changed anything. */
function accountChange(
  path: string,
  snapshot: Snapshot,
): [SecurityEventType, SecurityEventReason | null] | null {
  switch (path) {
    case '/two-factor/verify-totp':
      return snapshot.session?.twoFactorEnabled
        ? null
        : ['two-factor.enabled', null];
    case '/two-factor/disable':
      return snapshot.session?.twoFactorEnabled
        ? ['two-factor.disabled', null]
        : null;
    case '/two-factor/generate-backup-codes':
      return ['two-factor.backup-codes-regenerated', null];
    case '/passkey/verify-registration':
      return ['passkey.added', null];
    case '/passkey/delete-passkey':
      return snapshot.targets ? ['passkey.removed', null] : null;
    case '/change-password':
      return ['password.changed', null];
    case '/revoke-session':
      return snapshot.targets ? ['sessions.revoked', 'one'] : null;
    case '/revoke-sessions':
      return snapshot.targets ? ['sessions.revoked', 'all'] : null;
    case '/revoke-other-sessions':
      return snapshot.targets ? ['sessions.revoked', 'others'] : null;
    default:
      return null;
  }
}

function bodyField(body: unknown, key: string): unknown {
  return body && typeof body === 'object' && key in body
    ? Reflect.get(body, key)
    : undefined;
}

/**
 * Records sign-ins and account security changes made through Better Auth endpoints. It runs
 * after the factor plugins, so a password sign-in that still needs a code is recorded as
 * pending rather than as a session. Responses are never changed: known and unknown emails
 * fail identically. If an event cannot be written the request fails, and no new session
 * cookie is delivered; a change that already happened is not undone.
 */
export function securityEventsPlugin(
  db: Database,
  secret: string,
  passwordMail?: AuthSettings['passwordMail'],
): BetterAuthPlugin {
  const snapshots = new WeakMap<object, Snapshot>();
  const emailHash = (email: string) =>
    createHmac('sha256', secret)
      .update(`account-security-email:${email}`)
      .digest('hex');
  const one = async <T extends Record<string, unknown>>(
    sql: string,
    values: unknown[],
  ) => (await db.query<T>(sql, values)).rows[0];

  return {
    id: 'luma-security-events',
    hooks: {
      before: [
        {
          matcher: (ctx) => sessionPaths.has(ctx.path ?? ''),
          handler: createAuthMiddleware(async (ctx) => {
            if (!ctx.request) return;
            const token = await ctx.getSignedCookie(
              ctx.context.authCookies.sessionToken.name,
              ctx.context.secret,
            );
            const session = token
              ? await one<{
                  id: string;
                  user_id: string;
                  two_factor_enabled: boolean;
                }>(
                  'SELECT s.id,s.user_id,u.two_factor_enabled FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1 AND s.expires_at>now()',
                  [token],
                )
              : undefined;
            const snapshot: Snapshot = {
              session: session
                ? {
                    id: session.id,
                    userId: session.user_id,
                    twoFactorEnabled: session.two_factor_enabled,
                  }
                : null,
              challengeUserId: null,
              targets: 0,
            };
            if (ctx.path === '/reset-password') {
              const resetToken = bodyField(ctx.body, 'token');
              const verification =
                typeof resetToken === 'string'
                  ? await ctx.context.internalAdapter.findVerificationValue(
                      `reset-password:${resetToken}`,
                    )
                  : null;
              if (verification && verification.expiresAt > new Date()) {
                const disabled = await one(
                  'SELECT user_id FROM account_disablements WHERE user_id=$1',
                  [verification.value],
                );
                if (disabled)
                  throw new APIError('BAD_REQUEST', {
                    code: 'INVALID_TOKEN',
                    message: 'Invalid or expired reset link.',
                  });
                snapshot.resetUserId = verification.value;
                snapshot.targets =
                  (
                    await one<{ count: number }>(
                      'SELECT count(*)::int AS count FROM sessions WHERE user_id=$1 AND expires_at>now()',
                      [verification.value],
                    )
                  )?.count ?? 0;
              }
            }
            if (!session && ctx.path.startsWith('/two-factor/verify-')) {
              const challenge = await ctx.getSignedCookie(
                ctx.context.createAuthCookie('two_factor').name,
                ctx.context.secret,
              );
              const verification = challenge
                ? await ctx.context.internalAdapter.findVerificationValue(
                    challenge,
                  )
                : null;
              snapshot.challengeUserId = verification?.value ?? null;
            }
            if (session) {
              const target = bodyField(ctx.body, 'token');
              const passkey = bodyField(ctx.body, 'id');
              const count =
                ctx.path === '/passkey/delete-passkey'
                  ? await one<{ count: number }>(
                      'SELECT count(*)::int AS count FROM passkeys WHERE id::text=$1 AND user_id=$2',
                      [
                        typeof passkey === 'string' ? passkey : '',
                        session.user_id,
                      ],
                    )
                  : ctx.path.startsWith('/revoke-') ||
                      (ctx.path === '/change-password' &&
                        bodyField(ctx.body, 'revokeOtherSessions') === true)
                    ? await one<{ count: number }>(
                        `SELECT count(*)::int AS count FROM sessions WHERE user_id=$1 AND expires_at>now() AND ($2='all' OR ($2='others' AND id<>$3) OR ($2='one' AND token=$4))`,
                        [
                          session.user_id,
                          ctx.path === '/revoke-sessions'
                            ? 'all'
                            : ctx.path === '/revoke-other-sessions' ||
                                ctx.path === '/change-password'
                              ? 'others'
                              : 'one',
                          session.id,
                          typeof target === 'string' ? target : '',
                        ],
                      )
                    : undefined;
              snapshot.targets = count?.count ?? 0;
            }
            snapshots.set(ctx.request, snapshot);
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => trackedPaths.has(ctx.path ?? ''),
          handler: createAuthMiddleware(async (ctx) => {
            if (!ctx.request) return;
            const returned: unknown = ctx.context.returned;
            const failed = isAPIError(returned);
            const failure = failed
              ? signInFailureReason(
                  typeof returned.body?.code === 'string'
                    ? returned.body.code
                    : undefined,
                )
              : null;
            const created = ctx.context.newSession;
            const snapshot = snapshots.get(ctx.request);
            const base = {
              ipAddress: getIP(ctx.request, ctx.context.options),
              userAgent: ctx.request.headers.get('user-agent'),
              requestId:
                ctx.request.headers.get('x-luma-request-id') ?? randomUUID(),
              emailHash: null,
            };
            const record = (
              type: SecurityEventType,
              outcome: 'succeeded' | 'failed',
              reason: SecurityEventReason | null,
              userId: string | null,
              sessionId: string | null,
              hash: string | null = null,
            ) =>
              recordSecurityEvent(db, {
                ...base,
                type,
                outcome,
                reason,
                userId,
                sessionId,
                emailHash: userId ? null : hash,
              });
            const path = ctx.path;

            if (path === '/sign-in/email') {
              const email = bodyField(ctx.body, 'email');
              const normalized =
                typeof email === 'string' ? email.trim().toLowerCase() : '';
              if (created && !failed)
                return record(
                  'sign-in.password',
                  'succeeded',
                  null,
                  created.user.id,
                  created.session.id,
                );
              // Known and unknown emails take the same lookup; the response is unchanged.
              const user = await one<{ id: string }>(
                'SELECT id FROM users WHERE email=$1',
                [normalized],
              );
              const pending =
                !failed && bodyField(returned, 'twoFactorRedirect') === true;

              return record(
                'sign-in.password',
                pending ? 'succeeded' : 'failed',
                pending ? 'second-factor-required' : failure,
                user?.id ?? null,
                null,
                normalized ? emailHash(normalized) : null,
              );
            }
            if (path === '/passkey/verify-authentication') {
              if (created && !failed)
                return record(
                  'sign-in.passkey',
                  'succeeded',
                  null,
                  created.user.id,
                  created.session.id,
                );
              const credential = bodyField(
                bodyField(ctx.body, 'response'),
                'id',
              );
              const owner =
                typeof credential === 'string'
                  ? await one<{ user_id: string }>(
                      'SELECT user_id FROM passkeys WHERE credential_id=$1',
                      [credential],
                    )
                  : undefined;

              return record(
                'sign-in.passkey',
                'failed',
                failure === 'account-disabled' ? failure : 'passkey-rejected',
                owner?.user_id ?? null,
                null,
              );
            }
            if (!snapshot) return;
            if (path === '/reset-password' && !failed && snapshot.resetUserId) {
              await record(
                'password.reset',
                'succeeded',
                null,
                snapshot.resetUserId,
                null,
              );
              if (snapshot.targets)
                await record(
                  'sessions.revoked',
                  'succeeded',
                  'all',
                  snapshot.resetUserId,
                  null,
                );

              return;
            }
            const session = snapshot.session;
            if (path.startsWith('/two-factor/verify-') && !session) {
              if (failed)
                return record(
                  'sign-in.two-factor',
                  'failed',
                  failure,
                  snapshot.challengeUserId,
                  null,
                );
              if (!created) return;

              return record(
                'sign-in.two-factor',
                'succeeded',
                path === '/two-factor/verify-totp'
                  ? 'authenticator-code'
                  : 'backup-code',
                created.user.id,
                created.session.id,
              );
            }
            if (failed || !session) return;
            const current = created?.session.id ?? session.id;
            const change = accountChange(path, snapshot);
            if (change)
              await record(
                change[0],
                'succeeded',
                change[1],
                session.userId,
                current,
              );
            if (path === '/change-password') {
              await passwordMail?.changed(
                session.userId,
                passwordMailLocale(ctx.request),
              );
              if (
                bodyField(ctx.body, 'revokeOtherSessions') === true &&
                snapshot.targets
              )
                await record(
                  'sessions.revoked',
                  'succeeded',
                  'others',
                  session.userId,
                  current,
                );
            }
          }),
        },
      ],
    },
  };
}
