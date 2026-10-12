import { randomUUID } from 'node:crypto';

import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import type { Pool } from 'pg';

import type { MailProvider } from '../application/mail.js';
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

/** Queues reset links and mandatory password notices using the existing delivery provider. */
export function createPasswordMail(pool: Pool, secret: string) {
  return {
    async reset(userId: string, token: string, locale: 'en' | 'de') {
      const encrypted = await symmetricEncrypt({ key: secret, data: token });
      await pool.query(
        "INSERT INTO password_security_mail(id,user_id,kind,reset_token,locale,expires_at) VALUES($1,$2,'reset',$3,$4,now()+interval '15 minutes')",
        [randomUUID(), userId, encrypted, locale],
      );
    },
    async changed(userId: string, locale: 'en' | 'de') {
      await pool.query(
        "INSERT INTO password_security_mail(id,user_id,kind,locale,expires_at) VALUES($1,$2,'changed',$3,now()+interval '23 hours')",
        [randomUUID(), userId, locale],
      );
    },
  };
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
        kind: 'reset' | 'changed';
        locale: 'en' | 'de';
        reset_token: string | null;
        attempts: number;
      }>(
        `WITH next AS (SELECT id FROM password_security_mail WHERE state='queued' AND expires_at>now() AND next_attempt_at<=now() AND attempts<${maxAttempts} ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1)
       UPDATE password_security_mail m SET attempts=attempts+1,first_attempt_at=COALESCE(first_attempt_at,now()),next_attempt_at=now()+interval '60 seconds'
       FROM next WHERE m.id=next.id RETURNING m.id,m.user_id,m.kind,m.locale,m.reset_token,m.attempts`,
      )
    ).rows[0];
    if (!message) break;
    const user = (
      await pool.query<{ email: string }>(
        'SELECT email FROM users WHERE id=$1',
        [message.user_id],
      )
    ).rows[0];
    if (!user) continue;
    const token = message.reset_token
      ? await symmetricDecrypt({
          key: secret,
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
      email: token
        ? {
            kind: 'password_reset',
            link: `${new URL('/reset-password', origin).href}#${token}`,
          }
        : {
            kind: 'password_changed',
            resetLink: new URL('/forgot-password', origin).href,
          },
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
