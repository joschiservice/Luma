import {
  type CaseSummary,
  type CollectionDensity,
  collectionField,
  type CollectionGroup,
  type CollectionGrouping,
  type CollectionLayout,
  issuesCatalog,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import {
  caseSummaryText,
  issueStatus,
} from '@luma/ui/components/issues/case-presentation';
import { CollectionBoard } from '@luma/ui/components/primitives/collection-board';
import { CollectionGroups } from '@luma/ui/components/primitives/collection-groups';
import { StatePill } from '@luma/ui/components/primitives/state';
import type { ReactElement, ReactNode } from 'react';

import {
  type GroupMore,
  groupMoreButton,
  type ShownGroup,
  shownGroups,
} from '../../kit/collections/groups';
import { IssueList, issueProperty } from './issue-list';

/** Everything the issue results need besides the rows; the page fills it from the view. */
export interface IssueResultsProps {
  items: readonly CaseSummary[];
  groups: readonly CollectionGroup[] | undefined;
  layout: CollectionLayout;
  density: CollectionDensity;
  grouping: CollectionGrouping | null;
  /** Names the list or board for assistive technology. */
  caption: string;
  link: (item: CaseSummary) => ReactElement;
  empty: ReactNode;
  properties: readonly string[];
  focusedKey?: string | undefined;
  /** The issue open beside the list. */
  current?: string | undefined;
  groupLabel: (key: CollectionGroup['key']) => string;
  /** Collapsed group IDs, from the member's display settings. */
  collapsed: readonly string[];
  onCollapsedChange: (id: string, collapsed: boolean) => void;
  /** Rows loaded with "Show more" in each group. */
  more: (group: CollectionGroup) => GroupMore<CaseSummary> | undefined;
}

/** The groups the issue list shows, with their first rows and rows "Show more" loaded. */
export function issueGroups(
  props: Pick<IssueResultsProps, 'items' | 'groups' | 'grouping' | 'more'>,
): ShownGroup<CaseSummary>[] {
  if (!props.grouping || !props.groups) return [];

  return shownGroups({
    items: props.items,
    groups: props.groups,
    rowKey: (item) => item.id,
    field: collectionField(issuesCatalog, props.grouping.field),
    showEmpty: props.grouping.showEmpty,
    more: props.more,
  });
}

/**
 * Shows issues as a list, grouped sections of the list, or a read-only board with one column per
 * group. Issues change state only through verification and dispositions, so cards never move.
 * Rows come from the server in the view's sort; nothing is sorted or filtered here.
 */
export function IssueResults(props: IssueResultsProps) {
  const { items, grouping, caption, link, empty, groupLabel } = props;
  const rows = (shown: readonly CaseSummary[], label?: string) => (
    <IssueList
      label={label}
      items={shown}
      link={link}
      properties={props.properties}
      density={props.density}
      current={props.current}
      focusedKey={props.focusedKey}
      empty={empty}
    />
  );

  if (!grouping || !props.groups) return rows(items);

  const groups = issueGroups(props);
  if (!groups.length) return <>{empty}</>;

  return props.layout === 'board' ? (
    <>
      <p className="issue-board-note">{m.exceptions_board_note()}</p>
      <CollectionBoard
        label={caption}
        columns={groups.map((group) => ({
          key: group.id,
          label: groupLabel(group.group.key),
          count: group.group.count,
          complete: group.group.complete,
          items: group.rows,
          more: groupMoreButton(group.more),
        }))}
        itemKey={(item) => item.id}
        link={link}
        title={(item) => caseSummaryText(item.summary).replace(/\.+$/, '')}
        status={(item) => {
          if (grouping.field === 'state') return null;
          const status = issueStatus(item);

          return <StatePill state={status.state}>{status.label}</StatePill>;
        }}
        properties={props.properties.filter((key) => key !== grouping.field)}
        property={issueProperty}
        focusedKey={props.focusedKey}
        current={props.current}
      />
    </>
  ) : (
    <CollectionGroups
      label={caption}
      collapsed={props.collapsed}
      onCollapsedChange={props.onCollapsedChange}
      groups={groups.map((group) => {
        const label = groupLabel(group.group.key);

        return {
          key: group.id,
          label,
          count: group.group.count,
          complete: group.group.complete,
          content: group.rows.length ? (
            rows(group.rows, `${caption}: ${label}`)
          ) : (
            <p className="issue-group-empty">{m.exceptions_group_empty()}</p>
          ),
          more: groupMoreButton(group.more),
        };
      })}
    />
  );
}
