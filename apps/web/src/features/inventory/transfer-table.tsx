import {
  type CollectionDensity,
  collectionField,
  transfersCatalog,
  type TransferSummary,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import {
  DataTable,
  type DataTableColumn,
  type DataTableColumnState,
  DataTableRowLink,
  type DataTableSort,
} from '@luma/ui/components/primitives/data-table';
import { Link } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';

import { stockQuantity } from './presentation';
import {
  TransferEvidence,
  transferStates as states,
} from './transfer-presentation';

/** How the Transfers list names each catalog field. */
export const transferLabels: Readonly<Record<string, () => string>> = {
  name: m.inventory_transfer_record,
  route: m.inventory_transfer_route,
  source: m.inventory_filter_source,
  requested: m.inventory_transfer_requested,
  shipped: m.inventory_transfer_shipped,
  received: m.inventory_transfer_received,
  unreceived: m.inventory_transfer_unreceived,
  requestedAt: m.inventory_transfer_requested_at,
  updated: m.inventory_transfer_updated,
};

/** A transfer's key in lists: records are per source, so the source is part of it. */
export function transferKey(
  item: Pick<TransferSummary, 'id' | 'connectionId'>,
) {
  return `${item.id}/${item.connectionId}`;
}

function columns(
  link: (item: TransferSummary) => ReactElement,
): DataTableColumn<TransferSummary>[] {
  const quantity = (
    key: 'requested' | 'shipped' | 'received' | 'unreceived',
  ): DataTableColumn<TransferSummary> => ({
    key,
    header: transferLabels[key]!(),
    numeric: true,
    filterable: !!collectionField(transfersCatalog, key)?.filter,
    cell: (item) => stockQuantity(item.facts[key]),
  });

  return [
    {
      key: 'name',
      header: transferLabels.name!(),
      width: 260,
      sortKey: 'name',
      cell: (item) => (
        <div className="inventory-cell">
          <DataTableRowLink render={link(item)}>{item.name}</DataTableRowLink>
          <small>
            {item.label} ·{' '}
            {(states[item.status] ?? m.inventory_transfer_unknown)()}
          </small>
          <TransferEvidence item={item} />
        </div>
      ),
    },
    {
      key: 'route',
      header: transferLabels.route!(),
      hideOnNarrow: true,
      cell: (item) => (
        <span>
          {item.facts.origin ?? m.common_not_reported()} →{' '}
          {item.facts.destination ?? m.common_not_reported()}
        </span>
      ),
    },
    quantity('requested'),
    { ...quantity('shipped'), hideOnNarrow: true },
    { ...quantity('received'), hideOnNarrow: true },
    quantity('unreceived'),
  ];
}

/**
 * Displays bounded stage summaries with meaningful status and evidence labels; the whole row
 * opens the record. Pass `columnState` to make columns configurable, as the Transfers list does.
 */
export function TransferTable({
  organizationId,
  items,
  caption = m.inventory_transfer_title(),
  link,
  empty = null,
  sort,
  onSortChange,
  columnState,
  onColumnStateChange,
  onColumnFilter,
  density,
  focusedRowKey,
}: {
  organizationId: string;
  items: readonly TransferSummary[];
  caption?: string;
  /** The record's link without children; defaults to its page. */
  link?: ((item: TransferSummary) => ReactElement) | undefined;
  empty?: ReactNode;
  sort?: DataTableSort | undefined;
  onSortChange?: ((sort: DataTableSort) => void) | undefined;
  columnState?: DataTableColumnState | undefined;
  onColumnStateChange?: ((state: DataTableColumnState) => void) | undefined;
  onColumnFilter?: ((key: string) => void) | undefined;
  density?: CollectionDensity | undefined;
  focusedRowKey?: string | undefined;
}) {
  const recordLink =
    link ??
    ((item: TransferSummary) => (
      <Link
        to="/app/$organizationId/inventory/transfers/$transferId"
        params={{ organizationId, transferId: item.id }}
        search={{ connectionId: item.connectionId }}
      />
    ));

  return (
    <DataTable
      caption={caption}
      rows={items}
      rowKey={transferKey}
      rowHeader="name"
      columns={columns(recordLink)}
      empty={empty}
      sort={sort}
      onSortChange={onSortChange}
      firstSortDirection="asc"
      columnState={columnState}
      onColumnStateChange={onColumnStateChange}
      onColumnFilter={onColumnFilter}
      density={density}
      focusedRowKey={focusedRowKey}
    />
  );
}
