/** Delivers a message once for an idempotency key; implementations must bound network time. */
export interface MailProvider {
  send(message: {
    id: string;
    to: string;
    subject: string;
    text: string;
  }): Promise<void>;
}
