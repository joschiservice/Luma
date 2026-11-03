import './activity.css';

import {
  activityCatalog,
  type ActivityCounts,
  type ActivityEvent,
  activityOutcomes,
  activityTypes,
  type CollectionViewState,
} from '@luma/api-contract';
import {
  formatDateTime,
  formatList,
  formattingLocale,
} from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import { CollectionList } from '@luma/ui/components/primitives/collection-list';
import { CollectionPreview } from '@luma/ui/components/primitives/collection-preview';
import {
  type CollectionFilter,
  CollectionToolbar,
  type CollectionView,
  CollectionViews,
} from '@luma/ui/components/primitives/collection-toolbar';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { Empty } from '@luma/ui/components/primitives/empty';
import {
  listShortcutGroup,
  ShortcutHelp,
} from '@luma/ui/components/primitives/shortcut-help';
import { StateDot, StatePill } from '@luma/ui/components/primitives/state';
import {
  formatWorkspaceInstant,
  WorkspaceTimezone,
} from '@luma/ui/components/primitives/workspace-date';
import { PageTitle } from '@luma/ui/components/workspace/page-header';
import { actorLabel } from '@luma/ui/lib/actor';
import { calendarPresets } from '@luma/ui/lib/date-range';
import { type ListShortcut, useListKeyboard } from '@luma/ui/lib/list-keyboard';
import {
  operatorCodeLabel,
  operatorCodeMessages,
} from '@luma/ui/lib/operator-code';
import { workspaceDateValue } from '@luma/ui/lib/timezone';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import {
  useLocation,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import {
  ArrowUp,
  CalendarDays,
  Check,
  CircleDot,
  Download,
  History,
  Link2,
  Plug,
  Server,
  Tag,
  UserRound,
} from 'lucide-react';
import {
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { CollectionLoading } from '../../kit/collections/notices';
import { useOnline } from '../../kit/collections/paging';
import { PreviewFact } from '../../kit/collections/preview';
import type { CollectionSearch } from '../../kit/collections/state';
import { useCollectionView } from '../../kit/collections/use-collection-view';
import { CollectionViewBar } from '../../kit/collections/view-bar';
import { connectionsOptions } from '../../kit/connections/data';
import { SignInRedirect } from '../../kit/identity/common';
import { ApiError } from '../../kit/identity/data';
import { usePermissions } from '../../kit/identity/permissions';
import { membersOptions } from '../../kit/settings/data';
import { providerName } from '../sync/presentation';
import {
  activityConditions,
  activityCountsOptions,
  activityEventOptions,
  activityFeedOptions,
  type ActivityFilters,
  activityFiltersOf,
  activityHeadOptions,
  activityRange,
  type ActivitySearch,
  exportActivity,
} from './data';
import {
  activityChangeLabel,
  activityConnectionOptions,
  activityDayLabel,
  activityDays,
  activityDetailLabel,
  activityExportLabels,
  activityLabel,
  activityOutcomeExplanation,
  type ActivityQuickView,
  activityQuickView,
  activityQuickViewOutcomes,
  activityRecordLink,
  activityResourceLabel,
  type ActivitySource,
  activityState,
  activityStepOutcome,
  activitySteps,
  activityStepState,
  activitySubject,
  activitySystemOptions,
  activityTitle,
} from './presentation';

/** The commands the Activity list handles, for shortcut help. */
const shortcuts: readonly ListShortcut[] = [
  'next',
  'previous',
  'preview',
  'escape',
  'search',
  'help',
];

/**
 * Connects workspace history to the member's view: filters live in the view's conditions, so
 * combinations can be saved, shared and remembered, while search text and the open event stay in
 * the URL. Every read runs with the reader's own visibility, so a shared view never shows events
 * the reader couldn't see otherwise. The list reads 30 events at a time and appends older ones;
 * a separate poll of the newest events offers new ones without moving the list being read.
 */
export function ActivityPage() {
  const { organizationId } = useParams({ from: '/app/$organizationId' });
  const search = useSearch({ from: '/app/$organizationId/activity' });
  const navigate = useNavigate({ from: '/app/$organizationId/activity' });
  const timeZone = useContext(WorkspaceTimezone);
  const online = useOnline();
  // A filter change carries the search text of the filters it came with; other view changes
  // keep the current search.
  const changing = useRef<{ q: string | undefined } | null>(null);
  const go = (next: ActivitySearch) =>
    void navigate({ search: next, resetScroll: false });
  const view = useCollectionView({
    catalog: activityCatalog,
    organizationId,
    search,
    navigate: (next: Partial<CollectionSearch>) => {
      const q = changing.current ? changing.current.q : search.q;
      go({ ...(q ? { q } : {}), ...next } as ActivitySearch);
    },
  });
  const today = workspaceDateValue(new Date(), timeZone);
  const { filters: conditions, issues } = activityFiltersOf(
    view.state.where,
    today,
  );
  const filters: ActivityFilters = {
    ...conditions,
    q: search.q,
    event: search.event,
  };
  const invalid = issues.length > 0;
  const feed = useInfiniteQuery({
    ...activityFeedOptions(organizationId, filters, timeZone),
    enabled: !invalid,
  });
  const head = useQuery({
    ...activityHeadOptions(organizationId, filters, timeZone),
    enabled: !invalid,
  });
  const connections = useQuery(connectionsOptions(organizationId));
  const members = useQuery(membersOptions(organizationId));
  const pages = feed.data?.pages;
  const items = useMemo(() => pages?.flatMap((page) => page.items), [pages]);

  // Restricted access changed between reads: read both again before showing either.
  const visibilityChanged =
    !!pages?.[0] && !!head.data && pages[0].visibility !== head.data.visibility;
  const settling = feed.isFetching || head.isFetching;
  const { refetch: refetchFeed } = feed;
  const { refetch: refetchHead } = head;
  useEffect(() => {
    if (!visibilityChanged || settling) return;
    void refetchFeed();
    void refetchHead();
  }, [visibilityChanged, settling, refetchFeed, refetchHead]);

  // A link can open an event the loaded list doesn't hold, such as an older one: read its group.
  const openListed =
    !search.event ||
    !!items?.some(
      (item) =>
        item.id === search.event ||
        item.steps?.some((step) => step.id === search.event),
    );
  const lookup = useQuery({
    ...activityEventOptions(
      organizationId,
      filters,
      search.event ?? '',
      timeZone,
    ),
    enabled: !invalid && !!items && !openListed,
  });
  const { fetchNextPage } = feed;
  // The quick views count what they would list; they follow the newest event the poll saw.
  const counts = useQuery({
    ...activityCountsOptions(
      organizationId,
      filters,
      head.data?.items[0]?.id,
      timeZone,
    ),
    enabled: !invalid,
  });
  const permissions = usePermissions(organizationId);
  const sources = connections.data?.map((connection) => ({
    id: connection.id,
    label: connection.label,
    system: connection.target.kind,
  }));
  const exporting = useMutation({
    mutationFn: () =>
      exportActivity(
        organizationId,
        filters,
        activityExportLabels(sources ?? []),
        timeZone,
      ),
    onSuccess: (result) => {
      const url = URL.createObjectURL(
        new Blob([result.csv], { type: 'text/csv;charset=utf-8' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = result.filename;
      link.click();
      URL.revokeObjectURL(url);
    },
  });

  const olderFailed = feed.isFetchNextPageError;
  const error = (olderFailed ? null : feed.error) ?? head.error;
  if (error instanceof ApiError && error.status === 401)
    return <SignInRedirect />;
  const accessLost =
    error instanceof ApiError && [403, 404].includes(error.status);

  // New events are those the poll found above the list's newest event, once it ran after the
  // list was read. An event the poll no longer lists, such as a group with a newer step, counts
  // as new without a number.
  const newest = items?.[0]?.id;
  const headIds = head.data?.items.map((item) => item.id) ?? [];
  const position = newest ? headIds.indexOf(newest) : -1;
  const newCount =
    !items ||
    !headIds.length ||
    headIds[0] === newest ||
    head.dataUpdatedAt <= feed.dataUpdatedAt
      ? undefined
      : position > 0
        ? position
        : null;

  // The URL's view keys, kept when only the search or open event changes.
  const viewKeys: ActivitySearch = { ...search };
  delete viewKeys.q;
  delete viewKeys.event;
  // Removes what Activity can't apply; "match any" of several filters narrows to all of them.
  const repair = () => {
    const broken = new Set(issues.map((issue) => issue.index));
    view.change({
      ...view.state,
      where: {
        match: 'all',
        conditions: view.state.where.conditions.filter(
          (_, index) => !broken.has(index),
        ),
      },
    } satisfies CollectionViewState);
  };

  return (
    <ActivityView
      organizationId={organizationId}
      filters={filters}
      sources={sources}
      people={members.data?.map((member) => ({
        id: member.userId,
        label:
          [member.name, member.email].filter(Boolean).join(' · ') ||
          m.activity_actor_unknown_person(),
      }))}
      views={
        <CollectionViewBar
          organizationId={organizationId}
          view={view}
          path="activity"
          segmentLabel={() => m.activity_view_all()}
        />
      }
      items={accessLost || visibilityChanged || invalid ? undefined : items}
      loading={feed.isPending && !invalid}
      refreshing={settling}
      offline={!online}
      newCount={invalid ? undefined : newCount}
      error={
        invalid
          ? m.collections_needs_repair()
          : accessLost
            ? m.activity_error_access_lost()
            : error
              ? m.activity_error_unavailable()
              : undefined
      }
      repair={invalid ? repair : undefined}
      older={{
        more: !!feed.hasNextPage,
        loading: feed.isFetchingNextPage,
        failed: olderFailed,
        load: () => void fetchNextPage(),
      }}
      opened={openListed ? undefined : lookup.data?.items[0]}
      finding={!openListed && lookup.isPending}
      counts={invalid || accessLost ? undefined : counts.data}
      exporting={
        permissions.can('lists.export')
          ? {
              run: () => exporting.mutate(),
              pending: exporting.isPending,
              result: exporting.data,
              failed: exporting.isError
                ? exporting.error instanceof ApiError
                  ? exporting.error.message
                  : m.activity_export_failed()
                : undefined,
            }
          : undefined
      }
      change={(next) => {
        const where = activityConditions(next);
        const position = {
          ...(next.q ? { q: next.q } : {}),
          ...(next.event ? { event: next.event } : {}),
        };
        if (
          JSON.stringify(where) ===
          JSON.stringify(activityConditions(conditions))
        )
          return go({ ...viewKeys, ...position });
        changing.current = { q: next.q };
        view.change({
          ...view.state,
          where: { match: 'all', conditions: where },
        });
        changing.current = null;
      }}
      refresh={() => {
        void refetchFeed();
        void refetchHead();
        void counts.refetch();
      }}
    />
  );
}

/**
 * Presents workspace history by day, with search, filters, quick views, list keys and the open
 * event beside the list, including loading, empty, unavailable and offline states.
 */
export function ActivityView({
  organizationId,
  filters,
  sources = [],
  people = [],
  views,
  items,
  loading = false,
  refreshing = false,
  offline = false,
  newCount,
  error,
  repair,
  older,
  opened,
  finding = false,
  counts,
  exporting,
  change,
  refresh,
}: {
  organizationId: string;
  /**
   * The view's filters with search and the open event. Dates are set only when chosen;
   * otherwise the last 30 days apply.
   */
  filters: ActivityFilters;
  /** Workspace connections offered as connection and system filters and named in details. */
  sources?: readonly ActivitySource[] | undefined;
  /** Workspace members offered in the actor filter after Me, Luma and Workflows. */
  people?: readonly { id: string; label: string }[] | undefined;
  /** The view menu, shown before the quick views. */
  views?: ReactNode;
  /** Loaded events, newest first; undefined while none can be shown. */
  items?: readonly ActivityEvent[] | undefined;
  loading?: boolean;
  refreshing?: boolean;
  offline?: boolean;
  /** Events recorded above the list since it was read; null when their number is unknown. */
  newCount?: number | null | undefined;
  error?: string | undefined;
  /** Removes the view's filters Activity can't apply; offered with the error. */
  repair?: (() => void) | undefined;
  /** Older events below the loaded ones. */
  older?:
    | { more: boolean; loading: boolean; failed: boolean; load: () => void }
    | undefined;
  /** The open event's group, read on its own because the loaded list doesn't hold it. */
  opened?: ActivityEvent | undefined;
  /** The open event is being read on its own. */
  finding?: boolean;
  /** How many groups each quick view lists under the other filters. */
  counts?: ActivityCounts | undefined;
  /** Exports the filtered events as CSV; offered to people who may export lists. */
  exporting?:
    | {
        run: () => void;
        pending: boolean;
        result?: { rows: number; truncated: boolean } | undefined;
        failed?: string | undefined;
      }
    | undefined;
  change: (filters: ActivityFilters) => void;
  /** Reads the loaded events and the newest events again. */
  refresh: () => void;
}) {
  const timeZone = useContext(WorkspaceTimezone);
  const today = workspaceDateValue(new Date(), timeZone);
  const href = useLocation({ select: (location) => location.href });
  const navigate = useNavigate();
  const rows = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [help, setHelp] = useState(false);
  // Any filter change closes the open event.
  const update = (patch: Partial<ActivityFilters>) =>
    change({ ...filters, ...patch, event: undefined });
  const open = (event: string | undefined) => change({ ...filters, event });
  // A relative period shows as the range it covers today, so its preset stays selected.
  const shown = filters.last
    ? activityRange(filters, new Date(), timeZone)
    : filters;
  const toolbarFilters: CollectionFilter[] = [
    {
      kind: 'date-range',
      key: 'recorded',
      label: m.activity_filter_recorded(),
      icon: CalendarDays,
      from: shown.from,
      to: shown.to,
      today,
      maxDays: 366,
      fallback: m.activity_filter_last_30_days(),
      // Presets that end today stay relative, so a saved view keeps showing recent events.
      onChange: (range) => {
        const preset = calendarPresets(today).find(
          (item) => item.from === range.from && item.to === range.to,
        );
        update(
          preset
            ? {
                from: undefined,
                to: undefined,
                last: {
                  amount: Math.round(
                    (Date.parse(preset.to) - Date.parse(preset.from)) /
                      86400000,
                  ),
                  unit: 'day',
                },
              }
            : { from: range.from, to: range.to, last: undefined },
        );
      },
    },
    {
      kind: 'multi-choice',
      key: 'actor',
      label: m.activity_filter_actor(),
      icon: UserRound,
      value: filters.actor,
      options: [
        { value: 'me', label: m.activity_actor_me() },
        { value: 'luma', label: m.activity_actor_luma() },
        { value: 'workflow', label: m.activity_actor_workflows() },
        ...people.map((person) => ({ value: person.id, label: person.label })),
        ...(filters.actor ?? [])
          .filter(
            (value) =>
              !['me', 'luma', 'workflow'].includes(value) &&
              !people.some((person) => person.id === value),
          )
          .map((value) => ({
            value,
            label: m.activity_actor_unknown_person(),
          })),
      ],
      onChange: (actor) => update({ actor: actor?.length ? actor : undefined }),
    },
    {
      kind: 'multi-choice',
      key: 'outcome',
      label: m.activity_filter_outcome(),
      icon: CircleDot,
      value: filters.outcome,
      options: activityOutcomes.map((value) => ({
        value,
        label: activityLabel(value),
      })),
      onChange: (value) => {
        const outcome = activityOutcomes.filter((item) =>
          value?.includes(item),
        );
        update({ outcome: outcome.length ? outcome : undefined });
      },
    },
    {
      kind: 'choice',
      key: 'type',
      label: m.activity_filter_type(),
      icon: Tag,
      value: filters.type,
      options: activityTypes.map((value) => ({
        value,
        label: activityLabel(value),
      })),
      onChange: (value) =>
        update({ type: activityTypes.find((item) => item === value) }),
    },
    {
      kind: 'choice',
      key: 'system',
      label: m.activity_filter_system(),
      icon: Server,
      value: filters.system,
      options: activitySystemOptions(sources, filters.system),
      onChange: (system) => update({ system }),
    },
    {
      kind: 'choice',
      key: 'connectionId',
      label: m.activity_filter_connection(),
      icon: Plug,
      value: filters.connectionId,
      options: activityConnectionOptions(sources, filters.connectionId),
      onChange: (connectionId) => update({ connectionId }),
    },
  ];
  // The open event isn't a filter; an empty list without filters gets its own copy.
  const filtered = Object.entries(filters).some(
    ([key, value]) =>
      key !== 'event' && (Array.isArray(value) ? value.length > 0 : !!value),
  );
  const quickView = activityQuickView(filters.outcome);
  const quickViews: CollectionView<ActivityQuickView>[] = [
    {
      value: 'all',
      label: m.activity_quick_all(),
      description: m.activity_quick_all_description(),
      count: counts?.total,
      countIsLowerBound: counts?.truncated,
    },
    {
      value: 'attention',
      label: m.activity_quick_attention(),
      description: m.activity_quick_attention_description(),
      count: counts?.attention,
      countIsLowerBound: counts?.truncated,
      attention: true,
    },
    {
      value: 'verified',
      label: m.activity_quick_verified(),
      description: m.activity_quick_verified_description(),
      count: counts ? (counts.outcomes.verified ?? 0) : undefined,
      countIsLowerBound: counts?.truncated,
    },
  ];

  const days = useMemo(
    () => (items ? activityDays(items, timeZone) : []),
    [items, timeZone],
  );
  const keys = days.flatMap((day) => day.items.map((item) => item.id));
  const openItem = filters.event
    ? (items?.find(
        (item) =>
          item.id === filters.event ||
          item.steps?.some((step) => step.id === filters.event),
      ) ?? opened)
    : undefined;
  const keyboard = useListKeyboard({
    rows,
    count: keys.length,
    keys,
    preview: {
      open: openItem?.id ?? filters.event,
      onOpenChange: open,
    },
    onFocusSearch: () => searchInput.current?.focus(),
    onShowHelp: () => setHelp(true),
  });
  // The row link keeps the view in its address, so it also opens in a new tab.
  const eventHref = (id: string) => {
    const url = new URL(href, 'http://localhost');
    url.searchParams.set('event', id);

    return `${url.pathname}${url.search}`;
  };

  const list = (
    <div ref={rows} className="activity-feed">
      {newCount !== undefined ? (
        <div className="activity-new" role="status">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              refresh();
              rows.current?.scrollIntoView({ block: 'start' });
            }}
          >
            <ArrowUp aria-hidden="true" />
            {newCount === null
              ? m.activity_new_events()
              : m.activity_new_events_count({ count: newCount })}
          </Button>
        </div>
      ) : null}
      {items ? (
        items.length ? (
          <>
            {days.map((day) => {
              const heading = activityDayLabel(day.day, today);

              return (
                <section
                  key={day.day}
                  className="activity-day"
                  aria-labelledby={`activity-day-${day.day}`}
                >
                  <h2
                    id={`activity-day-${day.day}`}
                    className="activity-day-heading"
                  >
                    <span>{heading}</span>
                    <small>
                      {zoneName(day.items[0]!.recordedAt, timeZone)}
                    </small>
                  </h2>
                  <CollectionList
                    label={heading}
                    items={day.items}
                    itemKey={(item) => item.id}
                    current={openItem?.id}
                    focusedKey={keyboard.focusedKey}
                    link={(item) => (
                      <a
                        href={eventHref(item.id)}
                        aria-label={rowLabel(item, timeZone)}
                        onClick={(event) => {
                          if (
                            event.button !== 0 ||
                            event.metaKey ||
                            event.ctrlKey ||
                            event.shiftKey ||
                            event.altKey
                          )
                            return;
                          event.preventDefault();
                          open(item.id);
                        }}
                      />
                    )}
                    leading={(item) => (
                      <StateDot state={activityState(item.outcome)} />
                    )}
                    title={(item) => activityTitle(item)}
                    description={(item) => (
                      <span>{rowContext(item).join(' · ')}</span>
                    )}
                    status={(item) => <ActivityStatus item={item} />}
                    properties={['steps', 'time']}
                    property={(item, key) =>
                      key === 'time' ? (
                        <time
                          dateTime={item.recordedAt}
                          title={formatWorkspaceInstant(
                            item.recordedAt,
                            timeZone,
                          )}
                          className="activity-time"
                        >
                          {formatDateTime(item.recordedAt, {
                            hour: '2-digit',
                            minute: '2-digit',
                            timeZone,
                          })}
                        </time>
                      ) : item.steps?.length ? (
                        m.activity_steps_count({ count: item.steps.length + 1 })
                      ) : null
                    }
                  />
                </section>
              );
            })}
            <footer className="activity-more">
              {older?.failed ? (
                <Alert tone="danger" role="alert">
                  {m.activity_older_failed()}{' '}
                  <Button variant="outline" onClick={older.load}>
                    {m.common_retry()}
                  </Button>
                </Alert>
              ) : older?.more ? (
                <Button
                  variant="outline"
                  onClick={older.load}
                  disabled={older.loading}
                >
                  {older.loading
                    ? m.activity_older_loading()
                    : m.activity_older_show()}
                </Button>
              ) : (
                <p>{m.activity_older_none()}</p>
              )}
            </footer>
          </>
        ) : filtered ? (
          <Empty className="activity-empty">
            <History size={30} aria-hidden="true" />
            <h2>
              {quickView === 'attention'
                ? m.activity_empty_attention_title()
                : m.activity_empty_filtered_title()}
            </h2>
            <p>
              {quickView === 'attention'
                ? m.activity_empty_attention_description()
                : m.activity_empty_filtered_description()}
            </p>
            <Button variant="outline" onClick={() => change({})}>
              {m.common_clear_filters()}
            </Button>
          </Empty>
        ) : (
          <Empty className="activity-empty">
            <History size={30} aria-hidden="true" />
            <h2>{m.activity_empty_title()}</h2>
            <p>{m.activity_empty_description()}</p>
          </Empty>
        )
      ) : loading && !error ? (
        <CollectionLoading />
      ) : null}
    </div>
  );

  return (
    <div className="activity-page">
      <PageTitle title={m.activity_page_title()} />
      <CollectionToolbar
        views={
          <>
            {views}
            <CollectionViews
              label={m.activity_quick_label()}
              value={quickView}
              views={quickViews}
              onChange={(next) => {
                const outcome = activityQuickViewOutcomes(next);
                update({ outcome: outcome.length ? outcome : undefined });
              }}
            />
          </>
        }
        search={{
          value: filters.q,
          onChange: (q) => update({ q }),
          label: m.activity_search_label(),
          placeholder: m.activity_search_placeholder(),
          maxLength: 200,
          inputRef: searchInput,
        }}
        filters={toolbarFilters}
        actions={
          exporting ? (
            <Button
              variant="outline"
              onClick={exporting.run}
              disabled={exporting.pending}
            >
              <Download aria-hidden="true" />
              {m.collections_export()}
            </Button>
          ) : null
        }
        onClear={() => change({})}
        onRefresh={refresh}
        refreshing={refreshing}
        refreshLabel={m.activity_refresh()}
      />
      {offline ? <Alert role="status">{m.common_offline()}</Alert> : null}
      {exporting?.result ? (
        <Alert
          role="status"
          tone={exporting.result.truncated ? 'warning' : 'success'}
        >
          {exporting.result.truncated
            ? m.activity_export_done_truncated({
                count: exporting.result.rows,
              })
            : m.activity_export_done({ count: exporting.result.rows })}
        </Alert>
      ) : exporting?.failed ? (
        <Alert tone="danger" role="alert">
          {exporting.failed}
        </Alert>
      ) : null}
      {error ? (
        <Alert tone="danger" role="alert">
          {error}{' '}
          {repair ? (
            <Button variant="outline" onClick={repair}>
              {m.collections_remove_unsupported()}
            </Button>
          ) : (
            <Button variant="outline" onClick={refresh}>
              {m.common_retry()}
            </Button>
          )}
        </Alert>
      ) : null}
      <CollectionPreview
        className="activity-split"
        open={!!filters.event}
        list={list}
        label={m.activity_preview_label()}
        title={openItem ? activityTitle(openItem) : undefined}
        actions={openItem ? <CopyEventLink /> : null}
        preview={
          openItem ? (
            <ActivityEventDetail
              key={openItem.id}
              item={openItem}
              organizationId={organizationId}
              sources={sources}
              navigate={(to) => void navigate({ href: to })}
            />
          ) : filters.event && items ? (
            <div className="activity-detail-missing" role="status">
              {finding ? (
                <p>{m.activity_preview_finding()}</p>
              ) : (
                <>
                  <h3>{m.activity_preview_missing_title()}</h3>
                  <p>{m.activity_preview_missing_description()}</p>
                </>
              )}
            </div>
          ) : null
        }
        onClose={() => open(undefined)}
      />
      <ShortcutHelp
        open={help}
        onOpenChange={setHelp}
        groups={[listShortcutGroup(shortcuts)]}
      />
    </div>
  );
}

/** Names the workspace time zone on a day, such as "AEDT", since the list's times use it. */
function zoneName(value: string, timeZone: string) {
  return (
    new Intl.DateTimeFormat(formattingLocale(), {
      timeZone,
      timeZoneName: 'short',
    })
      .formatToParts(new Date(value))
      .find((part) => part.type === 'timeZoneName')?.value ?? timeZone
  );
}

/** The row's second line: what the event concerns, who recorded it and in which system. */
function rowContext(item: ActivityEvent) {
  return [
    ...activitySubject(item),
    actorLabel(item.actor, { email: false }),
    ...(item.system ? [providerName(item.system)] : []),
  ];
}

/** Names a row for assistive technology with its outcome and time, which the dot only shows. */
function rowLabel(item: ActivityEvent, timeZone: string) {
  return m.activity_row_label({
    title: activityTitle(item),
    context: rowContext(item).join(', '),
    outcome: activityLabel(item.outcome, item.system),
    time: formatWorkspaceInstant(item.recordedAt, timeZone),
  });
}

/** The row's outcome and, when recorded, the mode it ran in; plain recordings show neither. */
function ActivityStatus({ item }: { item: ActivityEvent }) {
  return (
    <>
      {item.mode !== 'unrecorded' ? (
        <Badge tone="accent">{activityLabel(item.mode)}</Badge>
      ) : null}
      {item.outcome !== 'recorded' ? (
        <StatePill state={activityState(item.outcome)}>
          {activityLabel(item.outcome, item.system)}
        </StatePill>
      ) : null}
    </>
  );
}

/** Copies the address of the open event, which keeps the view and opens the same event. */
function CopyEventLink() {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);

    return () => clearTimeout(timer);
  }, [copied]);
  const label = copied ? m.activity_link_copied() : m.activity_copy_link();

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(window.location.href)
          .then(() => setCopied(true));
      }}
    >
      {copied ? <Check aria-hidden="true" /> : <Link2 aria-hidden="true" />}
    </Button>
  );
}

