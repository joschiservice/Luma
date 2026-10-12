import { type Email, renderEmail } from '@luma/email';
import type { Locale } from '@luma/i18n/locales';
import type { Pool } from 'pg';

import { type MailProvider, MailRateLimited } from '../application/mail.js';

/** Attempts per message; every retry stays within the provider's 24-hour idempotency window. */
export const maxAttempts = 5;

/** Seconds before retrying after a failed attempt, doubling from one minute. */
export const retryDelaySeconds = (attempts: number) => 30 * 2 ** attempts;

/**
 * What happened to one attempt: `sent` once the provider accepted it, `failed` when it was
 * refused or its outcome is unknown, and `deferred` when the provider's rate limit refused it
 * without processing, which doesn't count as an attempt.
 */
export type DispatchOutcome =
  | { status: 'sent' }
  | { status: 'failed' }
  | { status: 'deferred'; seconds: number };

/**
 * Renders a reserved message in the recipient's language and hands it to the provider, then
 * records the provider's receipt so delivery events can be matched. Callers commit the attempt
 * before calling and hold no locks, since this waits on the network. Never throws.
 */
export async function dispatchMail(
  pool: Pool,
  provider: MailProvider,
  message: { id: string; to: string; email: Email; locale: Locale },
): Promise<DispatchOutcome> {
  let receipt: { providerId: string } | void;
  try {
    receipt = await provider.send({
      id: message.id,
      to: message.to,
      category: message.email.kind,
      ...(await renderEmail(message.email, message.locale)),
    });
  } catch (error) {
    // The committed attempt and the stable key make uncertain responses safe to retry.
    return error instanceof MailRateLimited
      ? { status: 'deferred', seconds: error.retryAfterSeconds }
      : { status: 'failed' };
  }
  if (receipt)
    // The message is already accepted; a lost receipt only means its delivery events are ignored.
    await pool
      .query(
        'INSERT INTO mail_receipts(provider_id,message_id) VALUES($1,$2) ON CONFLICT (provider_id) DO NOTHING',
        [receipt.providerId, message.id],
      )
      .catch(() => undefined);

  return { status: 'sent' };
}
