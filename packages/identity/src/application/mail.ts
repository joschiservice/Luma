/**
 * One rendered message. `id` is stable across attempts and is the idempotency key of providers
 * that support one.
 */
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
 * Delivers a message; implementations must bound network time. Resolves with the provider's
 * message ID when it returns one. Throws `MailRateLimited` when the provider refused the request
 * without processing it, and `MailOutcomeUncertain` when a provider without idempotency keys
 * may have accepted it. Any other error means the message was refused, or that a retry with the
 * same `id` cannot send it twice.
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

/**
 * The request may have reached a provider that cannot deduplicate a retry, such as a timeout or
 * a server error after the message was sent. A retry may deliver a second copy.
 */
export class MailOutcomeUncertain extends Error {
  constructor() {
    super('Email provider outcome is unknown');
  }
}
