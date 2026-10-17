import { AsyncLocalStorage } from 'node:async_hooks';

import type { Email } from '@luma/email';
import type { DBAdapter, DBTransactionAdapter } from 'better-auth';
import { getCurrentAdapter } from 'better-auth';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import type { Pool } from 'pg';

import type { MailProvider } from '../application/mail.js';
import { deriveKey } from './keys.js';
import { requestLocale } from './locale.js';
import {
  dispatchMail,
  maxAttempts,
  retryDelaySeconds,
} from './mail-dispatch.js';

/** Chooses the language of the browser that asked; it is never an authority input. */
export function passwordMailLocale(request: Request | undefined) {
  return requestLocale(request?.headers).locale;
}

/** Seconds an email confirmation link stays valid. */
export const emailVerificationSeconds = 24 * 3600;

/** A sign-in factor whose addition the account owner is told about. */
export type AddedFactor = 'passkey' | 'authenticator';

/** One account security message: a reset or confirmation link, or a mandatory notice. */
export type SecurityMail =
  | { kind: 'reset' | 'verify'; userId: string; token: string }
  | { kind: 'factor_added'; userId: string; factor: AddedFactor }
  | { kind: 'changed'; userId: string };

/**
 * Better Auth model of the `password_security_mail` outbox. Luma's migrations own the table, so
 * Better Auth neither migrates nor validates it; the Drizzle table in `schema.ts` must match.
 */
const securityMailModel = 'securityMail';

/** Plugin schema that lets Better Auth's adapter, and so its transactions, write the outbox. */
export const securityMailSchema = {
  [securityMailModel]: {
    disableMigration: true,
    fields: {
      userId: { type: 'string', required: true },
      kind: { type: 'string', required: true },
      resetToken: { type: 'string', required: false },
      factor: { type: 'string', required: false },
      locale: { type: 'string', required: true },
      expiresAt: { type: 'date', required: true },
    },
  },
} as const;

// Reset links work for 15 minutes. Other messages stop an hour before a link would expire, so
// a delayed confirmation still works.
const queuedSeconds = { reset: 15 * 60, verify: 23 * 3600 } as const;

/** Holds the first outbox write error of the Better Auth transaction it runs in. */
const transactionFailures = new AsyncLocalStorage<{ error?: unknown }>();

/**
 * Queues one account security message. Inside a Better Auth transaction, such as sign-up, the
 * row is written in that transaction, so the account change and its mail commit together;
 * otherwise it is written through `adapter` at once. Link tokens are stored encrypted. A failed
 * write rejects, and a transaction it ran in is rolled back by `failTransactionsOnOutboxError`
 * even where Better Auth swallows the rejection.
 */
export async function queueSecurityMail(
  adapter: DBTransactionAdapter,
  secret: string,
  mail: SecurityMail,
  locale: 'en' | 'de',
) {
  try {
    const resetToken =
      mail.kind === 'reset' || mail.kind === 'verify'
        ? await symmetricEncrypt({
            key: deriveKey(secret, 'password-mail'),
            data: mail.token,
          })
        : null;
    const seconds =
      mail.kind === 'reset' ? queuedSeconds.reset : queuedSeconds.verify;
    await (
      await getCurrentAdapter(adapter)
    ).create({
      model: securityMailModel,
      data: {
        userId: mail.userId,
        kind: mail.kind,
        resetToken,
        factor: mail.kind === 'factor_added' ? mail.factor : null,
        locale,
        expiresAt: new Date(Date.now() + seconds * 1000),
      },
    });
  } catch (error) {
    const transaction = transactionFailures.getStore();
    if (transaction && !('error' in transaction)) transaction.error = error;
    throw error;
  }
}

/**
 * Makes every transaction of `adapter` roll back and reject when a `queueSecurityMail` call in
 * it failed. Better Auth catches and only logs errors of mail callbacks such as
 * `sendVerificationEmail`, so without this a sign-up could commit without its confirmation
 * link. Changes `adapter` in place, so checks Better Auth attached to it stay in effect.
 */
export function failTransactionsOnOutboxError(adapter: DBAdapter) {
  const transaction = adapter.transaction.bind(adapter);
  adapter.transaction = (callback) =>
    transaction(async (trx) => {
      const state: { error?: unknown } = {};
      const result = await transactionFailures.run(state, () => callback(trx));
      if ('error' in state) throw state.error;

      return result;
    });

  return adapter;
}

