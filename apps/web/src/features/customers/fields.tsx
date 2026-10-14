import type { CustomerListItem, CustomerSource } from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Badge } from '@luma/ui/components/primitives/badge';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import type { ReactNode } from 'react';

import { formatMoney } from '../../shared/orders/presentation';
import { stateLabels } from './presentation';

/** Names a customer's source, from the list's sources. */
export type CustomerSourceLabel = (connectionId: string) => string;

/** Looks up source names in a list's sources, with a generic name for unknown ones. */
export function customerSourceLabel(
  sources: readonly Pick<CustomerSource, 'connectionId' | 'label'>[],
): CustomerSourceLabel {
  return (connectionId) =>
    sources.find((source) => source.connectionId === connectionId)?.label ??
    m.customers_source_fallback();
}

/**
 * What needs attention about a customer: a source that no longer has them. Every layout shows
 * this, whatever the Display settings.
 */
export function CustomerFlags({
  customer,
  sourceLabel,
}: {
  customer: CustomerListItem;
  sourceLabel: CustomerSourceLabel;
}) {
  return customer.missingSince ? (
    <span className="customers-flags">
      <Badge tone="warning">
        {m.customers_gone_badge({ source: sourceLabel(customer.connectionId) })}
      </Badge>
    </span>
  ) : null;
}

const empty = () => (
  <span className="customers-muted">{m.common_empty_value()}</span>
);

const withheld = () => (
  <span className="customers-muted">{m.customers_not_shared()}</span>
);

const yesNo = (value: boolean) => (value ? m.common_yes() : m.common_no());

/**
 * Renders one Customers catalog field of a customer, for table cells, list properties and the
 * preview. Contact fields and the country say "Not shared" when the source withholds them;
 * values a source doesn't report show a dash.
 */
export function customerField(
  customer: CustomerListItem,
  key: string,
  sourceLabel: CustomerSourceLabel,
): ReactNode {
  switch (key) {
    case 'email':
      return customer.shared.contact ? (customer.email ?? empty()) : withheld();
    case 'phone':
      return customer.shared.contact ? (customer.phone ?? empty()) : withheld();
    case 'state':
      return stateLabels[customer.state];
    case 'source':
      return sourceLabel(customer.connectionId);
    case 'created':
      return customer.sourceCreatedAt ? (
        <WorkspaceDate value={customer.sourceCreatedAt} precision="day" />
      ) : (
        <span className="customers-muted">{m.common_not_reported()}</span>
      );
    case 'updated':
      return customer.sourceUpdatedAt ? (
        <WorkspaceDate value={customer.sourceUpdatedAt} />
      ) : (
        empty()
      );
    case 'orders':
      return customer.orderCount === null
        ? empty()
        : formatNumber(customer.orderCount);
    case 'spent':
      return formatMoney(customer.amountSpent) ?? empty();
    case 'tags':
      return customer.tags.length ? (
        <span className="customers-tags">
          {customer.tags.map((tag) => (
            <Badge key={tag}>{tag}</Badge>
          ))}
        </span>
      ) : (
        empty()
      );
    case 'country':
      return customer.shared.address
        ? (customer.country ?? empty())
        : withheld();
    case 'lastOrder':
      return customer.lastOrderAt ? (
        <WorkspaceDate value={customer.lastOrderAt} precision="day" />
      ) : (
        empty()
      );
    case 'missing':
      return yesNo(!!customer.missingSince);
    case 'contactShared':
      return yesNo(customer.shared.contact);
    default:
      return null;
  }
}
