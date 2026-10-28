import { type Email, renderEmail } from '@luma/email';
import type { Locale } from '@luma/i18n/locales';
import type { Pool } from 'pg';

import {
  MailOutcomeUncertain,
  type MailProvider,
  MailRateLimited,
} from '../application/mail.js';

/** Attempts per message; every retry stays within Resend's 24-hour idempotency window. */
export const maxAttempts = 5;

/** Seconds before retrying after a failed attempt, doubling from one minute. */
export const retryDelaySeconds = (attempts: number) => 30 * 2 ** attempts;

/**
 * What happened to one attempt: `sent` once the provider accepted it or a repeated uncertain
 * attempt may have, `failed` when it was refused or its outcome is unknown and may be retried,
 * and `deferred` when the provider's rate limit refused it without processing, which doesn't
 * count as an attempt.
 */
export type DispatchOutcome =
  | { status: 'sent' }
  | { status: 'failed' }
  | { status: 'deferred'; seconds: number };

/**
 * Renders a reserved message in the recipient's language and hands it to the provider, then
 * records the provider's receipt so delivery events can be matched. Callers commit the attempt
 * before calling, pass its number starting at 1, and hold no locks, since this waits on the
 * network. Never throws.
 *
 * Providers without idempotency keys report an ambiguous send as `MailOutcomeUncertain`. Only
 * the first attempt is retried after one; from the second attempt on it counts as sent, because
 * another try could deliver another copy. Uncertain outcomes thus add at most one copy, while a
 * later uncertain attempt that the provider in fact refused is never sent. A process crash
 * during a send can still add a copy, since the next attempt can't tell it from a failure.
 */
export async function dispatchMail(
  pool: Pool,
  provider: MailProvider,
  message: {
    id: string;
    to: string;
    email: Email;
    locale: Locale;
    attempt: number;
  },
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
    if (error instanceof MailRateLimited)
      return { status: 'deferred', seconds: error.retryAfterSeconds };
    if (error instanceof MailOutcomeUncertain && message.attempt > 1)
      return { status: 'sent' };

    // The committed attempt and the stable key make other failures safe to retry.
    return { status: 'failed' };
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
