import { randomUUID } from 'node:crypto';

import { m } from '@luma/i18n/messages';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import type { Pool } from 'pg';

import type { MailProvider } from '../application/mail.js';

/** Chooses a supported language from the browser preference; it is never an authority input. */
export function passwordMailLocale(request: Request | undefined): 'en' | 'de' {
  const cookie = request?.headers
    .get('cookie')
    ?.match(/(?:^|;\s*)luma_locale=(en|de)(?:;|$)/)?.[1];

  return cookie === 'de' ||
    (!cookie &&
      request?.headers.get('accept-language')?.toLowerCase().startsWith('de'))
    ? 'de'
    : 'en';
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
 * Delivers account security mail outside auth requests, with stable provider keys and five
 * bounded attempts. Expired links are never dispatched and encrypted credentials are cleared.
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
        `WITH next AS (SELECT id FROM password_security_mail WHERE state='queued' AND expires_at>now() AND next_attempt_at<=now() AND attempts<5 ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1)
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
    let sent = false;
    try {
      const token = message.reset_token
        ? await symmetricDecrypt({ key: secret, data: message.reset_token })
        : null;
      await provider.send({
        id: message.id,
        to: user.email,
        subject: token
          ? m.identity_password_mail_reset_subject(
              {},
              { locale: message.locale },
            )
          : m.identity_password_mail_changed_subject(
              {},
              { locale: message.locale },
            ),
        text: token
          ? `${m.identity_password_mail_reset_body({}, { locale: message.locale })}\n\n${new URL('/reset-password', origin).href}#${token}`
          : m.identity_password_mail_changed_body(
              {},
              { locale: message.locale },
            ),
      });
      sent = true;
    } catch {
      // A retry uses the same provider key, including after uncertain network responses.
    }
    await pool.query(
      `UPDATE password_security_mail SET state=CASE WHEN $3 THEN 'sent' WHEN attempts>=5 THEN 'failed' ELSE 'queued' END,
       reset_token=CASE WHEN $3 OR attempts>=5 THEN NULL ELSE reset_token END,next_attempt_at=now()+($4*interval '1 second') WHERE id=$1 AND attempts=$2`,
      [message.id, message.attempts, sent, 30 * 2 ** message.attempts],
    );
  }
}
