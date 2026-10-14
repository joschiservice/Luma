import type {
  CustomerDetail,
  CustomerListItem,
  CustomerSource,
  CustomerState,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';

import { localizedLabels } from '../../shared/orders/presentation';
import { sourceId } from '../sync/presentation';

/** Shopify customer states describe the online store account, not whether someone buys. */
export const stateLabels: Record<CustomerState, string> = localizedLabels({
  enabled: m.customers_state_enabled,
  disabled: m.customers_state_disabled,
  invited: m.customers_state_invited,
  declined: m.customers_state_declined,
  unknown: m.customers_state_unknown,
});

export const stateDescriptions: Record<CustomerState, string> = localizedLabels(
  {
    enabled: m.customers_state_enabled_description,
    disabled: m.customers_state_disabled_description,
    invited: m.customers_state_invited_description,
    declined: m.customers_state_declined_description,
    unknown: m.customers_state_unknown_description,
  },
);

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
    m.customers_name_fallback({ id: sourceId(item.externalId) })
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
    return m.customers_access_not_granted({ source: source.label });

  return source.system === 'shopify'
    ? m.customers_access_reconnect_shopify({ source: source.label })
    : null;
}
