import { fail } from '@luma/connector-core/transport';

import { validMac } from './oauth.js';

/** Verifies original webhook bytes and the expected shop; rejects invalid signatures or oversized payloads. */
export function verifyWebhook(options: {
  expectedShop: string;
  shop: string;
  secret: string;
  hmac: string;
  eventId: string;
  body: Uint8Array;
}): void {
  if (!options.secret || options.shop !== options.expectedShop)
    fail('authentication');
  if (
    options.body.byteLength > 1024 * 1024 ||
    !options.eventId ||
    options.eventId.length > 256
  )
    fail('invalid_input');
  if (
    !validMac(options.secret, Buffer.from(options.body), options.hmac, 'base64')
  )
    fail('authentication');
}
