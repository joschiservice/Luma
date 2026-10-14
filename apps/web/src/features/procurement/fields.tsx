import type { PurchaseOrderList, SupplierList } from '@luma/api-contract';
import { formatList, formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Badge } from '@luma/ui/components/primitives/badge';
import { StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import type { ReactNode } from 'react';

import { formatMoney } from '../../shared/orders/presentation';
import { attentionLabel, authorityLabel } from './collection';
import {
  calendarDate,
  ownerLabels,
  StagePill,
  statusLabels,
} from './presentation';

export type ListedPurchaseOrder = PurchaseOrderList['items'][number];

export type ListedSupplier = SupplierList['items'][number];

/** Names locations by ID for the purchase-order list's location field. */
export type LocationNames = ReadonlyMap<string, string>;

const empty = () => m.common_empty_value();

/**
 * What needs a response on a purchase order: overdue or the number of open items. Every layout
 * shows this, whatever the Display settings.
 */
export function PurchaseOrderFlags({ order }: { order: ListedPurchaseOrder }) {
  const { summary } = order;
  if (!summary.attention) return null;

  return (
    <Badge tone={summary.overdue ? 'danger' : 'warning'}>
      {summary.overdue
        ? m.procurement_overdue()
        : m.procurement_to_answer({ count: summary.attention })}
    </Badge>
  );
}

/** The order's value, "Mixed or partly priced" when unknown, or a dash without prices. */
function orderValue(order: ListedPurchaseOrder) {
  const value = order.summary.value;
  if (!value) return empty();
  if (value === 'unknown') return m.procurement_value_mixed();

  return formatMoney(value) ?? empty();
}

/**
 * Renders one purchase-order catalog field for table cells, list and board properties and the
 * preview. Missing values show a dash.
 */
export function purchaseOrderField(
  order: ListedPurchaseOrder,
  key: string,
  locations: LocationNames = new Map(),
): ReactNode {
  const { summary } = order;
  switch (key) {
    case 'reference':
      return order.reference;
    case 'number':
      return summary.externalOrderNumber ?? empty();
    case 'supplier':
      return order.supplierName;
    case 'status':
      return statusLabels[order.status]();
    case 'stage':
      return <StagePill stage={summary.stage} />;
    case 'attention':
      return summary.attentionKinds?.length
        ? formatList(summary.attentionKinds.map(attentionLabel))
        : empty();
    case 'expected':
      return summary.expectedDate
        ? calendarDate(summary.expectedDate)
        : empty();
    case 'confirmationDue':
      return summary.confirmationDueAt ? (
        <WorkspaceDate value={summary.confirmationDueAt} />
      ) : (
        empty()
      );
    case 'nextCheck':
      return summary.nextCheckAt ? (
        <WorkspaceDate value={summary.nextCheckAt} />
      ) : (
        empty()
      );
    case 'nextOwner':
      return ownerLabels[summary.nextOwner]();
    case 'lines':
      return formatNumber(order.lines.length);
    case 'created':
      return <WorkspaceDate value={order.createdAt} />;
    case 'updated':
      return <WorkspaceDate value={order.updatedAt} />;
    case 'authority':
      return authorityLabel(order.authority);
    case 'location': {
      const ids = [
        ...new Set(order.lines.flatMap((line) => line.locationId ?? [])),
      ];

      return ids.length
        ? formatList(
            ids.map(
              (id) =>
                locations.get(id) ?? m.procurement_list_location_unnamed(),
            ),
          )
        : empty();
    }
    case 'sku':
      return formatList([...new Set(order.lines.map((line) => line.sku))]);
    case 'value':
      return orderValue(order);
    default:
      return null;
  }
}

/** Renders one supplier catalog field for table cells. */
export function supplierField(
  supplier: ListedSupplier,
  key: string,
): ReactNode {
  switch (key) {
    case 'name':
      return supplier.name;
    case 'link':
      return <SupplierLink supplier={supplier} />;
    case 'references':
      return supplier.externalReferences.length
        ? formatList(
            supplier.externalReferences.map(
              (ref) => `${ref.system} · ${ref.externalId}`,
            ),
          )
        : m.common_none();
    case 'created':
      return <WorkspaceDate value={supplier.createdAt} />;
    case 'orders':
      return formatNumber(supplier.orderCount);
    default:
      return null;
  }
}

/** Shows whether a supplier is linked to its purchasing-system record. */
function SupplierLink({ supplier }: { supplier: ListedSupplier }) {
  return supplier.link ? (
    <StatePill state="verified">
      {supplier.link.name ??
        m.procurement_supplier_external({ id: supplier.link.externalId })}
    </StatePill>
  ) : (
    <span className="procurement-muted">{m.procurement_not_linked()}</span>
  );
}
