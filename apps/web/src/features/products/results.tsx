import {
  type CatalogItem,
  type CollectionDensity,
  collectionField,
  type CollectionGroup,
  type CollectionGrouping,
  type CollectionLayout,
  type ProductList,
  productsCatalog,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { CollectionGroups } from '@luma/ui/components/primitives/collection-groups';
import { CollectionList } from '@luma/ui/components/primitives/collection-list';
import type {
  DataTableColumn,
  DataTableColumnState,
  DataTableSort,
} from '@luma/ui/components/primitives/data-table';
import type { ReactElement, ReactNode } from 'react';

import {
  type GroupMore,
  groupMoreButton,
  type ShownGroup,
  shownGroups,
} from '../../kit/collections/groups';
import { productField, type ProductFieldContext, ProductFlags } from './fields';
import { ProductsTable } from './list-table';

/** Everything the Products results need besides the rows; the page fills it from the view. */
export interface ProductResultsProps {
  list: ProductList;
  layout: CollectionLayout;
  density: CollectionDensity;
  grouping: CollectionGrouping | null;
  /** Names the table or list for assistive technology. */
  caption: string;
  link: (item: CatalogItem) => ReactElement;
  matchLink?: ProductFieldContext['matchLink'];
  /** Shown when nothing matches. */
  empty: ReactNode;
  sort?: DataTableSort | undefined;
  onSortChange?: ((sort: DataTableSort) => void) | undefined;
  columnState?: DataTableColumnState | undefined;
  onColumnStateChange?: ((state: DataTableColumnState) => void) | undefined;
  onColumnFilter?: ((key: string) => void) | undefined;
  /** Properties list rows show, in order. */
  properties: readonly string[];
  focusedKey?: string | undefined;
  /** The SKU open in the preview. */
  current?: string | undefined;
  selection?:
    | { selected: readonly string[]; onChange: (selected: string[]) => void }
    | undefined;
  groupLabel: (key: CollectionGroup['key']) => string;
  /** Collapsed group IDs, from the member's display settings. */
  collapsed: readonly string[];
  onCollapsedChange: (id: string, collapsed: boolean) => void;
  /** Rows loaded with "Show more" in each group. */
  more?: ((group: CollectionGroup) => GroupMore<CatalogItem>) | undefined;
  /** Table columns beyond the catalog's and the sources', such as custom fields. */
  extraColumns?: readonly DataTableColumn<CatalogItem>[];
}

const noMore = (): undefined => undefined;

/**
 * The groups to show, with their first SKUs and SKUs "Show more" loaded. A SKU counts in the
 * group of each vendor, status and differing field its listings report.
 */
export function productGroups(
  list: ProductList,
  grouping: CollectionGrouping,
  more: (group: CollectionGroup) => GroupMore<CatalogItem> | undefined,
): ShownGroup<CatalogItem>[] {
  return shownGroups({
    items: list.items,
    groups: list.groups,
    rowKey: (item) => item.skuId,
    field: collectionField(productsCatalog, grouping.field),
    showEmpty: grouping.showEmpty,
    more,
  });
}

/**
 * Shows SKUs in the view's layout: a table with each source's listing side by side, a list of
 * rows with the chosen properties, or grouped sections of either. Rows come from the server in
 * the view's sort; nothing is sorted or filtered here.
 */
export function ProductResults(props: ProductResultsProps) {
  const {
    list,
    layout,
    grouping,
    caption,
    link,
    empty,
    groupLabel,
    collapsed,
    onCollapsedChange,
  } = props;
  const context: ProductFieldContext = {
    sources: list.sources,
    asOf: list.asOf,
    matchLink: props.matchLink,
  };
  const rowLabel = (item: CatalogItem) => item.sku.trim();
  const rows = (items: readonly CatalogItem[], label: string) =>
    layout === 'list' ? (
      <CollectionList
        label={label}
        items={items}
        itemKey={(item) => item.skuId}
        link={link}
        title={rowLabel}
        description={(item) => item.title ?? m.products_no_title()}
        status={(item) => <ProductFlags item={item} sources={list.sources} />}
        properties={props.properties}
        property={(item, key) => productField(item, key, context)}
        density={props.density}
        focusedKey={props.focusedKey}
        current={props.current}
        selection={
          props.selection ? { ...props.selection, rowLabel } : undefined
        }
      />
    ) : (
      <ProductsTable
        caption={label}
        items={items}
        context={context}
        link={link}
        empty={null}
        sort={props.sort}
        onSortChange={props.onSortChange}
        columnState={props.columnState}
        onColumnStateChange={props.onColumnStateChange}
        onColumnFilter={props.onColumnFilter}
        extraColumns={props.extraColumns}
        density={props.density}
        focusedRowKey={props.focusedKey}
        selection={
          props.selection ? { ...props.selection, rowLabel } : undefined
        }
      />
    );

  if (!grouping || !list.groups)
    return list.items.length ? <>{rows(list.items, caption)}</> : <>{empty}</>;

  const groups = productGroups(list, grouping, props.more ?? noMore);
  if (!groups.length) return <>{empty}</>;
  const name = (group: ShownGroup<CatalogItem>) => groupLabel(group.group.key);

  return (
    <CollectionGroups
      label={caption}
      collapsed={collapsed}
      onCollapsedChange={onCollapsedChange}
      groups={groups.map((group) => ({
        key: group.id,
        label: name(group),
        count: group.group.count,
        complete: group.group.complete,
        content: group.rows.length ? (
          rows(group.rows, `${caption}: ${name(group)}`)
        ) : (
          <p className="products-note">{m.products_group_empty()}</p>
        ),
        more: groupMoreButton(group.more),
      }))}
    />
  );
}
