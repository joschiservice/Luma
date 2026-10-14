import './products.css';

import {
  type CatalogItem,
  type CollectionDensity,
  collectionField,
  productsCatalog,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import {
  DataTable,
  type DataTableColumn,
  type DataTableColumnState,
  DataTableRowLink,
  type DataTableSelection,
  type DataTableSort,
} from '@luma/ui/components/primitives/data-table';
import type { ReactElement, ReactNode } from 'react';

import { listingColumn, productsPresentation } from './collection';
import {
  ListingCell,
  productField,
  type ProductFieldContext,
  ProductFlags,
} from './fields';
import { SourceHeader } from './source-header';

/** Table columns by catalog column ID; the Display menu offers the same IDs. */
const layout: Readonly<
  Record<string, { numeric?: true; hideOnNarrow?: true; width?: number }>
> = {
  sku: { width: 260 },
  title: { hideOnNarrow: true },
  listings: { hideOnNarrow: true },
  differences: { hideOnNarrow: true },
  missing: { hideOnNarrow: true },
  status: { hideOnNarrow: true },
  vendor: { hideOnNarrow: true },
  price: { hideOnNarrow: true },
  updated: { hideOnNarrow: true },
};

function productColumns(
  link: (item: CatalogItem) => ReactElement,
  context: ProductFieldContext,
  extraColumns: readonly DataTableColumn<CatalogItem>[],
): DataTableColumn<CatalogItem>[] {
  const catalog = Object.entries(layout).map(
    ([key, options]): DataTableColumn<CatalogItem> => {
      const field = collectionField(productsCatalog, key);

      return {
        key,
        header: productsPresentation[key]?.label() ?? key,
        ...options,
        ...(field?.sort ? { sortKey: key } : {}),
        filterable: !!field?.filter,
        cell:
          key === 'sku'
            ? (item) => (
                <div className="products-cell">
                  <DataTableRowLink render={link(item)}>
                    {item.sku.trim()}
                  </DataTableRowLink>
                  <small>{item.title ?? m.products_no_title()}</small>
                  <ProductFlags item={item} sources={context.sources} />
                </div>
              )
            : (item) => productField(item, key, context),
      };
    },
  );
  const sources = context.sources.map(
    (source): DataTableColumn<CatalogItem> => ({
      key: listingColumn(source.connectionId),
      header: <SourceHeader source={source} />,
      cell: (item) => (
        <ListingCell item={item} source={source} context={context} />
      ),
    }),
  );

  return [...catalog, ...sources, ...extraColumns];
}

/**
 * Lists SKUs as a table whose columns are Products catalog fields and one column per catalog
 * source with that source's listing, followed by `extraColumns` such as custom fields. The SKU
 * labels each row and carries its comparison state.
 * Sorting reports the catalog field; the caller owns sort state and starts from the first page.
 */
export function ProductsTable({
  caption,
  items,
  context,
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
  extraColumns = [],
}: {
  caption: string;
  items: readonly CatalogItem[];
  context: ProductFieldContext;
  /** The SKU's link, such as a router `<Link>` without children. */
  link: (item: CatalogItem) => ReactElement;
  empty: ReactNode;
  sort?: DataTableSort | undefined;
  onSortChange?: ((sort: DataTableSort) => void) | undefined;
  columnState?: DataTableColumnState | undefined;
  onColumnStateChange?: ((state: DataTableColumnState) => void) | undefined;
  onColumnFilter?: ((key: string) => void) | undefined;
  density?: CollectionDensity | undefined;
  focusedRowKey?: string | undefined;
  selection?: DataTableSelection<CatalogItem> | undefined;
  /** Table columns beyond the catalog's and the sources', such as custom fields. */
  extraColumns?: readonly DataTableColumn<CatalogItem>[] | undefined;
}) {
  return (
    <DataTable
      className="products-list-table"
      caption={caption}
      columns={productColumns(link, context, extraColumns)}
      rows={items}
      rowKey={(item) => item.skuId}
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
