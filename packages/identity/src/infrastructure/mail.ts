import type { MailProvider } from '../application/mail.js';

/** Sends plain-text email through Resend with a stable deduplication key and a bounded timeout. */
export function createResendMail(settings: {
  apiKey: string;
  from: string;
}): MailProvider {
  return {
    async send(message) {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        signal: AbortSignal.timeout(8000),
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': message.id,
        },
        body: JSON.stringify({
          from: settings.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
        }),
      });
      if (!response.ok)
        throw new Error('Email provider did not accept the message');
      const body: unknown = await response.json();
      if (
        !body ||
        typeof body !== 'object' ||
        !('id' in body) ||
        typeof body.id !== 'string'
      )
        throw new Error('Email provider returned no receipt');
    },
  };
}
