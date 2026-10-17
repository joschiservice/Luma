import type { CustomerSnapshot } from '@luma/connections';
import { fail } from '@luma/connector-shopify';

import type { ShopifyConnectorOptions } from './adapter.js';
import type { BulkHistoryPage } from './bulk-history.js';
import { readPageSize } from './read-selections.js';
import {
  pageFields,
  type ReadSession,
  ref,
  type ShopifyRequest,
  statusFrom,
  text,
} from './read-session.js';
import * as s from './schemas.js';

const customerStates: Record<string, CustomerSnapshot['state']> = {
  ENABLED: 'enabled',
  DISABLED: 'disabled',
  INVITED: 'invited',
  DECLINED: 'declined',
};

/**
 * Emits one page of customers, sharing contact and address fields only when approved.
 * Returns the page info of a live read; an export page has no further live page.
 */
export async function readCustomers(
  session: ReadSession,
  {
    options,
    request,
    bulk,
    sorted,
    search,
    after,
    input,
  }: {
    options: Pick<ShopifyConnectorOptions, 'customerAccess'>;
    request: ShopifyRequest;
    bulk: BulkHistoryPage | null;
    sorted: string;
    search: string | null;
    after: string | null;
    input: { limit: number };
  },
) {
  const { capture, emit } = session;
  const capability = 'customers.read';
  const access = options.customerAccess;
  if (!access) fail('unsupported_capability');
  const fields = [
    'id createdAt updatedAt state numberOfOrders amountSpent { amount currencyCode } tags',
    access.contact
      ? 'displayName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber }'
      : '',
    access.address
      ? 'defaultAddress { address1 address2 city province zip countryCodeV2 }'
      : '',
  ].join(' ');
  const data = bulk
    ? {
        page: {
          nodes: bulk.nodes,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }
    : await request(
        `query LumaCustomers($first: Int!, $after: String, $query: String) { page: customers(first: $first, after: $after, query: $query${sorted}) { nodes { ${fields} } ${pageFields} } }`,
        {
          first: readPageSize(capability, input.limit),
          after,
          query: search,
        },
      );
  const customers = capture(s.connection(s.customerNode), data.page);
  for (const customer of customers.nodes) {
    const address = access.address ? customer.defaultAddress : null;
    const money = customer.amountSpent;
    emit('customer', ref(customer.id), customer.updatedAt, {
      displayName: access.contact ? text(customer.displayName) : null,
      email: access.contact
        ? text(customer.defaultEmailAddress?.emailAddress, 320)
        : null,
      phone: access.contact
        ? text(customer.defaultPhoneNumber?.phoneNumber, 100)
        : null,
      address: address
        ? {
            line1: text(address.address1),
            line2: text(address.address2),
            city: text(address.city, 256),
            region: text(address.province, 256),
            postalCode: text(address.zip, 64),
            country: text(address.countryCodeV2, 128),
          }
        : null,
      state: statusFrom(customerStates, customer.state),
      createdAt: customer.createdAt,
      orderCount: customer.numberOfOrders,
      amountSpent:
        /^-?\d{1,14}(\.\d{1,6})?$/.test(money.amount) &&
        /^[A-Z]{3}$/.test(money.currencyCode)
          ? { amount: money.amount, currency: money.currencyCode }
          : null,
      tags: customer.tags
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0 && tag.length <= 255)
        .slice(0, 250),
      shared: { contact: access.contact, address: access.address },
    } satisfies CustomerSnapshot);
  }

  return customers.pageInfo;
}
