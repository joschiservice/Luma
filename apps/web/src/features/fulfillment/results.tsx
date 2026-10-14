import {
  type CollectionDensity,
  collectionField,
  type CollectionGroup,
  type CollectionGrouping,
  type CollectionLayout,
  fulfillmentCatalog,
  type FulfillmentItem,
  type FulfillmentList,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { CollectionBoard } from '@luma/ui/components/primitives/collection-board';
import { CollectionGroups } from '@luma/ui/components/primitives/collection-groups';
import { CollectionList } from '@luma/ui/components/primitives/collection-list';
import type {
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
import { fulfillmentField, FulfillmentFlags } from './fields';
import { FulfillmentTable } from './list-table';
import { orderLabel } from './presentation';

/** Everything the Fulfillment results need besides the rows; the page fills it from the view. */
export interface FulfillmentResultsProps {
  list: FulfillmentList;
  layout: CollectionLayout;
  density: CollectionDensity;
  grouping: CollectionGrouping | null;
  /** Names the table or list for assistive technology. */
  caption: string;
  link: (item: FulfillmentItem) => ReactElement;
  /** Shown when nothing matches. */
  empty: ReactNode;
  sort?: DataTableSort | undefined;
  onSortChange?: ((sort: DataTableSort) => void) | undefined;
  columnState?: DataTableColumnState | undefined;
  onColumnStateChange?: ((state: DataTableColumnState) => void) | undefined;
  onColumnFilter?: ((key: string) => void) | undefined;
  /** Properties list rows and board cards show, in order. */
  properties: readonly string[];
  focusedKey?: string | undefined;
  /** The fulfillment open in the preview. */
  current?: string | undefined;
  selection?:
    | { selected: readonly string[]; onChange: (selected: string[]) => void }
    | undefined;
  groupLabel: (key: CollectionGroup['key']) => string;
  /** Collapsed group IDs, from the member's display settings. */
  collapsed: readonly string[];
  onCollapsedChange: (id: string, collapsed: boolean) => void;
  /** Rows loaded with "Show more" in each group. */
  more?: ((group: CollectionGroup) => GroupMore<FulfillmentItem>) | undefined;
}

const noMore = (): undefined => undefined;

/** The groups to show, with their first rows and rows "Show more" loaded. */
export function fulfillmentGroups(
  list: FulfillmentList,
  grouping: CollectionGrouping,
  more: (group: CollectionGroup) => GroupMore<FulfillmentItem> | undefined,
): ShownGroup<FulfillmentItem>[] {
  return shownGroups({
    items: list.items,
    groups: list.groups,
    rowKey: (item) => item.id,
    field: collectionField(fulfillmentCatalog, grouping.field),
    showEmpty: grouping.showEmpty,
    more,
  });
}

/**
 * Shows fulfillments in the view's layout: a table, a list of rows with the chosen properties,
 * grouped sections of either, or a read-only board with one column per group, such as each
 * shipping stage. Sources own the stage, so cards can't be moved. Rows come from the server in
 * the view's sort; nothing is sorted or filtered here.
 */
export function FulfillmentResults(props: FulfillmentResultsProps) {
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
  const context = { sources: list.sources, asOf: list.asOf };
  const property = (item: FulfillmentItem, key: string) =>
    fulfillmentField(item, key, context);
  const rows = (items: readonly FulfillmentItem[], label: string) =>
    layout === 'list' ? (
      <CollectionList
        label={label}
        items={items}
        itemKey={(item) => item.id}
        link={link}
        title={(item) => orderLabel(item)}
        status={(item) => <FulfillmentFlags item={item} />}
        properties={props.properties}
        property={property}
        density={props.density}
        focusedKey={props.focusedKey}
        current={props.current}
        selection={
          props.selection
            ? { ...props.selection, rowLabel: (item) => orderLabel(item) }
            : undefined
        }
      />
    ) : (
      <FulfillmentTable
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
        density={props.density}
        focusedRowKey={props.focusedKey}
        selection={
          props.selection
            ? { ...props.selection, rowLabel: (item) => orderLabel(item) }
            : undefined
        }
      />
    );

  if (!grouping || !list.groups)
    return list.items.length ? <>{rows(list.items, caption)}</> : <>{empty}</>;

  const groups = fulfillmentGroups(list, grouping, props.more ?? noMore);
  if (!groups.length) return <>{empty}</>;
  const name = (group: ShownGroup<FulfillmentItem>) =>
    groupLabel(group.group.key);

  return layout === 'board' ? (
    <CollectionBoard
      label={caption}
      columns={groups.map((group) => ({
        key: group.id,
        label: name(group),
        count: group.group.count,
        complete: group.group.complete,
        items: group.rows,
        more: groupMoreButton(group.more),
      }))}
      itemKey={(item) => item.id}
      link={link}
      title={(item) => orderLabel(item)}
      status={(item) => <FulfillmentFlags item={item} />}
      properties={props.properties}
      property={property}
      focusedKey={props.focusedKey}
      current={props.current}
    />
  ) : (
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
          <p className="fulfillment-note">{m.fulfillment_group_empty()}</p>
        ),
        more: groupMoreButton(group.more),
      }))}
    />
  );
}
