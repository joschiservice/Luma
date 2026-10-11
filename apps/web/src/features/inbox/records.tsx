import type { RecordRef } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { DomainIcon } from '@luma/ui/components/primitives/domain-icon';
import { Link } from '@tanstack/react-router';

import { recordDomains, recordKindLabels } from './presentation';

/** Names a linked record, such as "Order #1042", or says it can't be read. */
export function recordName(record: RecordRef) {
  return m.messaging_record_named({
    kind: recordKindLabels[record.kind](),
    label: record.label ?? m.messaging_record_unreadable(),
  });
}

/**
 * Links to a linked record's page. Records the reader can't read (`label` null) are shown as
 * text, so the link never leads to an access error.
 */
export function RecordLink({
  organizationId,
  record,
  compact = false,
  plain = false,
}: {
  organizationId: string;
  record: RecordRef;
  /** Shows only the label with the domain tile, for list rows. */
  compact?: boolean;
  /** Renders text without a link, for use inside another link such as a list row. */
  plain?: boolean;
}) {
  const text = compact
    ? (record.label ?? m.messaging_record_unreadable())
    : recordName(record);
  const content = (
    <>
      <DomainIcon domain={recordDomains[record.kind]} size="sm" />
      <span>{text}</span>
    </>
  );
  const props = {
    className: 'messaging-record',
    title: recordName(record),
  };
  if (plain || record.label === null) return <span {...props}>{content}</span>;

  switch (record.kind) {
    case 'order':
      return (
        <Link
          {...props}
          to="/app/$organizationId/orders/$orderId"
          params={{ organizationId, orderId: record.id }}
        >
          {content}
        </Link>
      );
    case 'customer':
      return (
        <Link
          {...props}
          to="/app/$organizationId/customers/$customerId"
          params={{ organizationId, customerId: record.id }}
        >
          {content}
        </Link>
      );
    case 'supplier':
      return (
        <Link
          {...props}
          to="/app/$organizationId/procurement/suppliers/$supplierId"
          params={{ organizationId, supplierId: record.id }}
        >
          {content}
        </Link>
      );
    case 'purchase_order':
      return (
        <Link
          {...props}
          to="/app/$organizationId/procurement/$purchaseOrderId"
          params={{ organizationId, purchaseOrderId: record.id }}
        >
          {content}
        </Link>
      );
    case 'case':
      return (
        <Link
          {...props}
          to="/app/$organizationId/exceptions/$exceptionId"
          params={{ organizationId, exceptionId: record.id }}
          search={{ view: 'needs_you' }}
        >
          {content}
        </Link>
      );
  }
}
