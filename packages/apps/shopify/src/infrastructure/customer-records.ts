import { fail, parse } from '@luma/connector-shopify';
import { z } from 'zod';

import type { CustomerSearch, ShopifyRecordRow } from '../domain/records.js';
import { connection, customer } from './record-schemas.js';

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

/** Quotes a literal search value so customer input cannot add Shopify search operators. */
export function customerSearchQuery(search?: CustomerSearch) {
  if (!search) return null;
  const literal = `"${search.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

  return search.field === 'order'
    ? `name:${literal}`
    : search.field === 'email'
      ? `email:${literal}`
      : literal;
}

/** Reads one page of source identities. An order search follows Shopify's explicit customer relation. */
export async function readCustomerPage(
  request: (
    query: string,
    variables: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>,
  fields: string,
  cursor?: string,
  search?: CustomerSearch,
  contactsApproved = false,
) {
  const byOrder = search?.field === 'order';
  const selection = `${fields} ${contactsApproved ? customerContactFields : ''}`;
  const data = await request(
    `query LumaCustomerList($after: String, $query: String) { records: ${byOrder ? 'orders' : 'customers'}(first: 20, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) { nodes { ${byOrder ? `customer { ${selection} }` : selection} } pageInfo { hasNextPage endCursor } } }`,
    { after: cursor ?? null, query: customerSearchQuery(search) },
  );
  const schema = customer.merge(customerContact.omit({ id: true }).partial());
  const page = byOrder
    ? parse(connection(z.object({ customer: schema.nullable() })), data.records)
    : parse(connection(schema), data.records);
  if (
    page.pageInfo.hasNextPage &&
    (!page.pageInfo.endCursor || page.pageInfo.endCursor === cursor)
  )
    fail('invalid_response');
  const identities = new Map<string, ShopifyRecordRow>();
  for (const entry of page.nodes) {
    const value = 'customer' in entry ? entry.customer : entry;
    if (!value) continue;
    const contact = contactsApproved
      ? contactRow(parse(customerContact, value))
      : {
          id: value.id,
          sourceUpdatedAt: null,
          fields: { Name: 'Customer' },
          links: [
            { kind: 'Customer' as const, id: value.id, label: 'Customer' },
          ],
        };
    identities.set(value.id, {
      ...contact,
      sourceUpdatedAt: value.updatedAt,
      fields: {
        ...contact.fields,
        Orders: value.numberOfOrders,
        Spent: `${value.amountSpent.amount} ${value.amountSpent.currencyCode}`,
      },
    });
  }

  return {
    rows: [...identities.values()],
    nextCursor: page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null,
  };
}
