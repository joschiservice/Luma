import { Resend } from 'resend';

import { type MailProvider, MailRateLimited } from '../application/mail.js';

/**
 * Sends HTML and plain-text email through the Resend SDK. The message ID is the idempotency
 * key, so a retry within Resend's 24-hour window never sends twice. Calls time out after eight
 * seconds. A rate-limited request throws `MailRateLimited` with the provider's retry delay;
 * every other refusal or network failure throws without the message contents.
 */
export function createResendMail(
  settings: { apiKey: string; from: string },
  client: { emails: Pick<Resend['emails'], 'send'> } = new Resend(
    settings.apiKey,
  ),
): MailProvider {
  return {
    async send(message) {
      const { data, error, headers } = await client.emails.send(
        {
          from: settings.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
          tags: [{ name: 'category', value: message.category }],
        },
        {
          idempotencyKey: message.id,
          signal: AbortSignal.timeout(8000),
        },
      );
      if (error) {
        if (error.name === 'rate_limit_exceeded' || error.statusCode === 429)
          throw new MailRateLimited(retryAfter(headers?.['retry-after']));
        throw new Error(`Email provider refused the message: ${error.name}`);
      }
      if (!data?.id) throw new Error('Email provider returned no receipt');

      return { providerId: data.id };
    },
  };
}

/** Reads a `retry-after` value in seconds, bounded to between one second and one hour. */
function retryAfter(value: string | undefined) {
  const seconds = Number(value);

  return Number.isFinite(seconds) ? Math.min(Math.max(seconds, 1), 3600) : 60;
}