const outcomeTones = {
  verified: 'success',
  failed: 'danger',
  uncertain: 'warning',
  escalated: 'warning',
  approved: 'info',
  attempted: 'info',
  provider_accepted: 'info',
  rejected: 'neutral',
  manually_disposed: 'neutral',
  recorded: 'neutral',
} as const satisfies Record<ActivityEvent['outcome'], string>;

/**
 * The open event: its outcome and what that does and doesn't establish, the record to act on,
 * its recorded facts, the steps that led to it and the identifiers to quote.
 */
function ActivityEventDetail({
  item,
  organizationId,
  sources,
  navigate,
}: {
  item: ActivityEvent;
  organizationId: string;
  sources: readonly ActivitySource[];
  navigate: (href: string) => void;
}) {
  const timeZone = useContext(WorkspaceTimezone);
  const [routine, setRoutine] = useState(false);
  const explanation = activityOutcomeExplanation(item.outcome, item.system);
  const record = activityRecordLink(item, organizationId);
  const steps = activitySteps(item);
  const routineCount = steps.filter((step) => step.routine).length;
  const subject = activitySubject(item);

  return (
    <div className="activity-detail">
      <div className="activity-detail-status">
        <StatePill state={activityState(item.outcome)}>
          {activityLabel(item.outcome, item.system)}
        </StatePill>
        {item.mode !== 'unrecorded' ? (
          <Badge tone="accent">{activityLabel(item.mode)}</Badge>
        ) : null}
        <time dateTime={item.recordedAt}>
          {formatWorkspaceInstant(item.recordedAt, timeZone)}
        </time>
      </div>
      {subject.length ? (
        <p className="activity-detail-subject">{subject.join(' · ')}</p>
      ) : null}
      {explanation ? (
        <Alert tone={outcomeTones[item.outcome]}>{explanation}</Alert>
      ) : null}
      {record ? (
        <a
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
          href={record.href}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey) return;
            event.preventDefault();
            navigate(record.href);
          }}
        >
          {record.label}
        </a>
      ) : null}
      <EventFacts item={item} sources={sources} group />
      {steps.length > 1 ? (
        <section className="activity-detail-section">
          <div className="activity-detail-section-head">
            <h3 className="collection-preview-heading">
              {m.activity_section_steps()}
            </h3>
            {routineCount ? (
              <Button
                variant="ghost"
                size="sm"
                aria-pressed={routine}
                onClick={() => setRoutine(!routine)}
              >
                {routine
                  ? m.activity_steps_hide_routine()
                  : m.activity_steps_show_routine({ count: routineCount })}
              </Button>
            ) : null}
          </div>
          <ol className="activity-steps">
            {steps
              .filter((step) => routine || !step.routine)
              .map(({ event, current, routine: quiet }) => (
                <li
                  key={event.id}
                  data-current={current || undefined}
                  data-routine={quiet || undefined}
                >
                  <StateDot state={activityStepState(event)} />
                  <div className="activity-step">
                    <p className="activity-step-title">
                      <strong>{activityLabel(event.action)}</strong>
                      {event.outcome !== 'recorded' ||
                      event.verificationPhase === 'pending' ? (
                        <span>{activityStepOutcome(event)}</span>
                      ) : null}
                    </p>
                    <p className="activity-step-meta">
                      <time
                        dateTime={event.recordedAt}
                        title={formatWorkspaceInstant(
                          event.recordedAt,
                          timeZone,
                        )}
                      >
                        {formatDateTime(event.recordedAt, {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                          timeZone,
                        })}
                      </time>
                      {' · '}
                      {actorLabel(event.actor, { email: false })}
                    </p>
                    {current ? null : (
                      <Disclosure
                        variant="plain"
                        className="activity-step-details"
                      >
                        <summary>{m.activity_step_details()}</summary>
                        <EventFacts item={event} sources={sources} />
                      </Disclosure>
                    )}
                  </div>
                </li>
              ))}
          </ol>
        </section>
      ) : null}
      {item.evidenceRefs.length ? (
        <section className="activity-detail-section">
          <h3 className="collection-preview-heading">
            {m.activity_detail_evidence()}
          </h3>
          <ul className="activity-evidence">
            {item.evidenceRefs.map((ref, index) => (
              <li key={`${index}:${ref}`}>
                <code>{ref}</code>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <Disclosure className="activity-ids">
        <summary>{m.activity_section_ids()}</summary>
        <EventIds item={item} />
      </Disclosure>
    </div>
  );
}

/**
 * The facts an event recorded, leaving out what it didn't record. With `group`, the event stands
 * for its steps: its proposed change may come from an earlier step. A step's facts include its
 * evidence and own identifier, since each step is a separate record.
 */
function EventFacts({
  item,
  sources,
  group = false,
}: {
  item: ActivityEvent;
  sources: readonly ActivitySource[];
  group?: boolean;
}) {
  const timeZone = useContext(WorkspaceTimezone);
  const summary = group
    ? [item, ...(item.steps ?? [])].find((event) => event.summary)?.summary
    : item.summary;
  const operational = item.type !== 'procurement' && item.type !== 'access';
  const change =
    operational && summary ? activityChangeLabel(summary) : undefined;
  const occurredApart =
    item.occurredAt &&
    Math.abs(Date.parse(item.occurredAt) - Date.parse(item.recordedAt)) >=
      60_000;
  const facts: [string, ReactNode][] = [
    [m.activity_detail_actor(), actorLabel(item.actor, { email: true })],
  ];
  if (change && change !== activityTitle(item))
    facts.push([m.activity_detail_proposed_change(), change]);
  if (item.type === 'procurement' && item.summary)
    facts.push([
      m.activity_detail_reason(),
      operatorCodeMessages[item.summary]
        ? operatorCodeLabel(item.summary)
        : item.summary,
    ]);
  const resource = activityResourceLabel(item);
  if (resource) facts.push([m.activity_detail_record(), resource]);
  if (item.connections.length)
    facts.push([
      m.activity_detail_connections(),
      formatList(
        item.connections.map(
          (connection) =>
            sources.find((source) => source.id === connection.id)?.label ??
            m.activity_detail_connection_value({
              system: connection.system
                ? providerName(connection.system)
                : m.activity_detail_unknown_system(),
              id: connection.id.slice(0, 8),
            }),
        ),
      ),
    ]);
  if (occurredApart)
    facts.push([
      m.activity_detail_occurred(),
      formatWorkspaceInstant(item.occurredAt!, timeZone),
    ]);
  if (item.dispatch)
    facts.push([
      m.activity_detail_request(),
      activityDetailLabel('dispatch', item.dispatch),
    ]);
  if (item.executionState)
    facts.push([
      m.activity_detail_change_state(),
      activityDetailLabel('executionState', item.executionState),
    ]);
  if (item.verificationPhase)
    facts.push([
      m.activity_detail_check_stage(),
      activityDetailLabel('verificationPhase', item.verificationPhase),
    ]);
  if (item.verification)
    facts.push([
      m.activity_detail_check_result(),
      activityDetailLabel('verification', item.verification),
    ]);
  if (item.failureCode)
    facts.push([
      m.activity_detail_error_code(),
      operatorCodeMessages[item.failureCode]
        ? operatorCodeLabel(item.failureCode)
        : item.failureCode,
    ]);

  return (
    <>
      <dl className="collection-preview-facts activity-facts">
        {facts.map(([label, value]) => (
          <PreviewFact key={label} label={label}>
            {value}
          </PreviewFact>
        ))}
      </dl>
      {group ? null : (
        <>
          {item.evidenceRefs.length ? (
            <ul className="activity-evidence">
              {item.evidenceRefs.map((ref, index) => (
                <li key={`${index}:${ref}`}>
                  <code>{ref}</code>
                </li>
              ))}
            </ul>
          ) : null}
          <EventIds item={item} />
        </>
      )}
    </>
  );
}

/** The identifiers to quote when asking about an event, in a monospaced, selectable list. */
function EventIds({ item }: { item: ActivityEvent }) {
  const ids: [string, string | null | undefined][] = [
    [m.activity_detail_event_id(), item.id],
    [m.activity_detail_issue_id(), item.exceptionId],
    [
      item.type === 'procurement'
        ? m.activity_detail_purchase_order()
        : m.activity_detail_proposal(),
      item.proposalId,
    ],
    [m.activity_detail_attempt(), item.attemptId],
    [m.activity_detail_workflow_run(), item.workflowRunId],
  ];

  return (
    <dl className="activity-ids-list">
      {ids.map(([label, value]) =>
        value ? (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <code>{value}</code>
            </dd>
          </div>
        ) : null,
      )}
    </dl>
  );
}
