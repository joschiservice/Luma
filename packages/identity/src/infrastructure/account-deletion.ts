import type { Email } from '@luma/email';
import type { Pool } from 'pg';

import type { MailProvider } from '../application/mail.js';
import {
  dispatchMail,
  maxAttempts,
  retryDelaySeconds,
} from './mail-dispatch.js';

/**
 * Erases accounts whose deletion is due, each in its own transaction, up to 20 per pass. With
 * `notify`, the completion notice is queued first and a deletion waits until the notice is sent
 * or has failed. An interrupted erasure rolls back completely and the next pass repeats it.
 * Throws an `AggregateError` with every failed erasure after trying the others.
 */
export async function eraseDueAccounts(pool: Pool, notify: boolean) {
  const due = await pool.query<{ id: string }>(
    'SELECT id FROM account_erasures_due($1)',
    [notify],
  );
  const failures: unknown[] = [];
  let erased = 0;
  for (const { id } of due.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Pseudonymizing history scans the person's workspaces, which can outlast a request.
      await client.query("SET LOCAL statement_timeout='60s'");
      const result = await client.query<{ erased: boolean }>(
        'SELECT account_erase($1) AS erased',
        [id],
      );
      await client.query('COMMIT');
      if (result.rows[0]?.erased) erased++;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      failures.push(error);
    } finally {
      client.release();
    }
  }
  if (failures.length)
    throw new AggregateError(failures, 'Account erasure failed');

  return { erased };
}

interface AccountMessage {
  id: string;
  user_id: string;
  deletion_id: string;
  kind: 'deletion_scheduled' | 'deletion_restored' | 'account_erased';
  state: 'queued' | 'failed';
  attempts: number;
}

/** Builds the notice for the person; the address is read from the account at sending time. */
function accountNotice(
  message: AccountMessage,
  eraseAfter: Date,
  origin: string,
): Email {
  switch (message.kind) {
    case 'deletion_scheduled':
      return { kind: 'account_deletion_scheduled', eraseAfter };
    case 'deletion_restored':
      return {
        kind: 'account_restored',
        signInLink: new URL('/sign-in', origin).href,
      };
    default:
      return { kind: 'account_erased' };
  }
}

/**
 * Delivers queued account notices: deletion scheduled, restored and completed. Each attempt is
 * committed before sending, so the provider's idempotency key covers uncertain responses. A
 * notice fails after five attempts or 23 hours, and is cancelled when the account is gone.
 * Notices use the person's language. Returns false when the provider's rate limit ended the pass.
 */
export async function drainAccountMail(
  pool: Pool,
  provider: MailProvider,
  origin: string,
) {
  for (let count = 0; count < 20; count++) {
    const message = (
      await pool.query<AccountMessage>(
        `WITH next AS (SELECT id FROM account_mail WHERE state='queued' AND next_attempt_at<=now() ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED),
        expired AS (SELECT m.id,m.attempts>=${maxAttempts} OR m.first_attempt_at<=now()-interval '23 hours' AS expired FROM account_mail m JOIN next ON next.id=m.id)
        UPDATE account_mail m SET state=CASE WHEN e.expired THEN 'failed' ELSE 'queued' END,
          attempts=CASE WHEN e.expired THEN m.attempts ELSE m.attempts+1 END,
          first_attempt_at=COALESCE(m.first_attempt_at,now()),next_attempt_at=now()+interval '60 seconds'
        FROM expired e WHERE m.id=e.id
        RETURNING m.id,m.user_id,m.deletion_id,m.kind,m.state,m.attempts`,
      )
    ).rows[0];
    if (!message) return true;
    if (message.state === 'failed') continue;
    const recipient = (
      await pool.query<{
        email: string;
        locale: string | null;
        erase_after: Date;
      }>(
        'SELECT u.email,u.locale,d.erase_after FROM users u JOIN account_deletions d ON d.user_id=u.id WHERE u.id=$1 AND d.id=$2',
        [message.user_id, message.deletion_id],
      )
    ).rows[0];
    if (!recipient) {
      await pool.query(
        "UPDATE account_mail SET state='cancelled' WHERE id=$1 AND state='queued'",
        [message.id],
      );
      continue;
    }
    const outcome = await dispatchMail(pool, provider, {
      id: message.id,
      to: recipient.email,
      locale: recipient.locale === 'de' ? 'de' : 'en',
      email: accountNotice(message, recipient.erase_after, origin),
    });
    if (outcome.status === 'deferred') {
      // A rate-limited request was never processed, so it doesn't use up an attempt.
      await pool.query(
        "UPDATE account_mail SET attempts=attempts-1,next_attempt_at=now()+($3*interval '1 second') WHERE id=$1 AND state='queued' AND attempts=$2",
        [message.id, message.attempts, outcome.seconds],
      );

      return false;
    }
    const sent = outcome.status === 'sent';
    await pool.query(
      `UPDATE account_mail SET
        state=CASE WHEN $3 THEN 'sent' WHEN attempts>=${maxAttempts} THEN 'failed' ELSE 'queued' END,
        sent_at=CASE WHEN $3 THEN now() ELSE sent_at END,
        next_attempt_at=now()+($4 * interval '1 second')
       WHERE id=$1 AND state='queued' AND attempts=$2`,
      [message.id, message.attempts, sent, retryDelaySeconds(message.attempts)],
    );
  }

  return true;
}
