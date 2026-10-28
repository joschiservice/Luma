import type { Pool } from 'pg';

import type { MailProvider } from '../application/mail.js';
import { dispatchMail, retryDelaySeconds } from './mail-dispatch.js';

interface ClosureMessage {
  id: string;
  kind: 'closure_scheduled' | 'closure_reminder';
  state: 'queued' | 'failed';
  attempts: number;
  email: string | null;
  locale: string | null;
  workspace: string | null;
  deletion_at: Date;
  valid: boolean;
}

/**
 * Delivers queued notices to owners of closed workspaces: deletion scheduled, and a reminder about
 * a week before. Each attempt is committed before sending, so uncertain responses are retried
 * as `dispatchMail` allows. A notice is cancelled when the person is no longer an owner, the
 * workspace was reopened, its deletion date changed or removal started. Notices use the
 * person's language. Returns false when the provider's rate limit ended the pass.
 */
export async function drainWorkspaceClosureMail(
  pool: Pool,
  provider: MailProvider,
) {
  for (let count = 0; count < 20; count++) {
    const message = (
      await pool.query<ClosureMessage>(
        'SELECT * FROM reserve_workspace_closure_mail()',
      )
    ).rows[0];
    if (!message) return true;
    if (message.state === 'failed') continue;
    const record = (outcome: string, delay: number) =>
      pool.query('SELECT record_workspace_closure_mail($1,$2,$3,$4)', [
        message.id,
        message.attempts,
        outcome,
        delay,
      ]);
    if (!message.valid || !message.email || !message.workspace) {
      await record('cancelled', 0);
      continue;
    }
    const outcome = await dispatchMail(pool, provider, {
      id: message.id,
      to: message.email,
      locale: message.locale === 'de' ? 'de' : 'en',
      email: {
        kind:
          message.kind === 'closure_scheduled'
            ? 'workspace_closure_scheduled'
            : 'workspace_closure_reminder',
        workspace: message.workspace,
        deletionAt: message.deletion_at,
      },
      attempt: message.attempts,
    });
    if (outcome.status === 'deferred') {
      // A rate-limited request was never processed, so it doesn't use up an attempt.
      await record('deferred', outcome.seconds);

      return false;
    }
    await record(
      outcome.status,
      outcome.status === 'sent' ? 0 : retryDelaySeconds(message.attempts),
    );
  }

  return true;
}
