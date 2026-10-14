import {
  type CollectionDensity,
  collectionField,
  type CollectionGroup,
  type CollectionGrouping,
  type CollectionLayout,
  type ReturnList,
  type ReturnListItem,
  returnsCatalog,
} from '@luma/api-contract';
import {
  formatCurrency,
  formatList,
  formatNumber,
  formatRelativeTime,
} from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Badge } from '@luma/ui/components/primitives/badge';
import { CollectionBoard } from '@luma/ui/components/primitives/collection-board';
import { CollectionGroups } from '@luma/ui/components/primitives/collection-groups';
import { CollectionList } from '@luma/ui/components/primitives/collection-list';
import {
  DataTable,
  type DataTableColumn,
  type DataTableColumnState,
  DataTableRowLink,
  type DataTableSort,
} from '@luma/ui/components/primitives/data-table';
import { StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import type { ReactElement, ReactNode } from 'react';

import { groupId, type GroupMore } from '../../kit/collections/groups';
import { returnsPresentation } from './collection';
import {
  returnField,
  ReturnFlags,
  type ReturnSourceLabel,
  returnSourceLabel,
  returnUnits,
} from './fields';
import {
  nextStep,
  refundSummary,
  returnLabel,
  stageLabels,
  stageStates,
} from './presentation';

/** Everything the Returns results need besides the rows; the page fills it from the view. */
export interface ReturnResultsProps {
  list: ReturnList;
  layout: CollectionLayout;
  density: CollectionDensity;
  grouping: CollectionGrouping | null;
  /** Names the table or list for assistive technology. */
  caption: string;
  link: (item: ReturnListItem) => ReactElement;
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
  /** The return open in the preview. */
  current?: string | undefined;
  selection?:
    | { selected: readonly string[]; onChange: (selected: string[]) => void }
    | undefined;
  groupLabel: (key: CollectionGroup['key']) => string;
  /** Collapsed group IDs, from the member's display settings. */
  collapsed: readonly string[];
  onCollapsedChange: (id: string, collapsed: boolean) => void;
  /** Rows loaded with "Show more" in each group. */
  more?: ((group: CollectionGroup) => GroupMore<ReturnListItem>) | undefined;
}

/** One group with its rows in display order. */
interface ReturnGroup {
  group: CollectionGroup;
  id: string;
  rows: ReturnListItem[];
  more: GroupMore<ReturnListItem> | undefined;
}

const noMore = (): undefined => undefined;

/** Table placement by catalog column ID; the Display menu offers the same IDs. */
const layout: Readonly<
  Record<string, { numeric?: true; hideOnNarrow?: true; width?: number }>
> = {
  name: { width: 240 },
  stage: { width: 240 },
  items: { hideOnNarrow: true },
  refund: {},
  requested: { hideOnNarrow: true },
  activity: { hideOnNarrow: true },
};

function cells(
  list: ReturnList,
  link: (item: ReturnListItem) => ReactElement,
  sourceLabel: ReturnSourceLabel,
): Readonly<Record<string, (item: ReturnListItem) => ReactNode>> {
  const system = (connectionId: string) =>
    list.sources.find((source) => source.connectionId === connectionId)
      ?.system ?? null;
  const now = Date.parse(list.asOf);

  return {
    name: (item) => (
      <div className="returns-cell">
        <DataTableRowLink render={link(item)}>
          {returnLabel(item)}
        </DataTableRowLink>
        <small>
          {item.kind === 'refund'
            ? m.returns_row_refund_context({
                source: sourceLabel(item.connectionId),
              })
            : m.returns_row_order_context({
                order: item.order.displayNumber ?? item.order.id.slice(0, 8),
                source: sourceLabel(item.connectionId),
              })}
        </small>
      </div>
    ),
    stage: (item) => (
      <div className="returns-cell">
        <StatePill state={stageStates[item.stage]}>
          {stageLabels[item.stage]}
        </StatePill>
        <small>{nextStep(item, system(item.connectionId))}</small>
      </div>
    ),
    items: (item) =>
      item.kind === 'refund' ? (
        <span className="returns-muted">{returnUnits(item)}</span>
      ) : (
        <div className="returns-cell">
          <span>{returnUnits(item)}</span>
          <small>
            {item.reasons.length
              ? item.reasons.slice(0, 2).join(', ')
              : m.returns_row_no_reason()}
            {item.reasons.length > 2
              ? ` +${formatNumber(item.reasons.length - 2)}`
              : ''}
          </small>
        </div>
      ),
    refund: (item) => (
      <div className="returns-cell">
        <span
          className={
            item.refund.state === 'refunded' || item.refund.state === 'partial'
              ? 'returns-money'
              : undefined
          }
        >
          {refundSummary(item)}
        </span>
        {item.refund.failedAttempts && item.refund.state !== 'failed' ? (
          <small>
            <Badge tone="danger">
              {m.returns_row_failed_payments({
                count: item.refund.failedAttempts,
              })}
            </Badge>
          </small>
        ) : null}
      </div>
    ),
    requested: (item) =>
      item.requestedAt ? (
        <div className="returns-cell">
          <WorkspaceDate value={item.requestedAt} />
          <small>{formatRelativeTime(item.requestedAt, now)}</small>
        </div>
      ) : (
        <span className="returns-muted">{m.common_not_reported()}</span>
      ),
  };
}

/**
 * Lists returns as a table whose columns are Returns catalog fields; the return's name labels
 * each row, and the stage column says who owns the next step. The caller owns sort state.
 */
function ReturnsTable({
  list,
  caption,
  items,
  link,
  sourceLabel,
  sort,
  onSortChange,
  columnState,
  onColumnStateChange,
  onColumnFilter,
  density,
  focusedRowKey,
  selection,
}: {
  list: ReturnList;
  caption: string;
  items: readonly ReturnListItem[];
  link: (item: ReturnListItem) => ReactElement;
  sourceLabel: ReturnSourceLabel;
  sort?: DataTableSort | undefined;
  onSortChange?: ((sort: DataTableSort) => void) | undefined;
  columnState?: DataTableColumnState | undefined;
  onColumnStateChange?: ((state: DataTableColumnState) => void) | undefined;
  onColumnFilter?: ((key: string) => void) | undefined;
  density: CollectionDensity;
  focusedRowKey?: string | undefined;
  selection?: ReturnResultsProps['selection'];
}) {
  const rich = cells(list, link, sourceLabel);
  const columns: DataTableColumn<ReturnListItem>[] = Object.entries(layout).map(
    ([key, options]) => {
      const field = collectionField(returnsCatalog, key);

      return {
        key,
        header: returnsPresentation[key]?.label() ?? key,
        ...options,
        ...(field?.sort ? { sortKey: key } : {}),
        filterable: !!field?.filter,
        cell: rich[key] ?? ((item) => returnField(item, key, sourceLabel)),
      };
    },
  );

  return (
    <DataTable
      className="returns-list-table"
      caption={caption}
      columns={columns}
      rows={items}
      rowKey={(item) => item.id}
      rowHeader="name"
      empty={null}
      sort={sort}
      onSortChange={onSortChange}
      firstSortDirection="desc"
      columnState={columnState}
      onColumnStateChange={onColumnStateChange}
      onColumnFilter={onColumnFilter}
      density={density}
      focusedRowKey={focusedRowKey}
      selection={
        selection
          ? { ...selection, rowLabel: (item) => returnLabel(item) }
          : undefined
      }
    />
  );
}

/**
 * The groups to show: the list's groups in its order (stages in lifecycle order), with their
 * first rows and any rows "Show more" loaded. With "Show empty groups", choice fields also list
 * their options that matched nothing, in the catalog's order.
 */
export function returnGroups(
  list: ReturnList,
  grouping: CollectionGrouping,
  more: (group: CollectionGroup) => GroupMore<ReturnListItem> | undefined,
): ReturnGroup[] {
  const byId = new Map(list.items.map((item) => [item.id, item]));
  const returned = list.groups ?? [];
  const field = collectionField(returnsCatalog, grouping.field);
  const keys: CollectionGroup['key'][] | undefined = !grouping.showEmpty
    ? undefined
    : field?.type === 'boolean'
      ? [true, false]
      : field?.options
        ? [...field.options]
        : undefined;
  const groups = keys
    ? [
        ...keys.map(
          (key) =>
            returned.find((group) => group.key === key) ?? {
              key,
              count: 0,
              complete: true,
              itemIds: [],
              nextCursor: null,
              sums: [],
            },
        ),
        ...returned.filter((group) => !keys.includes(group.key)),
      ]
    : returned.filter((group) => group.count > 0);

  return groups.map((group) => {
    const extra = more(group);
    const first = group.itemIds.flatMap((id) => {
      const item = byId.get(id);

      return item ? [item] : [];
    });
    const seen = new Set(first.map((item) => item.id));

    return {
      group,
      id: groupId(group.key),
      rows: [
        ...first,
        ...(extra?.rows ?? []).filter((item) => !seen.has(item.id)),
      ],
      more: extra,
    };
  });
}

/** Values of a group's returns, one per currency, such as "Value €1,240.00 · $86.00". */
function sums(group: CollectionGroup) {
  const amounts = group.sums
    .filter((sum) => sum.field === 'value' && sum.currency)
    .map((sum) => {
      const amount = Number(sum.amount);

      return Number.isFinite(amount)
        ? formatCurrency(amount, sum.currency!)
        : `${sum.amount} ${sum.currency}`;
    });

  return amounts.length
    ? m.returns_group_totals({ totals: formatList(amounts) })
    : undefined;
}

function moreButton(group: ReturnGroup) {
  return group.more?.load
    ? {
        onClick: group.more.load,
        pending: group.more.pending,
        ...(group.more.failed
          ? { label: m.collections_group_more_failed() }
          : {}),
      }
    : undefined;
}

/**
 * Shows returns in the view's layout: a table, a list of rows with the chosen properties,
 * grouped sections of either, or a read-only board with one column per group. The store owns
 * each return's stage, so cards never move between columns. Rows come from the server in the
 * view's sort; nothing is sorted or filtered here.
 */
export function ReturnResults(props: ReturnResultsProps) {
  const {
    list,
    layout: shape,
    grouping,
    caption,
    link,
    empty,
    groupLabel,
    collapsed,
    onCollapsedChange,
  } = props;
  const sourceLabel = returnSourceLabel(list.sources);
  const property = (item: ReturnListItem, key: string) =>
    returnField(item, key, sourceLabel);
  const rows = (items: readonly ReturnListItem[], label: string) =>
    shape === 'list' ? (
      <CollectionList
        label={label}
        items={items}
        itemKey={(item) => item.id}
        link={link}
        title={(item) => returnLabel(item)}
        description={(item) =>
          item.kind === 'refund'
            ? m.returns_row_refund_context({
                source: sourceLabel(item.connectionId),
              })
            : m.returns_row_order_context({
                order: item.order.displayNumber ?? item.order.id.slice(0, 8),
                source: sourceLabel(item.connectionId),
              })
        }
        status={(item) => <ReturnFlags item={item} />}
        properties={props.properties}
        property={property}
        density={props.density}
        focusedKey={props.focusedKey}
        current={props.current}
        selection={
          props.selection
            ? { ...props.selection, rowLabel: (item) => returnLabel(item) }
            : undefined
        }
      />
    ) : (
      <ReturnsTable
        list={list}
        caption={label}
        items={items}
        link={link}
        sourceLabel={sourceLabel}
        sort={props.sort}
        onSortChange={props.onSortChange}
        columnState={props.columnState}
        onColumnStateChange={props.onColumnStateChange}
        onColumnFilter={props.onColumnFilter}
        density={props.density}
        focusedRowKey={props.focusedKey}
        selection={props.selection}
      />
    );

  if (!grouping || !list.groups)
    return list.items.length ? <>{rows(list.items, caption)}</> : <>{empty}</>;

  const groups = returnGroups(list, grouping, props.more ?? noMore);
  if (!groups.length) return <>{empty}</>;
  const name = (group: ReturnGroup) => groupLabel(group.group.key);

  return shape === 'board' ? (
    <CollectionBoard
      label={caption}
      columns={groups.map((group) => ({
        key: group.id,
        label: name(group),
        count: group.group.count,
        complete: group.group.complete,
        summary: sums(group.group),
        items: group.rows,
        more: moreButton(group),
      }))}
      itemKey={(item) => item.id}
      link={link}
      title={(item) => returnLabel(item)}
      status={(item) => (
        <ReturnFlags item={item} stage={grouping.field !== 'stage'} />
      )}
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
        summary: sums(group.group),
        content: group.rows.length ? (
          rows(group.rows, `${caption}: ${name(group)}`)
        ) : (
          <p className="returns-muted">{m.returns_group_empty()}</p>
        ),
        more: moreButton(group),
      }))}
    />
  );
}
