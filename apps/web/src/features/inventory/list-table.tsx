import './inventory.css';

import {
  type CollectionDensity,
  collectionField,
  inventoryCatalog,
  type StockPosition,
} from '@luma/api-contract';
import {
  DataTable,
  type DataTableColumn,
  type DataTableColumnState,
  DataTableRowLink,
  type DataTableSelection,
  type DataTableSort,
} from '@luma/ui/components/primitives/data-table';
import { unitOfMeasure } from '@luma/ui/lib/units';
import type { ReactElement, ReactNode } from 'react';

import { inventoryField, inventoryLabel } from './fields';
import { StockState } from './presentation';

/** Table columns by catalog column ID; the Display menu offers the same IDs. */
const layout: Readonly<
  Record<string, { numeric?: true; hideOnNarrow?: true; width?: number }>
> = {
  sku: { width: 240 },
  location: { hideOnNarrow: true },
  sources: { hideOnNarrow: true },
  onHand: { numeric: true },
  reserved: { numeric: true, hideOnNarrow: true },
  available: { numeric: true },
  incoming: { numeric: true, hideOnNarrow: true },
  differences: { hideOnNarrow: true },
  sync: { hideOnNarrow: true },
};

/** The condition field behind a column: the Sources column filters by source. */
export function inventoryColumnField(key: string) {
  return key === 'sources' ? 'source' : key;
}

function inventoryColumns(
  link: (position: StockPosition) => ReactElement,
  asOf: string,
): DataTableColumn<StockPosition>[] {
  return Object.entries(layout).map(([key, options]) => {
    const field = collectionField(inventoryCatalog, key);
    const filter = collectionField(inventoryCatalog, inventoryColumnField(key));

    return {
      key,
      header: inventoryLabel(key),
      ...options,
      ...(field?.sort ? { sortKey: key } : {}),
      filterable: !!filter?.filter,
      cell:
        key === 'sku'
          ? (position: StockPosition) => (
              <div className="inventory-cell">
                <DataTableRowLink render={link(position)}>
                  {position.sku}
                </DataTableRowLink>
                <small>
                  {position.location} · {unitOfMeasure(position.unit)}
                </small>
                <small>
                  {[
                    ...new Set(position.sources.map((source) => source.label)),
                  ].join(' · ')}
                </small>
                <StockState position={position} />
              </div>
            )
          : (position: StockPosition) => inventoryField(position, key, asOf),
    };
  });
}

/**
 * Lists stock positions as a table whose columns are Inventory catalog fields. The whole row
 * opens the position; each quantity column keeps one line per source. Sorting reports the
 * catalog field; the caller owns sort state and starts from the first page.
 */
export function InventoryTable({
  caption,
  items,
  asOf,
  link,
  empty,
  sort,
  onSortChange,
  columnState,
  onColumnStateChange,
  onColumnFilter,
  density = 'comfortable',
  focusedRowKey,
  selection,
}: {
  caption: string;
  items: readonly StockPosition[];
  asOf: string;
  /** The position's link, such as a router `<Link>` without children. */
  link: (position: StockPosition) => ReactElement;
  empty: ReactNode;
  sort?: DataTableSort | undefined;
  onSortChange?: ((sort: DataTableSort) => void) | undefined;
  columnState?: DataTableColumnState | undefined;
  onColumnStateChange?: ((state: DataTableColumnState) => void) | undefined;
  onColumnFilter?: ((key: string) => void) | undefined;
  density?: CollectionDensity | undefined;
  focusedRowKey?: string | undefined;
  selection?: DataTableSelection<StockPosition> | undefined;
}) {
  return (
    <DataTable
      className="inventory-list-table"
      caption={caption}
      columns={inventoryColumns(link, asOf)}
      rows={items}
      rowKey={(position) => position.id}
      rowHeader="sku"
      empty={empty}
      sort={sort}
      onSortChange={onSortChange}
      firstSortDirection="asc"
      columnState={columnState}
      onColumnStateChange={onColumnStateChange}
      onColumnFilter={onColumnFilter}
      density={density}
      focusedRowKey={focusedRowKey}
      selection={selection}
    />
  );
}
