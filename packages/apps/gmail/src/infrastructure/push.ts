import type { TenantDatabase } from '@luma/platform';
import { ServiceError, unavailable } from '@luma/platform';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';

import type { GmailConfig, GmailPushConfig } from '../config.js';

/** Google's keys for OIDC tokens, including those Pub/Sub push subscriptions send. */
const googleCertsUrl = 'https://www.googleapis.com/oauth2/v3/certs';

const intakeTenant = '00000000-0000-4000-8000-000000000000';

const claims = z.object({
  email: z.string(),
  email_verified: z.literal(true),
});

const envelope = z.object({
  message: z.object({ data: z.string().max(4096) }),
});

const notification = z.object({
  emailAddress: z.string().min(3).max(320),
  historyId: z.union([
    z.string().regex(/^\d{1,20}$/),
    z.number().int().nonnegative(),
  ]),
});

/**
 * Creates a verifier for Pub/Sub push requests: an RS256 Google OIDC token for the configured
 * audience, issued to the configured service account with a verified email.
 */
export function createPushVerifier(
  config: GmailPushConfig,
  keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(googleCertsUrl)),
) {
  return async (authorization: string | undefined): Promise<boolean> => {
    const token = /^Bearer ([A-Za-z0-9_.-]{1,8192})$/.exec(
      authorization ?? '',
    )?.[1];
    if (!token) return false;
    try {
      const { payload } = await jwtVerify(token, keys, {
        algorithms: ['RS256'],
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: config.audience,
      });
      const parsed = claims.safeParse(payload);

      return (
        parsed.success &&
        parsed.data.email.toLowerCase() === config.serviceAccount
      );
    } catch {
      return false;
    }
  };
}

/**
 * Accepts verified Gmail push notifications and asks the inbox to read the named mailbox soon.
 * Notifications for unknown mailboxes and malformed payloads are acknowledged so Pub/Sub stops
 * redelivering them; scheduled reads still cover every mailbox. Throws 401 for unverified
 * requests and 503 when push is not configured.
 */
export function createPushIntake(
  db: TenantDatabase,
  config: GmailConfig | undefined,
  verify = config?.push ? createPushVerifier(config.push) : undefined,
) {
  const app = config ? `${config.environment}:${config.clientId}` : '';

  return async (authorization: string | undefined, body: unknown) => {
    if (!config?.push || !verify)
      throw unavailable('Gmail push is not configured');
    if (!(await verify(authorization)))
      throw new ServiceError(401, 'UNAUTHENTICATED', 'Invalid push token');
    const message = envelope.safeParse(body);
    if (!message.success) return;
    let data: z.infer<typeof notification>;
    try {
      const parsed = notification.safeParse(
        JSON.parse(
          Buffer.from(message.data.message.data, 'base64').toString('utf8'),
        ),
      );
      if (!parsed.success) return;
      data = parsed.data;
    } catch {
      return;
    }
    await db.transaction(intakeTenant, async (tx) => {
      await tx.query('SELECT gmail_push_hint($1::text,$2::text,$3::text)', [
        app,
        data.emailAddress.toLowerCase(),
        String(data.historyId),
      ]);
    });
  };
}
