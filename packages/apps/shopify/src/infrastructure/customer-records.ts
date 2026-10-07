import { z } from 'zod';

import type { ShopifyRecordRow } from '../domain/records.js';

export const customerContactFields =
  'id displayName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber }';

export const customerContact = z.object({
  id: z.string().regex(/^gid:\/\/shopify\/Customer\/[0-9]+$/),
  displayName: z.string(),
  defaultEmailAddress: z.object({ emailAddress: z.string() }).nullable(),
  defaultPhoneNumber: z.object({ phoneNumber: z.string() }).nullable(),
});

/** Maps only the requested customer contact fields; other provider fields never leave the adapter. */
export function contactRow(
  value: z.infer<typeof customerContact>,
): ShopifyRecordRow {
  return {
    id: value.id,
    sourceUpdatedAt: null,
    fields: {
      Name: value.displayName,
      Email: value.defaultEmailAddress?.emailAddress ?? null,
      Phone: value.defaultPhoneNumber?.phoneNumber ?? null,
    },
    links: [
      {
        kind: 'Customer',
        id: value.id,
        label: value.displayName || 'Customer',
      },
    ],
  };
}
