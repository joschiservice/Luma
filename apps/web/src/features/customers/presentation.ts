import type {
  CustomerDetail,
  CustomerListItem,
  CustomerSort,
  CustomerSource,
  CustomerState,
} from '@luma/api-contract';

import { sourceId } from '../sync/presentation';

/** Shopify customer states describe the online store account, not whether someone buys. */
export const stateLabels: Record<CustomerState, string> = {
  enabled: 'Has account',
  disabled: 'No account',
  invited: 'Invited',
  declined: 'Declined invite',
  unknown: 'Not reported',
};

export const stateDescriptions: Record<CustomerState, string> = {
  enabled: 'The customer activated an account in the store.',
  disabled:
    'The customer has no store account, for example after a guest checkout.',
  invited: 'The store invited the customer to create an account.',
  declined: 'The customer declined the store’s account invitation.',
  unknown: 'The source did not report an account state.',
};

export const sortLabels: Record<CustomerSort, string> = {
  created: 'Customer since',
  orders: 'Orders',
  name: 'Name',
};

/**
 * Names a customer by what the source shares: name, then email, then the short source ID.
 * Names never identify a customer across sources.
 */
export function customerName(
  item: Pick<CustomerListItem, 'displayName' | 'email' | 'externalId'>,
) {
  return (
    item.displayName?.trim() ||
    item.email ||
    `Customer ${sourceId(item.externalId)}`
  );
}

/** Formats an address the source shared, one line per part, or null when it has none. */
export function addressLines(address: CustomerDetail['address']) {
  if (!address) return null;
  const locality = [address.postalCode, address.city].filter(Boolean).join(' ');
  const lines = [
    address.line1,
    address.line2,
    locality || null,
    [address.region, address.country].filter(Boolean).join(', ') || null,
  ].filter((line): line is string => !!line);

  return lines.length ? lines : null;
}

/**
 * Explains why a source's customers are missing when the person can fix it by reconnecting.
 * Systems that cannot share customers return null; the source filter already omits them.
 */
export function accessMessage(source: CustomerSource) {
  if (source.access === 'granted') return null;
  if (source.access === 'not_granted')
    return `${source.label} has not granted access to customers. Reconnect it to see its customers here.`;

  return source.system === 'shopify'
    ? `${source.label} was connected before customers were available. Reconnect it to share customers with Luma.`
    : null;
}
