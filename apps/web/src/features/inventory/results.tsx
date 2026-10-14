import {
  type CollectionDensity,
  collectionField,
  type CollectionGroup,
  type CollectionGrouping,
  type CollectionLayout,
  inventoryCatalog,
  type InventoryList,
  type StockPosition,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { CollectionGroups } from '@luma/ui/components/primitives/collection-groups';
import { CollectionList } from '@luma/ui/components/primitives/collection-list';
import type {
  DataTableColumnState,
  DataTableSort,
} from '@luma/ui/components/primitives/data-table';
import { unitOfMeasure } from '@luma/ui/lib/units';
import type { ReactElement, ReactNode } from 'react';

import {
  type GroupMore,
  groupMoreButton,
  type ShownGroup,
  shownGroups,
} from '../../kit/collections/groups';
import { inventoryProperty } from './fields';
import { InventoryTable } from './list-table';
import { StockState } from './presentation';

/** Everything the Inventory results need besides the rows; the page fills it from the view. */
export interface InventoryResultsProps {
  list: InventoryList;
  layout: CollectionLayout;
  density: CollectionDensity;
  grouping: CollectionGrouping | null;
  /** Names the table or list for assistive technology. */
  caption: string;
  link: (position: StockPosition) => ReactElement;
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
  /** The position open in the preview. */
  current?: string | undefined;
  selection?:
    | { selected: readonly string[]; onChange: (selected: string[]) => void }
    | undefined;
  groupLabel: (key: CollectionGroup['key']) => string;
  /** Collapsed group IDs, from the member's display settings. */
  collapsed: readonly string[];
  onCollapsedChange: (id: string, collapsed: boolean) => void;
  /** Rows loaded with "Show more" in each group. */
  more?: ((group: CollectionGroup) => GroupMore<StockPosition>) | undefined;
}

const noMore = (): undefined => undefined;

/**
 * The groups to show, with their first positions and positions "Show more" loaded. A position
 * counts in the group of each of its sources; grouping by SKU shows one SKU across locations.
 */
export function inventoryGroups(
  list: InventoryList,
  grouping: CollectionGrouping,
  more: (group: CollectionGroup) => GroupMore<StockPosition> | undefined,
): ShownGroup<StockPosition>[] {
  return shownGroups({
    items: list.items,
    groups: list.groups,
    rowKey: (position) => position.id,
    field: collectionField(inventoryCatalog, grouping.field),
    showEmpty: grouping.showEmpty,
    more,
  });
}

/** Names a position in selection labels: its SKU at its location. */
export function positionLabel(position: StockPosition) {
  return m.inventory_position_label({
    sku: position.sku,
    location: position.location,
  });
}

/**
 * Shows stock positions in the view's layout: a table with each source's quantities side by side,
 * a list of rows with the chosen properties, or grouped sections of either. Rows come from the
 * server in the view's sort; nothing is sorted or filtered here.
 */
export function InventoryResults(props: InventoryResultsProps) {
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
  const rows = (items: readonly StockPosition[], label: string) =>
    layout === 'list' ? (
      <CollectionList
        label={label}
        items={items}
        itemKey={(position) => position.id}
        link={link}
        title={(position) => position.sku}
        description={(position) =>
          `${position.location} · ${unitOfMeasure(position.unit)}`
        }
        status={(position) => <StockState position={position} />}
        properties={props.properties}
        property={(position, key) =>
          inventoryProperty(position, key, list.asOf)
        }
        density={props.density}
        focusedKey={props.focusedKey}
        current={props.current}
        selection={
          props.selection
            ? { ...props.selection, rowLabel: positionLabel }
            : undefined
        }
      />
    ) : (
      <InventoryTable
        caption={label}
        items={items}
        asOf={list.asOf}
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
            ? { ...props.selection, rowLabel: positionLabel }
            : undefined
        }
      />
    );

  if (!grouping || !list.groups)
    return list.items.length ? <>{rows(list.items, caption)}</> : <>{empty}</>;

  const groups = inventoryGroups(list, grouping, props.more ?? noMore);
  if (!groups.length) return <>{empty}</>;
  const name = (group: ShownGroup<StockPosition>) =>
    groupLabel(group.group.key);

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
          <p className="inventory-note">{m.inventory_group_empty()}</p>
        ),
        more: groupMoreButton(group.more),
      }))}
    />
  );
}