/** Builds the email for one queued message; links carry their credential in the fragment. */
function securityEmail(
  message: { kind: string; factor: AddedFactor | null },
  token: string | null,
  origin: string,
): Email {
  const link = (path: string) => new URL(path, origin).href;
  if (token)
    return message.kind === 'verify'
      ? {
          kind: 'email_verification',
          link: `${link('/verify-email')}#${token}`,
        }
      : { kind: 'password_reset', link: `${link('/reset-password')}#${token}` };
  if (message.kind === 'factor_added')
    return {
      kind: 'security_factor_added',
      factor: message.factor ?? 'passkey',
      resetLink: link('/forgot-password'),
    };

  return { kind: 'password_changed', resetLink: link('/forgot-password') };
}

/**
 * Delivers account security mail outside auth requests, in the language of the browser that
 * started it, with stable provider keys and five bounded attempts. Expired links are never
 * dispatched and encrypted credentials are cleared. Returns false when the provider's rate
 * limit ended the pass.
 */
export async function drainPasswordMail(
  pool: Pool,
  provider: MailProvider,
  origin: string,
  secret: string,
) {
  await pool.query(
    "DELETE FROM password_security_mail WHERE expires_at<=now() OR state<>'queued'",
  );
  for (let count = 0; count < 20; count++) {
    const message = (
      await pool.query<{
        id: string;
        user_id: string;
        kind: 'reset' | 'changed' | 'verify' | 'factor_added';
        factor: AddedFactor | null;
        locale: 'en' | 'de';
        reset_token: string | null;
        attempts: number;
      }>(
        `WITH next AS (SELECT id FROM password_security_mail WHERE state='queued' AND expires_at>now() AND next_attempt_at<=now() AND attempts<${maxAttempts} ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1)
       UPDATE password_security_mail m SET attempts=attempts+1,first_attempt_at=COALESCE(first_attempt_at,now()),next_attempt_at=now()+interval '60 seconds'
       FROM next WHERE m.id=next.id RETURNING m.id,m.user_id,m.kind,m.factor,m.locale,m.reset_token,m.attempts`,
      )
    ).rows[0];
    if (!message) break;
    const user = (
      await pool.query<{ email: string; email_verified: boolean }>(
        'SELECT email,email_verified FROM users WHERE id=$1',
        [message.user_id],
      )
    ).rows[0];
    if (!user) continue;
    if (message.kind === 'verify' && user.email_verified) {
      await pool.query('DELETE FROM password_security_mail WHERE id=$1', [
        message.id,
      ]);
      continue;
    }
    const token = message.reset_token
      ? await symmetricDecrypt({
          key: deriveKey(secret, 'password-mail'),
          data: message.reset_token,
        }).catch(() => null)
      : null;
    if (message.reset_token && !token) {
      // A link that can't be decrypted, such as after a secret rotation, is never sent.
      await pool.query(
        "UPDATE password_security_mail SET state='failed',reset_token=NULL WHERE id=$1",
        [message.id],
      );
      continue;
    }
    const outcome = await dispatchMail(pool, provider, {
      id: message.id,
      to: user.email,
      locale: message.locale,
      email: securityEmail(message, token, origin),
    });
    if (outcome.status === 'deferred') {
      // A rate-limited request was never processed, so it doesn't use up an attempt.
      await pool.query(
        "UPDATE password_security_mail SET attempts=attempts-1,next_attempt_at=now()+($3*interval '1 second') WHERE id=$1 AND attempts=$2",
        [message.id, message.attempts, outcome.seconds],
      );

      return false;
    }
    const sent = outcome.status === 'sent';
    await pool.query(
      `UPDATE password_security_mail SET state=CASE WHEN $3 THEN 'sent' WHEN attempts>=${maxAttempts} THEN 'failed' ELSE 'queued' END,
       reset_token=CASE WHEN $3 OR attempts>=${maxAttempts} THEN NULL ELSE reset_token END,next_attempt_at=now()+($4*interval '1 second') WHERE id=$1 AND attempts=$2`,
      [message.id, message.attempts, sent, retryDelaySeconds(message.attempts)],
    );
  }

  return true;
}
