import './decisions.css';
import '../workflows/workflows.css';

import {
  type CollectionGroup,
  type CollectionGrouping,
  collectionWhereIssues,
  type DecisionItem,
  type DecisionList,
  decisionsCatalog,
  type DecisionView,
} from '@luma/api-contract';
import { formatList, formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { CaseNotice } from '@luma/ui/components/issues/case-investigation';
import { elapsed } from '@luma/ui/components/issues/case-presentation';
import { IssueSplitView } from '@luma/ui/components/issues/issue-split-view';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { CollectionGroups } from '@luma/ui/components/primitives/collection-groups';
import {
  CollectionList,
  type CollectionListDensity,
} from '@luma/ui/components/primitives/collection-list';
import {
  type CollectionConditions,
  type CollectionFilter,
  type CollectionSort,
  CollectionToolbar,
} from '@luma/ui/components/primitives/collection-toolbar';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { DomainIcon } from '@luma/ui/components/primitives/domain-icon';
import { Empty } from '@luma/ui/components/primitives/empty';
import { Pagination } from '@luma/ui/components/primitives/pagination';
import {
  listShortcutGroup,
  ShortcutHelp,
} from '@luma/ui/components/primitives/shortcut-help';
import { StatePill } from '@luma/ui/components/primitives/state';
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from '@luma/ui/components/primitives/tabs';
import {
  formatWorkspaceInstant,
  WorkspaceTimezone,
} from '@luma/ui/components/primitives/workspace-date';
import { useListKeyboard } from '@luma/ui/lib/list-keyboard';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { type ReactNode, useContext, useRef, useState } from 'react';

import { useCollectionControls } from '../../kit/collections/controls';
import { DescribedFilter } from '../../kit/collections/described-filter';
import type { CatalogPresentation } from '../../kit/collections/fields';
import {
  collectionGroupLabel,
  groupMoreButton,
  type ShownGroup,
  shownGroups,
  useGroupPages,
} from '../../kit/collections/groups';
import { CollectionNotices } from '../../kit/collections/notices';
import {
  type CollectionError,
  collectionError,
  collectionServerIssue,
  useCursorPaging,
  useOnline,
} from '../../kit/collections/paging';
import { usePrivateSearch } from '../../kit/collections/private-search';
import { repairedState } from '../../kit/collections/repair';
import {
  type CollectionSearch,
  groupOf,
  viewParam,
} from '../../kit/collections/state';
import {
  type CollectionView,
  useCollectionView,
} from '../../kit/collections/use-collection-view';
import { CollectionViewBar } from '../../kit/collections/view-bar';
import { SignInRedirect } from '../../kit/identity/common';
import { ApiError, contextOptions } from '../../kit/identity/data';
import { usePermissions } from '../../kit/identity/permissions';
import { useNow } from '../../kit/live/now';
import { membersOptions } from '../../kit/settings/data';
import {
  assignDecision,
  decisionFilters,
  decisionListQuery,
  decisionOptions,
  decisionPageSize,
  decisionsKey,
  decisionsOptions,
  decisionsRefresh,
  decisionView,
  defaultDecisionSort,
  type NeedsYouSearch,
} from './data';
import { DecisionDeadline, DecisionInspector, type Member } from './inspector';
import { useDecisionUpdatesState } from './live';
import { OwnerReview } from './owner-review';
import {
  actionable,
  decisionStatus,
  domainIcons,
  domainLabels,
  emptyCopy,
  impactLabels,
  kindLabels,
  localizeReturnDecision,
  memberName,
  reasonLabels,
  viewLabels,
} from './presentation';

const views: DecisionView[] = ['all', 'mine', 'unassigned'];

/** Row properties a view without its own shows. */
const decisionProperties = [
  'kind',
  'owner',
  'impact',
  'deadline',
  'requested',
] as const;

/** Properties shown in the row's second line rather than in columns. */
const inlineProperties = new Set(['kind', 'domain', 'reason', 'owner']);

const option =
  (labels: Readonly<Record<string, () => string>>) => (value: string) =>
    labels[value]?.() ?? value;

/** Names the queue's catalog fields and options in filters, sorts, groups and Display. */
const decisionPresentation: CatalogPresentation = {
  title: { label: m.decisions_field_title },
  urgency: { label: m.decisions_field_urgency },
  kind: { label: m.decisions_field_kind, option: option(kindLabels) },
  domain: { label: m.decisions_filter_area, option: option(domainLabels) },
  reason: { label: m.decisions_filter_reason, option: option(reasonLabels) },
  owner: { label: m.decisions_owner_label },
  cause: { label: m.decisions_field_cause },
  requested: { label: m.decisions_field_waiting_since },
  deadline: { label: m.decisions_deadline_label },
  impact: { label: m.decisions_impact_label, option: option(impactLabels) },
};

/** The list commands Needs you handles, for shortcut help. */
const shortcuts = [
  'next',
  'previous',
  'open',
  'preview',
  'escape',
  'search',
  'filter',
  'help',
] as const;

const sameSort = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

/**
 * The view as Needs you shows it: a view without its own sort uses the queue's urgency, and
 * choosing urgency again keeps the view unchanged rather than marking it Modified.
 */
function queueView(view: CollectionView): CollectionView {
  return {
    ...view,
    state: {
      ...view.state,
      sort: view.state.sort ?? defaultDecisionSort,
      layout: 'list',
    },
    change: (next) =>
      view.change({
        ...next,
        layout: 'list',
        sort:
          !view.base.sort && sameSort(next.sort, defaultDecisionSort)
            ? null
            : next.sort,
      }),
  };
}

/**
 * Names one group of Needs you: an area, reason or owner, or a cause by the label its decisions
 * carry. Decisions without an owner form the Unassigned group.
 */
export function decisionGroupLabel(
  field: string,
  key: CollectionGroup['key'],
  context: {
    items: readonly DecisionItem[];
    members: readonly Member[];
    self: string | undefined;
  },
) {
  if (field === 'owner')
    return typeof key === 'string'
      ? (memberName(key, context.members, context.self) ?? key)
      : m.decisions_owner_none();
  if (field === 'cause' && typeof key === 'string')
    return (
      context.items.find((item) => item.group.key === key)?.group.label ?? key
    );

  return collectionGroupLabel({
    presentation: decisionPresentation,
    field,
    granularity: undefined,
    key,
  });
}

function DecisionTime({
  item,
  now,
}: {
  item: DecisionItem;
  now: number | undefined;
}) {
  const timeZone = useContext(WorkspaceTimezone);
  const clock = useNow();

  return (
    <span
      className="case-row-time"
      title={formatWorkspaceInstant(item.requestedAt, timeZone)}
    >
      <time dateTime={item.requestedAt}>
        {elapsed(item.requestedAt, now ?? clock)}
      </time>
    </span>
  );
}

/** Renders one decision property; the row's second line takes kind, area, reason and owner. */
function decisionProperty(
  item: DecisionItem,
  key: string,
  context: {
    now: number | undefined;
    members: readonly Member[];
    self: string | undefined;
  },
): ReactNode {
  switch (key) {
    case 'kind':
      return kindLabels[item.kind]();
    case 'domain':
      return domainLabels[item.domain]();
    case 'reason':
      return reasonLabels[item.reason]();
    case 'owner': {
      const assignee = memberName(
        item.assignment?.assigneeId,
        context.members,
        context.self,
      );

      return assignee
        ? m.decisions_owner_row({ name: assignee })
        : m.decisions_owner_none();
    }
    case 'impact':
      return (
        <span
          className="issue-severity"
          data-severity={item.impact.level === 'high' ? 'high' : undefined}
        >
          {impactLabels[item.impact.level]()}
        </span>
      );
    case 'deadline':
      return item.deadline ? (
        <span className="case-row-time">
          <DecisionDeadline deadline={item.deadline} now={context.now} />
        </span>
      ) : null;
    case 'requested':
      return <DecisionTime item={item} now={context.now} />;
    default:
      return null;
  }
}

/** The toolbar controls Needs you shows beside its views; stories may leave them out. */
export interface NeedsYouControls {
  /** Search text, which stays in page state because titles can name people. */
  query?: { value: string; onChange: (text: string) => void } | undefined;
  filters?: readonly CollectionFilter[] | undefined;
  conditions?: CollectionConditions | undefined;
  sort?: CollectionSort | undefined;
  /** Page actions, such as describing a filter. */
  actions?: ReactNode;
  /** Clears search and every condition. */
  onClear?: (() => void) | undefined;
}

/** The queue's grouping and the groups the page shows. */
export interface NeedsYouGrouping {
  grouping: CollectionGrouping;
  groups: readonly ShownGroup<DecisionItem>[];
  label: (key: CollectionGroup['key']) => string;
  collapsed: readonly string[];
  onCollapsedChange: (id: string, collapsed: boolean) => void;
}

/**
 * Presents the Needs you queue: views, search, filters, conditions, sort, grouped rows,
 * pagination and the selected decision. J and K move through the rows, Space opens or closes the
 * focused decision, / focuses search, F opens the condition builder and Escape closes the
 * decision. It owns no fetching, so stories and the page share the same states.
 */
export function NeedsYouView({
  organizationId,
  search,
  segment = decisionView(search.view),
  savedView = false,
  viewBar,
  display,
  controls = {},
  filtered = false,
  notices,
  waiting,
  grouped,
  properties = decisionProperties,
  density = 'comfortable',
  onOpenView,
  list,
  loading = false,
  refreshing = false,
  error,
  offline = false,
  page,
  onPrevious,
  onNext,
  onFirst,
  onChange,
  onRefresh,
  now,
  members = [],
  self,
  selected,
  inspector,
}: {
  organizationId: string;
  search: NeedsYouSearch;
  /** The queue the list shows; a saved view reads its own. */
  segment?: DecisionView | undefined;
  /** A saved view is open, so no built-in view tab is current. */
  savedView?: boolean | undefined;
  /** The view bar with built-in and saved views; without it the built-in views are plain tabs. */
  viewBar?: ReactNode;
  /** The Display menu. */
  display?: ReactNode;
  controls?: NeedsYouControls | undefined;
  /** Search or conditions narrow the queue, so an empty list says nothing matches. */
  filtered?: boolean | undefined;
  /** Paging, repair and similar notices above the rows. */
  notices?: ReactNode;
  waiting?: ReactNode;
  /** Groups to show instead of a flat list. */
  grouped?: NeedsYouGrouping | undefined;
  /** Row properties in display order. */
  properties?: readonly string[] | undefined;
  density?: CollectionListDensity | undefined;
  /** Opens a built-in view; without it the view tabs are plain links. */
  onOpenView?: ((view: DecisionView) => void) | undefined;
  /** The current page, or the last page read before a failed refresh. */
  list?: DecisionList | undefined;
  loading?: boolean;
  refreshing?: boolean;
  error?: string | undefined;
  offline?: boolean;
  page?: number | undefined;
  onPrevious?: (() => void) | undefined;
  onNext: () => void;
  /** Returns to the first page when the way back to the previous one is unknown. */
  onFirst?: (() => void) | undefined;
  /** Opens or closes a decision. */
  onChange: (search: NeedsYouSearch) => void;
  onRefresh: () => void;
  /** A fixed time for relative times and deadlines; the shared clock by default. */
  now?: number | undefined;
  members?: readonly Member[];
  self?: string | undefined;
  /** The open decision, `loading` while resolving a direct link, or `missing`. */
  selected?: DecisionItem | 'loading' | 'missing' | undefined;
  inspector?: ReactNode;
}) {
  const listPane = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [help, setHelp] = useState(false);
  const items = (list?.items ?? []).map(localizeReturnDecision);
  const localized = new Map(items.map((item) => [item.id, item]));
  const groups = grouped?.groups.map((group) => ({
    ...group,
    rows: group.rows.map((row) => localized.get(row.id) ?? row),
  }));
  // Keys follow the order rows appear in, which grouping changes.
  const ordered = groups
    ? groups
        .filter((group) => !grouped?.collapsed.includes(group.id))
        .flatMap((group) => group.rows)
    : items;
  const unavailable = list?.sources.filter((s) => s.state === 'unavailable');
  const open = (id: string | undefined) => onChange({ ...search, item: id });
  const empty = unavailable?.length
    ? {
        title: m.decisions_empty_partial_title(),
        text: m.decisions_empty_partial_text(),
      }
    : emptyCopy(segment, filtered);
  const keyboard = useListKeyboard({
    rows: listPane,
    count: ordered.length,
    keys: ordered.map((item) => item.id),
    preview: { open: search.item, onOpenChange: open },
    onFocusSearch: controls.query
      ? () => searchInput.current?.focus()
      : undefined,
    onOpenFilter: controls.conditions
      ? () => controls.conditions?.onOpenChange?.(true)
      : undefined,
    onShowHelp: () => setHelp(true),
  });
  const columns = properties.filter((key) => !inlineProperties.has(key));
  const inline = properties.filter((key) => inlineProperties.has(key));
  const context = { now, members, self };
  const rows = (label: string, shown: readonly DecisionItem[]) => (
    <CollectionList
      label={label}
      variant="plain"
      density={density}
      items={shown}
      itemKey={(item) => item.id}
      current={search.item}
      focusedKey={keyboard.focusedKey}
      link={(item) => (
        <Link
          id={`decision-${item.id}`}
          to="/app/$organizationId/needs-you"
          params={{ organizationId }}
          search={{ ...search, item: item.id }}
          resetScroll={false}
        />
      )}
      leading={(item) => (
        <DomainIcon domain={domainIcons[item.domain]} size="sm" />
      )}
      title={(item) => (
        <span
          className="decision-title"
          data-actionable={actionable(item) || undefined}
        >
          {item.observeOnly ? m.issues_observe_only_title() : item.title}
        </span>
      )}
      description={(item) => (
        <span className="case-row-subject">
          {inline.slice(0, 1).map((key) => (
            <span key={key}>{decisionProperty(item, key, context)}</span>
          ))}
          <span>{item.subject.label}</span>
          {inline.slice(1).map((key) => (
            <span key={key}>{decisionProperty(item, key, context)}</span>
          ))}
        </span>
      )}
      status={(item) => {
        const status = decisionStatus(item);

        return <StatePill state={status.state}>{status.label}</StatePill>;
      }}
      properties={columns}
      property={(item, key) => decisionProperty(item, key, context)}
    />
  );
  const clear = controls.onClear;

  return (
    <div
      className={`inbox page-full decisions ${search.item ? 'inbox-selected' : ''}`}
    >
      <h1 className="sr-only">{m.decisions_page_title()}</h1>
      <p className="sr-only" role="status">
        {list
          ? m.decisions_summary_waiting({ count: list.counts.views.all ?? 0 })
          : null}
      </p>
      <div className="decisions-toolbar">
        <CollectionToolbar
          refreshLabel={m.decisions_refresh()}
          refreshing={refreshing}
          onRefresh={onRefresh}
          views={
            <>
              {viewBar ?? (
                <Tabs
                  value={savedView ? null : segment}
                  className="decisions-views"
                >
                  <TabsList
                    aria-label={m.decisions_views_label()}
                    activateOnFocus={false}
                  >
                    {views.map((option) => (
                      <TabsTrigger
                        key={option}
                        value={option}
                        nativeButton={false}
                        render={
                          <Link
                            to="/app/$organizationId/needs-you"
                            params={{ organizationId }}
                            search={{ view: option, item: search.item }}
                            resetScroll={false}
                            onClick={(event) => {
                              if (!onOpenView || event.metaKey || event.ctrlKey)
                                return;
                              event.preventDefault();
                              onOpenView(option);
                            }}
                          />
                        }
                      >
                        {viewLabels[option]()}
                        {list ? (
                          <Badge>
                            {formatNumber(list.counts.views[option] ?? 0)}
                          </Badge>
                        ) : null}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              )}
            </>
          }
          search={
            controls.query
              ? {
                  value: controls.query.value || undefined,
                  onChange: (text) => controls.query?.onChange(text ?? ''),
                  label: m.decisions_search_label(),
                  placeholder: m.decisions_search_placeholder(),
                  inputRef: searchInput,
                }
              : undefined
          }
          filters={controls.filters ?? []}
          conditions={controls.conditions}
          actions={controls.actions}
          display={display}
          sort={controls.sort}
          onClear={clear}
        />
      </div>
      {offline ? (
        <CaseNotice title={m.decisions_offline_title()}>
          {m.decisions_offline_text()}
        </CaseNotice>
      ) : null}
      {unavailable?.length ? (
        <CaseNotice error title={m.decisions_unavailable_title()}>
          {m.decisions_unavailable_text({
            count: unavailable.length,
            sources: formatList(unavailable.map((source) => source.label)),
          })}
        </CaseNotice>
      ) : null}
      <IssueSplitView
        selected={!!search.item}
        list={
          <div
            className="inbox-list"
            ref={listPane}
            tabIndex={-1}
            aria-label={m.decisions_list_label()}
          >
            {notices}
            {error ? (
              <CaseNotice error title={m.decisions_error_title()}>
                {list ? `${m.decisions_error_stale()} ` : ''}
                {error}
                {search.cursor && onFirst ? (
                  <Button variant="outline" onClick={onFirst}>
                    {m.decisions_first_page()}
                  </Button>
                ) : null}
              </CaseNotice>
            ) : null}
            {loading ? (
              <div className="decisions-loading" role="status">
                <span className="sr-only">{m.decisions_loading_list()}</span>
                {[0, 1, 2, 3].map((key) => (
                  <span key={key} className="lu-skeleton" />
                ))}
              </div>
            ) : list ? (
              <>
                {!items.length ? (
                  <Empty className="inbox-empty">
                    <span aria-hidden="true">○</span>
                    <h2>{empty.title}</h2>
                    <p>{empty.text}</p>
                    {filtered && clear ? (
                      <Button variant="outline" onClick={clear}>
                        {m.common_clear_filters()}
                      </Button>
                    ) : null}
                  </Empty>
                ) : grouped && groups ? (
                  <>
                    <CollectionGroups
                      label={m.decisions_groups_label({
                        field:
                          decisionPresentation[
                            grouped.grouping.field
                          ]?.label() ?? grouped.grouping.field,
                      })}
                      collapsed={grouped.collapsed}
                      onCollapsedChange={grouped.onCollapsedChange}
                      groups={groups.map((group) => {
                        const label = grouped.label(group.group.key);

                        return {
                          key: group.id,
                          label,
                          count: group.group.count,
                          complete: group.group.complete,
                          content: group.rows.length ? (
                            rows(label, group.rows)
                          ) : (
                            <p className="decisions-group-note">
                              {m.decisions_group_empty()}
                            </p>
                          ),
                          more: groupMoreButton(group.more),
                        };
                      })}
                    />
                    <p className="decisions-group-note">
                      {m.decisions_group_note()}
                    </p>
                  </>
                ) : (
                  <>
                    {rows(m.decisions_list_label(), items)}
                    <Pagination
                      count={items.length}
                      totalCount={list.totalCount}
                      offset={list.offset}
                      page={page}
                      pageSize={decisionPageSize}
                      hasNext={!!list.nextCursor}
                      onPrevious={onPrevious}
                      onNext={onNext}
                      formatTotal={(count) =>
                        m.decisions_pagination_total({ count })
                      }
                      label={m.decisions_pagination_label()}
                    />
                  </>
                )}
              </>
            ) : null}
            {waiting}
          </div>
        }
        detail={
          <section
            className="inbox-detail"
            tabIndex={-1}
            aria-label={m.decisions_selected_label()}
            onKeyDown={(event) => {
              if (
                event.key !== 'Escape' ||
                event.defaultPrevented ||
                !search.item ||
                (event.target instanceof Element &&
                  event.target.closest(
                    'input, textarea, select, [contenteditable="true"], [role="combobox"], [role="dialog"], [role="menu"], [role="listbox"]',
                  ))
              )
                return;
              event.preventDefault();
              open(undefined);
              requestAnimationFrame(() =>
                (
                  document.getElementById(`decision-${search.item}`) ??
                  listPane.current
                )?.focus({ preventScroll: true }),
              );
            }}
          >
            {search.item ? (
              selected === 'loading' ? (
                <div className="decisions-loading" role="status">
                  <span className="sr-only">{m.decisions_loading_item()}</span>
                  <span className="lu-skeleton" />
                  <span className="lu-skeleton" />
                </div>
              ) : selected === 'missing' || !selected ? (
                <div className="inbox-placeholder">
                  <h2>{m.decisions_missing_title()}</h2>
                  <p>{m.decisions_missing_text()}</p>
                  <Button variant="outline" onClick={() => open(undefined)}>
                    {m.decisions_back_to_list()}
                  </Button>
                </div>
              ) : (
                inspector
              )
            ) : (
              <div className="inbox-placeholder">
                <h2>{m.decisions_placeholder_title()}</h2>
                <p>{m.decisions_placeholder_text()}</p>
              </div>
            )}
          </section>
        }
      />
      <ShortcutHelp
        open={help}
        onOpenChange={setHelp}
        groups={[
          listShortcutGroup(
            shortcuts.filter(
              (command) =>
                (command !== 'search' || !!controls.query) &&
                (command !== 'filter' || !!controls.conditions),
            ),
          ),
        ]}
      />
    </div>
  );
}

/** Loads the workspace queue, keeps its URL state and wires the selected decision's owner. */
export function NeedsYouPage() {
  const { organizationId } = useParams({
    from: '/app/$organizationId/needs-you',
  });

  return <TenantQueue key={organizationId} organizationId={organizationId} />;
}

function TenantQueue({ organizationId }: { organizationId: string }) {
  const search = useSearch({ from: '/app/$organizationId/needs-you' });
  const navigate = useNavigate({ from: '/app/$organizationId/needs-you' });
  const client = useQueryClient();
  const updates = useDecisionUpdatesState();
  const online = useOnline();
  const timeZone = useContext(WorkspaceTimezone);
  const permissions = usePermissions(organizationId);
  const can = permissions.can;
  const change = (next: NeedsYouSearch) =>
    void navigate({ search: next, resetScroll: false });
  const view = useCollectionView({
    catalog: decisionsCatalog,
    organizationId,
    search,
    // Changing the view keeps the open decision and starts at page one.
    navigate: (next: Partial<CollectionSearch>) =>
      change({ ...(search.item ? { item: search.item } : {}), ...next }),
  });
  const listView = queueView(view);
  const state = listView.state;
  const segment = decisionView(state.segment);
  // Naming the view keeps the remembered view from replacing the one the link opened.
  const [q, setQ] = usePrivateSearch(
    search.q,
    () =>
      void navigate({
        search: (current) => ({
          ...current,
          q: undefined,
          view: current.view ?? viewParam(view.key),
        }),
        replace: true,
        resetScroll: false,
      }),
  );
  const context = useQuery(contextOptions(organizationId));
  const members = useQuery(membersOptions(organizationId));
  const self = context.data?.actor.id;
  const memberList: Member[] = (members.data ?? []).map((member) => ({
    userId: member.userId,
    name: member.name,
    email: member.email,
  }));
  const options = {
    members: memberList.map((member) => ({
      value: member.userId,
      label: memberName(member.userId, memberList, self) ?? member.userId,
    })),
  };
  const ready = permissions.ready;
  const clientIssues = ready
    ? collectionWhereIssues(decisionsCatalog, state.where)
    : [];
  const query = decisionListQuery(
    state,
    { q, cursor: search.cursor },
    timeZone,
  );
  const [waitingOpen, setWaitingOpen] = useState(search.waiting ?? false);
  const waitingScope = JSON.stringify([query.where, query.q]);
  const [waitingPage, setWaitingPage] = useState<{
    scope: string;
    cursor: string;
  }>();
  const waitingCursor =
    waitingPage?.scope === waitingScope ? waitingPage.cursor : undefined;
  const waiting = useQuery({
    ...decisionsOptions(organizationId, {
      view: 'all',
      scope: 'waiting',
      where: query.where,
      q: query.q,
      limit: 100,
      cursor: waitingCursor,
    }),
    ...decisionsRefresh(updates),
    enabled: ready && waitingOpen,
  });
  const list = useQuery({
    ...decisionsOptions(organizationId, query),
    ...decisionsRefresh(updates),
    enabled: ready && !clientIssues.length,
  });
  // With a page cursor, a refused request means the page link is stale, not the view.
  const serverIssue = search.cursor
    ? undefined
    : collectionServerIssue(list.error);
  const controls = useCollectionControls({
    view: listView,
    catalog: decisionsCatalog,
    presentation: decisionPresentation,
    can,
    options,
    title: 'title',
    defaultProperties: decisionProperties,
    serverIssues: serverIssue ? [serverIssue] : [],
    owner: { field: 'owner', members: options.members, unassigned: true },
  });
  const issues = [...clientIssues, ...(serverIssue ? [serverIssue] : [])];
  const repair = issues.length
    ? () =>
        view.change(repairedState(decisionsCatalog, view.state, issues, can))
    : undefined;
  const failure: CollectionError | undefined = clientIssues.length
    ? { kind: 'invalid', message: m.collections_needs_repair() }
    : collectionError(list.error, search.cursor);
  const denied = failure?.kind === 'access';
  const data =
    denied || failure?.kind === 'invalid' || failure?.kind === 'page'
      ? undefined
      : list.data;

  const grouping = state.group;
  const groupPrefix = `${groupOf(state) ?? ''}=`;
  const collapsed = view.display.collapsedGroups
    .filter((id) => id.startsWith(groupPrefix))
    .map((id) => id.slice(groupPrefix.length));
  const more = useGroupPages<DecisionItem>({
    resetKey: JSON.stringify([organizationId, query]),
    load: (key: CollectionGroup['key'], cursor: string) =>
      client
        .fetchQuery(
          decisionsOptions(
            organizationId,
            decisionListQuery(state, { q }, timeZone, { key, cursor }),
          ),
        )
        .then((page) => ({
          rows: page.items,
          nextCursor: page.groups?.[0]?.nextCursor ?? page.nextCursor,
        })),
  });
  const groups =
    data && grouping && data.groups
      ? shownGroups({
          items: data.items,
          groups: data.groups,
          rowKey: (item) => item.id,
          field: decisionsCatalog.fields.find(
            (field) => field.id === grouping.field,
          ),
          showEmpty: grouping.showEmpty,
          more,
        })
      : undefined;
  const shown = groups ? groups.flatMap((group) => group.rows) : data?.items;
  const onPage = shown?.find((item) => item.id === search.item);
  const direct = useQuery({
    ...decisionOptions(organizationId, search.item ?? ''),
    refetchInterval: 5000,
    enabled: !!search.item && !!data && !onPage,
  });
  // Keep an opened decision visible after it leaves the queue so its outcome stays readable.
  const current = onPage ?? direct.data ?? undefined;
  const [remembered, setRemembered] = useState<DecisionItem>();
  const [changedProposal, setChangedProposal] = useState<{
    id: string;
    previous: DecisionItem['change'];
  }>();
  if (current && current !== remembered) {
    if (
      remembered?.id === current.id &&
      JSON.stringify(current.change) !== JSON.stringify(remembered.change) &&
      !current.outcome
    )
      setChangedProposal({ id: current.id, previous: remembered.change });
    setRemembered(current);
  }
  // A remembered item keeps its owner review mounted while the queue confirms it has left.
  const fallback = remembered?.id === search.item ? remembered : undefined;
  const departed =
    !current && !!fallback && !direct.isFetching && direct.data === null;
  const selected: DecisionItem | 'loading' | 'missing' | undefined =
    !search.item
      ? undefined
      : (current ??
        fallback ??
        (!data || direct.isPending ? 'loading' : 'missing'));

  const paging = useCursorPaging({
    // Search text never enters browser storage; a new search starts on the first page.
    key: JSON.stringify([
      organizationId,
      view.key,
      query.view,
      query.where,
      query.sort,
      query.direction,
      !!query.q,
    ]),
    cursor: search.cursor,
    page: search.page,
    nextCursor: grouping ? null : data?.nextCursor,
    go: ({ cursor, page }) => change({ ...search, cursor, page }),
  });
  const refresh = () => {
    if (search.cursor)
      change({ ...search, cursor: undefined, page: undefined });
    void client.invalidateQueries({ queryKey: decisionsKey(organizationId) });
  };

  const assignmentAccess = permissions.can('decisions.assign')
    ? 'anyone'
    : permissions.can('decisions.self_assign')
      ? 'self'
      : 'none';
  const [assignError, setAssignError] = useState<string>();
  const assignment = useMutation({
    mutationFn: (input: { item: DecisionItem; assigneeId: string | null }) =>
      assignDecision(organizationId, {
        decisionId: input.item.id,
        assigneeId: input.assigneeId,
        revision: input.item.assignment?.revision ?? 0,
      }),
    onMutate: () => setAssignError(undefined),
    onError: (error) =>
      setAssignError(
        error instanceof ApiError ? error.message : m.decisions_assign_failed(),
      ),
    onSettled: () =>
      client.invalidateQueries({ queryKey: decisionsKey(organizationId) }),
  });

  // The inspector's previous and next buttons step through the visible decisions.
  const items = shown ?? [];
  const position = items.findIndex((item) => item.id === search.item);
  const step = (offset: number) => {
    const target = items[position < 0 ? 0 : position + offset];
    if (!target) return;
    change({ ...search, item: target.id });
    requestAnimationFrame(() =>
      document
        .getElementById(`decision-${target.id}`)
        ?.scrollIntoView({ block: 'nearest' }),
    );
  };

  if (list.error instanceof ApiError && list.error.status === 401)
    return <SignInRedirect />;
  const item = typeof selected === 'object' ? selected : undefined;
  const previousItem = position > 0 ? items[position - 1] : undefined;
  const nextItem = position >= 0 ? items[position + 1] : undefined;
  const clear = () => {
    setQ('');
    controls.clearConditions();
  };

  return (
    <NeedsYouView
      organizationId={organizationId}
      search={search}
      segment={segment}
      viewBar={
        <CollectionViewBar
          organizationId={organizationId}
          view={view}
          path="needs-you"
          segmentLabel={(value) => viewLabels[decisionView(value)]()}
          segments={views.map((option) => ({
            value: option,
            label: viewLabels[option](),
            count: data ? (data.counts.views[option] ?? 0) : undefined,
          }))}
        />
      }
      display={controls.display}
      controls={{
        query: {
          value: q,
          onChange: (text) => {
            setQ(text);
            change(decisionFilters(search));
          },
        },
        filters: controls.filters,
        conditions: controls.conditions,
        sort: controls.sort,
        actions: (
          <DescribedFilter
            organizationId={organizationId}
            domain="decisions"
            listName={m.decisions_page_title()}
            fields={controls.conditions.fields}
            apply={(conditions) =>
              listView.change({
                ...state,
                where: {
                  match: state.where.match,
                  conditions: [...state.where.conditions, ...conditions],
                },
              })
            }
          />
        ),
        onClear: clear,
      }}
      waiting={
        <Disclosure
          open={waitingOpen}
          onToggle={(event) => setWaitingOpen(event.currentTarget.open)}
        >
          <summary>{m.decisions_waiting_others()}</summary>
          {waiting.isPending ? (
            <p role="status">{m.decisions_loading_list()}</p>
          ) : waiting.isError ? (
            <p role="alert">{m.decisions_error_title()}</p>
          ) : waiting.data ? (
            <>
              {waiting.data.items.length ? (
                <ul className="decisions-waiting-list">
                  {waiting.data.items.map((item) => (
                    <li key={item.id}>
                      <Link
                        to="/app/$organizationId/needs-you"
                        params={{ organizationId }}
                        search={{ ...search, item: item.id }}
                        resetScroll={false}
                      >
                        {item.title}
                      </Link>
                      <span>
                        {decisionStatus(item).label}
                        {item.reason === 'run' && item.requesterId
                          ? ` · ${memberName(item.requesterId, memberList, self) ?? m.decisions_member_fallback()}`
                          : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>{m.decisions_waiting_empty()}</p>
              )}
              {waitingCursor ? (
                <Button
                  variant="ghost"
                  onClick={() => setWaitingPage(undefined)}
                >
                  {m.decisions_first_page()}
                </Button>
              ) : null}
              {waiting.data.nextCursor ? (
                <Button
                  variant="outline"
                  onClick={() =>
                    setWaitingPage(
                      waiting.data?.nextCursor
                        ? {
                            scope: waitingScope,
                            cursor: waiting.data.nextCursor,
                          }
                        : undefined,
                    )
                  }
                >
                  {m.common_show_more()}
                </Button>
              ) : null}
            </>
          ) : null}
        </Disclosure>
      }
      filtered={!!q.trim() || state.where.conditions.length > 0}
      notices={
        failure && failure.kind !== 'unavailable' ? (
          <CollectionNotices
            offline={false}
            error={failure}
            hasRows={!!data}
            retry={() => void list.refetch()}
            firstPage={() =>
              change({ ...search, cursor: undefined, page: undefined })
            }
            repair={repair}
          />
        ) : data?.groupsTruncated ? (
          <CaseNotice title={m.collections_groups_truncated()} />
        ) : null
      }
      grouped={
        grouping && groups
          ? {
              grouping,
              groups,
              label: (key) =>
                decisionGroupLabel(grouping.field, key, {
                  items,
                  members: memberList,
                  self,
                }),
              collapsed,
              onCollapsedChange: (id, closed) =>
                view.setDisplay({
                  ...view.display,
                  collapsedGroups: [
                    ...view.display.collapsedGroups.filter(
                      (entry) => entry !== `${groupPrefix}${id}`,
                    ),
                    ...(closed ? [`${groupPrefix}${id}`] : []),
                  ].slice(-100),
                }),
            }
          : undefined
      }
      properties={controls.properties}
      density={state.density}
      list={data}
      loading={list.isPending && !failure}
      refreshing={list.isFetching}
      error={
        denied
          ? m.decisions_error_no_access()
          : failure?.kind === 'unavailable' && list.error
            ? list.error.message
            : undefined
      }
      offline={!online}
      page={paging.page}
      onPrevious={paging.previous}
      onNext={() => paging.next?.()}
      onFirst={paging.first}
      onChange={change}
      onRefresh={refresh}
      members={memberList}
      self={self}
      selected={selected}
      inspector={
        item ? (
          <DecisionInspector
            key={item.id}
            organizationId={organizationId}
            item={item}
            departed={departed}
            previousChange={
              changedProposal?.id === item.id
                ? changedProposal.previous
                : undefined
            }
            members={memberList}
            self={self}
            assignmentAccess={
              item.kind === 'human_task' || item.kind === 'return_case'
                ? 'none'
                : item.owner.kind === 'case' && assignmentAccess === 'self'
                  ? 'none'
                  : assignmentAccess
            }
            canRead={permissions.can}
            assigning={assignment.isPending}
            assignError={assignError}
            onAssign={(assigneeId) => assignment.mutate({ item, assigneeId })}
            onClose={() => change({ ...search, item: undefined })}
            navigation={
              <>
                <Button
                  variant="ghost"
                  aria-label={m.decisions_previous()}
                  title={m.decisions_previous_shortcut()}
                  disabled={!previousItem}
                  onClick={() => step(-1)}
                >
                  <ChevronUp aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  aria-label={m.decisions_next()}
                  title={m.decisions_next_shortcut()}
                  disabled={!nextItem}
                  onClick={() => step(1)}
                >
                  <ChevronDown aria-hidden="true" />
                </Button>
              </>
            }
            review={
              item.outcome ? null : (
                <OwnerReview
                  organizationId={organizationId}
                  owner={item.owner}
                  refreshedAt={Math.max(
                    list.dataUpdatedAt,
                    direct.dataUpdatedAt,
                  )}
                  handover={item.kind === 'workflow_handover'}
                  onChange={() =>
                    client.invalidateQueries({
                      queryKey: decisionsKey(organizationId),
                    })
                  }
                />
              )
            }
          />
        ) : null
      }
    />
  );
}
