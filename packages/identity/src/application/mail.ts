/** One rendered message. `id` is stable across attempts and is the provider's idempotency key. */
interface OutgoingMail {
  id: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  /** What the message is about, such as `invitation`; shown in the provider's logs. */
  category: string;
}

/**
 * Delivers a message once for an idempotency key; implementations must bound network time.
 * Resolves with the provider's message ID when it returns one. Throws `MailRateLimited` when
 * the provider refused the request without processing it, and any other error when the outcome
 * is failed or unknown.
 */
export interface MailProvider {
  send(message: OutgoingMail): Promise<{ providerId: string } | void>;
}

/** The provider refused a request because of its rate limit; nothing was sent. */
export class MailRateLimited extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Email provider rate limit reached');
  }
}
