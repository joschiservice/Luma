import { createHash } from 'node:crypto';

import type { SecretCipher } from '@luma/connections';
import { shopHostname, validMac } from '@luma/connector-shopify';
import { IdentityError } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import type { ShopifyAppConfig } from '../application/oauth.js';

const intakeTenant = '00000000-0000-4000-8000-000000000000';
const identifier = z.number().int().positive().safe();
const customer = z
  .object({
    id: identifier.optional(),
    email: z.string().max(320).optional(),
    phone: z.string().max(100).optional(),
  })
  .refine((value) => value.id || value.email || value.phone);
const base = z.object({ shop_id: identifier, shop_domain: shopHostname });
const payloads = {
  'customers/data_request': base.extend({
    customer,
    orders_requested: z.array(identifier),
    data_request: z.object({ id: identifier }),
  }),
  'customers/redact': base.extend({
    customer,
    orders_to_redact: z.array(identifier),
  }),
  'shop/redact': base,
};

/** Verifies compliance deliveries and durably queues encrypted requests for operator fulfillment. */
export function createPrivacyIntake(
  db: TenantDatabase,
  config: ShopifyAppConfig,
  cipher: SecretCipher,
) {
  const app = `${config.environment}:${config.clientId}`;

  return async (
    body: Buffer,
    signature: string,
    shop: string,
    topic: string,
  ) => {
    if (!validMac(config.clientSecret, body, signature, 'base64'))
      throw new IdentityError(
        401,
        'UNAUTHENTICATED',
        'Invalid Shopify signature',
      );
    if (!Object.hasOwn(payloads, topic))
      throw new IdentityError(422, 'CONFLICT', 'Invalid Shopify privacy topic');
    let value: unknown;
    try {
      value = JSON.parse(body.toString('utf8'));
    } catch {
      throw new IdentityError(
        422,
        'CONFLICT',
        'Invalid Shopify privacy request',
      );
    }
    const parsed = payloads[topic as keyof typeof payloads].safeParse(value);
    if (!parsed.success || parsed.data.shop_domain !== shop)
      throw new IdentityError(
        422,
        'CONFLICT',
        'Invalid Shopify privacy request',
      );
    // Bind deduplication to signed bytes, not an unsigned delivery header.
    const eventKey = createHash('sha256')
      .update(topic)
      .update('\0')
      .update(body)
      .digest('hex');
    const binding = JSON.stringify(['shopify-privacy', app, eventKey]);
    const encrypted = cipher.seal(
      { token: 'shopify-privacy', request: parsed.data },
      binding,
    );
    await db.transaction(intakeTenant, async (tx) => {
      await tx.query(
        'INSERT INTO shopify_privacy_requests(tenant_id,app,event_key,topic,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [intakeTenant, app, eventKey, topic, encrypted],
      );
    });
  };
}

/** Accepts the original JSON bytes and verified-delivery headers; resolves only after durable intake. */
export type PrivacyIntake = ReturnType<typeof createPrivacyIntake>;
