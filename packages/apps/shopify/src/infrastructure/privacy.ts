import { createHash } from 'node:crypto';

import type { SecretCipher } from '@luma/connections';
import { shopHostname, validMac } from '@luma/connector-shopify';
import type { TenantDatabase } from '@luma/platform';
import { ServiceError } from '@luma/platform';
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

/**
 * Verifies compliance deliveries and durably queues encrypted requests for operator
 * fulfillment. Redaction requests also erase imported customer profiles, order addresses and
 * the customer's inbox data, including messages to or from the signed email address, in the
 * same transaction.
 */
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
      throw new ServiceError(
        401,
        'UNAUTHENTICATED',
        'Invalid Shopify signature',
      );
    if (!Object.hasOwn(payloads, topic))
      throw new ServiceError(422, 'CONFLICT', 'Invalid Shopify privacy topic');
    let value: unknown;
    try {
      value = JSON.parse(body.toString('utf8'));
    } catch {
      throw new ServiceError(
        422,
        'CONFLICT',
        'Invalid Shopify privacy request',
      );
    }
    const parsed = payloads[topic as keyof typeof payloads].safeParse(value);
    if (!parsed.success || parsed.data.shop_domain !== shop)
      throw new ServiceError(
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
      // Imported customer profiles, order addresses and the customer's inbox data are erased
      // with the intake and recorded in each workspace's Activity; other retained data still
      // follows the operator workflow.
      const request = parsed.data as {
        customer?: { id?: number; email?: string };
        orders_to_redact?: number[];
      };
      const orders = (request.orders_to_redact ?? []).map(
        (id) => `gid://shopify/Order/${id}`,
      );
      const email = request.customer?.email?.trim().toLowerCase();
      if (
        topic === 'shop/redact' ||
        (topic === 'customers/redact' &&
          (request.customer?.id || email || orders.length))
      )
        await tx.query(
          // The request digest keys each workspace's Activity entry, so a redelivery records one.
          'SELECT erase_shopify_customer_data($1::text,$2::text,$3::text[],$4::text[],$5::text[],$6::text)',
          topic === 'shop/redact'
            ? [app, shop, null, null, null, eventKey]
            : [
                app,
                shop,
                // An empty list erases no customer; null would erase every customer.
                request.customer?.id
                  ? [`gid://shopify/Customer/${request.customer.id}`]
                  : [],
                orders,
                // The signed email also reaches inbox data no stored profile links to.
                email ? [email] : [],
                eventKey,
              ],
        );
      // Uninstalled connections of the shop are queued for removal by the sync process.
      if (topic === 'shop/redact')
        await tx.query('SELECT erase_shopify_shop_data($1::text,$2::text)', [
          app,
          shop,
        ]);
    });
  };
}
