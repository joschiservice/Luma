import { ServiceError } from '@luma/platform';
import type { Pool } from 'pg';
import { Resend } from 'resend';

const statuses = {
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'delayed',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
} as const;

/** The signature headers Resend sends with each webhook request. */
export interface MailEventSignature {
  id: string;
  timestamp: string;
  signature: string;
}

/**
 * Receives Resend delivery events. Each request must carry a valid signature for the
 * configured secret, or it is refused with 401 before anything is read. Events count only for
 * messages this deployment sent. A permanent bounce or a spam complaint suppresses optional
 * notifications to the account with that address; a later delivery to it lifts the
 * suppression. Repeated or reordered events leave the same result.
 */
export function createMailEvents(
  pool: Pool,
  settings: { apiKey: string; webhookSecret: string },
) {
  const webhooks = new Resend(settings.apiKey).webhooks;

  return {
    async receive(payload: string, headers: MailEventSignature) {
      let event: ReturnType<typeof webhooks.verify>;
      try {
        event = webhooks.verify({
          payload,
          headers,
          webhookSecret: settings.webhookSecret,
        });
      } catch {
        throw new ServiceError(
          401,
          'UNAUTHENTICATED',
          'Invalid webhook signature',
        );
      }
      if (!(event.type in statuses) || !('email_id' in event.data)) return;
      const status = statuses[event.type as keyof typeof statuses];
      const receipt = await pool.query(
        'UPDATE mail_receipts SET status=$2,updated_at=now() WHERE provider_id=$1',
        [event.data.email_id, status],
      );
      if (!receipt.rowCount) return;
      const addresses = event.data.to.map((address) => address.toLowerCase());
      if (status === 'delivered')
        await pool.query(
          'DELETE FROM mail_suppressions s USING users u WHERE s.user_id=u.id AND lower(u.email)=ANY($1) AND s.recorded_at<$2',
          [addresses, new Date(event.created_at)],
        );
      else if (
        status === 'complained' ||
        (status === 'bounced' &&
          'bounce' in event.data &&
          event.data.bounce.type === 'Permanent')
      )
        await pool.query(
          `INSERT INTO mail_suppressions(user_id,email,reason,recorded_at)
           SELECT id,email,$2,$3 FROM users WHERE lower(email)=ANY($1)
           ON CONFLICT (user_id) DO UPDATE SET email=EXCLUDED.email,reason=EXCLUDED.reason,recorded_at=GREATEST(mail_suppressions.recorded_at,EXCLUDED.recorded_at)`,
          [addresses, status, new Date(event.created_at)],
        );
    },
  };
}
