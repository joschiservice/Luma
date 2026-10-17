import './exceptions.css';

import {
  type CaseSummary,
  type CollectionGroup,
  collectionWhereIssues,
  issuesCatalog,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import {
  CaseLoading,
  CaseNotice,
} from '@luma/ui/components/issues/case-investigation';
import { sourceLabel } from '@luma/ui/components/issues/case-presentation';
import { IssueInspectorHeader } from '@luma/ui/components/issues/issue-inspector-header';
import { IssuePanelLayout } from '@luma/ui/components/issues/issue-panel-layout';
import { IssueSplitView } from '@luma/ui/components/issues/issue-split-view';
import { IssueSummary } from '@luma/ui/components/issues/issue-summary';
import { issueViews } from '@luma/ui/components/issues/issue-views';
import { Button } from '@luma/ui/components/primitives/button';
import { CollectionToolbar } from '@luma/ui/components/primitives/collection-toolbar';
import { Empty } from '@luma/ui/components/primitives/empty';
import { Pagination } from '@luma/ui/components/primitives/pagination';
import { RefreshButton } from '@luma/ui/components/primitives/refresh-button';
import {
  listShortcutGroup,
  ShortcutHelp,
} from '@luma/ui/components/primitives/shortcut-help';
import { WorkspaceTimezone } from '@luma/ui/components/primitives/workspace-date';
import { useListKeyboard } from '@luma/ui/lib/list-keyboard';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Link,
  useMatch,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { ChevronRight, Maximize2 } from 'lucide-react';
import { useContext, useEffect, useRef, useState } from 'react';

import { useCollectionControls } from '../../kit/collections/controls';
import { DescribedFilter } from '../../kit/collections/described-filter';
import { useGroupPages } from '../../kit/collections/groups';
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
import { connectionsOptions } from '../../kit/connections/data';
import { SignInRedirect } from '../../kit/identity/common';
import { ApiError } from '../../kit/identity/data';
import { usePermissions } from '../../kit/identity/permissions';
import { membersOptions } from '../../kit/settings/data';
import { overviewOptions } from '../overview/data';
import { IssueActions } from './actions';
import {
  caseFilters,
  caseListQuery,
  casePageSize,
  casesKey,
  casesOptions,
  caseView,
  defaultCaseSort,
  type InboxSearch,
  matchesView,
} from './data';
import {
  issueGroupLabel,
  issuePresentation,
  issueProperties,
  issueShortcuts,
  segmentLabels,
} from './issue-list';
import { useCaseObservation } from './observation';
import { LiveCaseDetail } from './progress';
import { issueGroups, IssueResults } from './results';

const sameSort = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

/**
 * The view as the issue list shows it. A view without its own sort uses urgency, and choosing
 * urgency again keeps the view unchanged. Issues show as a list or a board: a board without a
 * grouping groups by state, and a table from another list's state shows as a list.
 */
function issueListView(view: CollectionView): CollectionView {
  const layout = view.state.layout === 'board' ? 'board' : 'list';

  return {
    ...view,
    state: {
      ...view.state,
      sort: view.state.sort ?? defaultCaseSort,
      layout: layout === 'board' && !view.state.group ? 'list' : layout,
    },
    change: (next) => {
      const board = next.layout === 'board';
      const group =
        board && !next.group
          ? { field: 'state', showEmpty: false }
          : next.group;

      view.change({
        ...next,
        group,
        layout: board ? 'board' : 'list',
        sort:
          !view.base.sort && sameSort(next.sort, defaultCaseSort)
            ? null
            : next.sort,
      });
    },
  };
}

/**
 * Displays the issue list with the member's view (conditions, sort, grouping, layout and
 * properties from the URL and remembered state) and the selected investigation beside it. J and
 * K move through the issues, Space opens or closes the focused one, / focuses search, F opens
 * the condition builder and Escape closes the issue. Search can match record IDs, so its text
 * stays in page state; a link's `?q=` is adopted and removed from the address.
 */
export function Inbox() {
  const { organizationId } = useParams({
    from: '/app/$organizationId/exceptions',
  });

  return <TenantInbox key={organizationId} organizationId={organizationId} />;
}

function TenantInbox({ organizationId }: { organizationId: string }) {
  const selected = useMatch({
    from: '/app/$organizationId/exceptions/$exceptionId',
    shouldThrow: false,
  });
  const exceptionId = selected?.params.exceptionId;
  const search = useSearch({ from: '/app/$organizationId/exceptions' });
  const navigate = useNavigate({ from: '/app/$organizationId/exceptions' });
  const client = useQueryClient();
  const permissions = usePermissions(organizationId);
  const can = permissions.can;
  const timeZone = useContext(WorkspaceTimezone);
  const online = useOnline();
  const destination = {
    to: exceptionId
      ? ('/app/$organizationId/exceptions/$exceptionId' as const)
      : ('/app/$organizationId/exceptions' as const),
    params: { organizationId, exceptionId: exceptionId ?? '' },
  };
  const go = (next: InboxSearch) =>
    void navigate({ ...destination, search: next, resetScroll: false });
  const view = useCollectionView({
    catalog: issuesCatalog,
    organizationId,
    search,
    // Changing the view keeps the open issue and its workflow, and starts at page one.
    navigate: (next: Partial<CollectionSearch>) =>
      go({ ...(search.shadow ? { shadow: search.shadow } : {}), ...next }),
  });
  const listView = issueListView(view);
  const state = listView.state;
  const segment = caseView(state.segment);
  // Naming the view keeps the remembered view from replacing the one the link opened.
  const [q, setQ] = usePrivateSearch(
    search.q,
    () =>
      void navigate({
        ...destination,
        search: (current) => ({
          ...current,
          q: undefined,
          view: current.view ?? viewParam(view.key),
        }),
        replace: true,
        resetScroll: false,
      }),
  );
  const members = useQuery(membersOptions(organizationId));
  const connections = useQuery(connectionsOptions(organizationId));
  const overview = useQuery(overviewOptions(organizationId, '24h'));
  const options = {
    members: (members.data ?? []).map((member) => ({
      value: member.userId,
      label: member.name || member.email || m.decisions_member_fallback(),
    })),
    systems: [
      ...new Set(
        (connections.data ?? []).map((connection) => connection.target.kind),
      ),
    ].map((system) => ({ value: system, label: sourceLabel(system) })),
  };

  const ready = permissions.ready;
  const clientIssues = ready
    ? collectionWhereIssues(issuesCatalog, state.where)
    : [];
  const query = caseListQuery(state, { q, cursor: search.cursor }, timeZone);
  const list = useQuery({
    ...casesOptions(organizationId, query),
    enabled: ready && !clientIssues.length,
  });
  // With a page cursor, a refused request means the page link is stale, not the view.
  const serverIssue = search.cursor
    ? undefined
    : collectionServerIssue(list.error);
  const controls = useCollectionControls({
    view: listView,
    catalog: issuesCatalog,
    presentation: issuePresentation,
    can,
    options,
    title: 'summary',
    defaultProperties: issueProperties,
    serverIssues: serverIssue ? [serverIssue] : [],
    owner: { field: 'owner', members: options.members, unassigned: true },
  });
  const issues = [...clientIssues, ...(serverIssue ? [serverIssue] : [])];
  const repair = issues.length
    ? () => view.change(repairedState(issuesCatalog, view.state, issues, can))
    : undefined;
  const error: CollectionError | undefined = clientIssues.length
    ? { kind: 'invalid', message: m.collections_needs_repair() }
    : collectionError(list.error, search.cursor);
  const listData =
    error?.kind === 'access' || error?.kind === 'invalid'
      ? undefined
      : list.data;

  const grouping = state.group;
  const groupPrefix = `${groupOf(state) ?? ''}=`;
  const collapsed = view.display.collapsedGroups
    .filter((id) => id.startsWith(groupPrefix))
    .map((id) => id.slice(groupPrefix.length));
  const more = useGroupPages<CaseSummary>({
    resetKey: JSON.stringify([organizationId, query]),
    load: (key: CollectionGroup['key'], cursor: string) =>
      client
        .fetchQuery(
          casesOptions(
            organizationId,
            caseListQuery(state, { q }, timeZone, { key, cursor }),
          ),
        )
        .then((page) => ({
          rows: page.items,
          nextCursor: page.groups?.[0]?.nextCursor ?? page.nextCursor,
        })),
  });
  const groups =
    listData && grouping
      ? issueGroups({
          items: listData.items,
          groups: listData.groups,
          grouping,
          more,
        })
      : [];
  // A refresh can return a case twice while it moves between pages.
  const rows = [
    ...new Map(
      [
        ...(listData?.items ?? []),
        ...groups.flatMap((group) => group.rows),
      ].map((row) => [row.id, row]),
    ).values(),
  ];
  // Keys in the order rows appear on screen, so the list keys follow it.
  const keys = grouping
    ? groups
        .filter(
          (group) => state.layout === 'board' || !collapsed.includes(group.id),
        )
        .flatMap((group) => group.rows.map((row) => row.id))
    : rows.map((row) => row.id);
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
    nextCursor: grouping ? null : listData?.nextCursor,
    go: ({ cursor, page }) => go({ ...search, cursor, page }),
  });
  const observation = useCaseObservation(organizationId, exceptionId ?? '');
  const detail = observation.snapshot;
  const pane = useRef<HTMLElement>(null);
  const listPane = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const previous = useRef<string | undefined>(undefined);
  const savedScroll = useRef(0);
  // Keys open issues beside the list without moving focus out of it.
  const openedByKey = useRef(false);
  const [help, setHelp] = useState(false);
  useEffect(() => {
    // Only navigation moves focus. Refetches leave the reader's position alone.
    if (exceptionId !== previous.current) {
      if (exceptionId && !openedByKey.current)
        pane.current?.focus({ preventScroll: true });
      else if (!exceptionId && previous.current && !openedByKey.current) {
        const row = document.getElementById(`case-${previous.current}`);
        (row ?? listPane.current)?.focus({ preventScroll: true });
        if (listPane.current) listPane.current.scrollTop = savedScroll.current;
      }
      openedByKey.current = false;
      previous.current = exceptionId;
    }
  }, [exceptionId]);
  const denied = observation.denied;
  const item = denied ? undefined : detail.data?.detail;
  const moved = item && !matchesView(item, state);
  const position = keys.indexOf(exceptionId ?? '');
  const next = rows.find((row) => row.id === keys[position + 1]);
  const keyboard = useListKeyboard({
    rows: listPane,
    count: keys.length,
    keys,
    preview: {
      open: exceptionId,
      onOpenChange: (id) => {
        openedByKey.current = true;
        if (!id) savedScroll.current = listPane.current?.scrollTop ?? 0;
        if (id)
          void navigate({
            to: '/app/$organizationId/exceptions/$exceptionId',
            params: { organizationId, exceptionId: id },
            search,
            resetScroll: false,
          });
        else
          void navigate({
            to: '/app/$organizationId/exceptions',
            params: { organizationId },
            search,
            resetScroll: false,
          });
      },
    },
    onFocusSearch: () => searchInput.current?.focus(),
    onOpenFilter: () => controls.conditions.onOpenChange?.(true),
    onShowHelp: () => setHelp(true),
  });
  const refresh = () => {
    if (search.cursor) go({ ...search, cursor: undefined, page: undefined });
    void client.invalidateQueries({ queryKey: casesKey(organizationId) });
    void connections.refetch();
    void overview.refetch();
  };

  if (list.error instanceof ApiError && list.error.status === 401)
    return <SignInRedirect />;

  const filtered = !!q.trim() || state.where.conditions.length > 0;
  const viewName = view.saved?.name ?? segmentLabels[segment]();
  const sortLabel =
    issuePresentation[state.sort?.field ?? 'urgency']?.label() ?? '';
  const groupLabel = (key: CollectionGroup['key']) =>
    issueGroupLabel({
      field: grouping?.field ?? '',
      granularity: grouping?.granularity,
      key,
      options,
      rows,
    });
  const link = (row: CaseSummary) => (
    <Link
      id={`case-${row.id}`}
      to="/app/$organizationId/exceptions/$exceptionId"
      params={{ organizationId, exceptionId: row.id }}
      search={search}
      resetScroll={false}
      onClick={() => {
        savedScroll.current = listPane.current?.scrollTop ?? 0;
      }}
    />
  );
  const empty = (
    <Empty className="inbox-empty">
      <span aria-hidden="true">○</span>
      <h2>
        {filtered
          ? m.exceptions_empty_filtered_title()
          : segment === 'needs_you'
            ? m.exceptions_empty_needs_you_title()
            : segment === 'history'
              ? m.exceptions_empty_history_title()
              : m.exceptions_empty_view_title()}
      </h2>
      <p>
        {filtered
          ? m.exceptions_empty_filtered_text()
          : segment === 'needs_you'
            ? m.exceptions_empty_needs_you_text()
            : m.exceptions_empty_view_text()}
      </p>
      {filtered ? (
        <Button
          variant="outline"
          onClick={() => {
            setQ('');
            controls.clearConditions();
          }}
        >
          {m.common_clear_filters()}
        </Button>
      ) : null}
    </Empty>
  );

  return (
    <div className={`inbox page-full ${exceptionId ? 'inbox-selected' : ''}`}>
      <header className="inbox-heading">
        <h1 className="sr-only">{m.exceptions_page_title()}</h1>
        <IssueSummary
          review={
            overview.isError || overview.isPaused
              ? undefined
              : overview.data?.attentionCount
          }
          open={
            overview.isError || overview.isPaused
              ? undefined
              : overview.data?.activeCount
          }
          verified={
            overview.isError || overview.isPaused
              ? undefined
              : overview.data?.verifiedResolutions
          }
          loading={overview.isPending}
        />
      </header>
      <CollectionToolbar
        className="inbox-toolbar"
        views={
          <CollectionViewBar
            organizationId={organizationId}
            view={view}
            path="exceptions"
            segmentLabel={(value) => segmentLabels[caseView(value)]()}
            segments={issueViews()}
          />
        }
        search={{
          value: q || undefined,
          onChange: (text) => {
            setQ(text ?? '');
            go(caseFilters(search));
          },
          label: m.exceptions_search_label(),
          placeholder: m.exceptions_search_placeholder(),
          inputRef: searchInput,
        }}
        filters={controls.filters}
        conditions={controls.conditions}
        actions={
          <DescribedFilter
            organizationId={organizationId}
            domain="issues"
            listName={m.exceptions_page_title()}
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
        }
        display={controls.display}
        sort={controls.sort}
        onClear={() => {
          setQ('');
          controls.clearConditions();
        }}
        onRefresh={refresh}
        refreshing={list.isFetching || detail.isFetching}
        refreshLabel={m.issues_refresh_issues()}
      />
      {overview.isError && (
        <CaseNotice title={m.exceptions_summary_unavailable_title()}>
          {m.exceptions_summary_unavailable_text()}
        </CaseNotice>
      )}
      <IssueSplitView
        selected={Boolean(exceptionId)}
        list={
          <div
            className="inbox-list"
            ref={listPane}
            tabIndex={-1}
            aria-label={m.exceptions_list_label()}
          >
            {connections.isError ? (
              <CaseNotice title={m.exceptions_connections_unavailable_title()}>
                {m.exceptions_connections_unavailable_text()}
              </CaseNotice>
            ) : connections.data &&
              !connections.data.some((c) => c.status === 'active') ? (
              <CaseNotice title={m.exceptions_no_connections_title()}>
                {rich(m.exceptions_no_connections_text, {
                  link: (
                    <Link
                      to="/app/$organizationId/apps"
                      params={{ organizationId }}
                    >
                      {m.exceptions_no_connections_link()}
                    </Link>
                  ),
                })}
              </CaseNotice>
            ) : null}
            <CollectionNotices
              offline={!online}
              error={error}
              hasRows={!!listData}
              retry={() => void list.refetch()}
              firstPage={() =>
                go({ ...search, cursor: undefined, page: undefined })
              }
              repair={repair}
            />
            {listData?.groupsTruncated ? (
              <CaseNotice title={m.collections_groups_truncated()} />
            ) : null}
            {list.isPending && !error ? (
              <CaseLoading />
            ) : listData ? (
              <>
                {listData.coverage === 'unobserved' ? (
                  <CaseNotice title={m.exceptions_no_data_title()}>
                    {m.exceptions_no_data_text()}
                  </CaseNotice>
                ) : null}
                <IssueResults
                  items={rows}
                  groups={listData.groups}
                  layout={state.layout}
                  density={state.density}
                  grouping={grouping}
                  caption={
                    grouping
                      ? m.exceptions_groups_label({
                          field:
                            issuePresentation[grouping.field]?.label() ??
                            grouping.field,
                        })
                      : m.exceptions_list_caption({
                          view: viewName,
                          sort: sortLabel,
                        })
                  }
                  link={link}
                  empty={empty}
                  properties={controls.properties}
                  focusedKey={keyboard.focusedKey}
                  current={exceptionId}
                  groupLabel={groupLabel}
                  collapsed={collapsed}
                  onCollapsedChange={(id, closed) =>
                    view.setDisplay({
                      ...view.display,
                      collapsedGroups: [
                        ...view.display.collapsedGroups.filter(
                          (entry) => entry !== `${groupPrefix}${id}`,
                        ),
                        ...(closed ? [`${groupPrefix}${id}`] : []),
                      ].slice(-100),
                    })
                  }
                  more={more}
                />
                {!grouping && listData.items.length ? (
                  <Pagination
                    count={listData.items.length}
                    totalCount={listData.totalCount}
                    offset={listData.offset}
                    page={paging.page}
                    pageSize={casePageSize}
                    hasNext={!!paging.next}
                    onPrevious={paging.previous}
                    onNext={() => paging.next?.()}
                    formatTotal={(count) =>
                      m.exceptions_pagination_total({ count })
                    }
                    label={m.exceptions_pagination_label()}
                  />
                ) : null}
                {paging.first && !paging.previous ? (
                  <Button variant="ghost" onClick={paging.first}>
                    {m.exceptions_first_page()}
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
        }
        detail={
          <section
            className="inbox-detail"
            ref={pane}
            tabIndex={-1}
            aria-label={m.exceptions_selected_label()}
            onKeyDown={(event) => {
              if (
                event.key !== 'Escape' ||
                event.defaultPrevented ||
                !exceptionId
              )
                return;
              // Nested controls retain Escape for their own dismissal or editing behavior.
              if (
                event.target instanceof Element &&
                event.target.closest(
                  'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]',
                )
              )
                return;
              event.preventDefault();
              void navigate({
                to: '/app/$organizationId/exceptions',
                params: { organizationId },
                search,
                resetScroll: false,
              });
            }}
          >
            {exceptionId ? (
              <IssuePanelLayout
                key={`${organizationId}:${exceptionId}`}
                item={item}
                actions={
                  item ? (
                    <IssueActions
                      key={exceptionId}
                      organizationId={organizationId}
                      exceptionId={item.id}
                      observation={observation}
                      initialWorkflow={search.shadow}
                      connectionLabels={Object.fromEntries(
                        (connections.data ?? []).map((connection) => [
                          connection.id,
                          m.exceptions_connection_label({
                            connection: connection.label,
                            system: sourceLabel(connection.target.kind),
                          }),
                        ]),
                      )}
                    />
                  ) : null
                }
                header={
                  <IssueInspectorHeader
                    refresh={
                      <RefreshButton
                        variant="ghost"
                        label={m.exceptions_refresh_issue()}
                        onClick={observation.restart}
                      />
                    }
                    className="inbox-case-nav"
                    item={item}
                    fallback={
                      detail.isError || denied
                        ? m.exceptions_issue_unavailable()
                        : m.exceptions_issue_loading()
                    }
                    onClose={() =>
                      void navigate({
                        to: '/app/$organizationId/exceptions',
                        params: { organizationId },
                        search,
                        resetScroll: false,
                      })
                    }
                    openPage={
                      item ? (
                        <Link
                          to="/app/$organizationId/exceptions/$exceptionId/detail"
                          params={{ organizationId, exceptionId }}
                          search={search}
                          className="issue-panel-open-page"
                          aria-label={m.exceptions_open_full_page()}
                          title={m.exceptions_open_full_page()}
                        >
                          <Maximize2 size={16} aria-hidden="true" />
                        </Link>
                      ) : null
                    }
                    next={
                      next ? (
                        <Link
                          to="/app/$organizationId/exceptions/$exceptionId"
                          params={{ organizationId, exceptionId: next.id }}
                          className="issue-panel-next"
                          aria-label={m.exceptions_next_issue()}
                          title={m.exceptions_next_issue()}
                          search={search}
                          resetScroll={false}
                        >
                          <ChevronRight size={18} aria-hidden="true" />
                        </Link>
                      ) : null
                    }
                  />
                }
              >
                {detail.isPending ? <CaseLoading /> : null}
                {detail.isError || denied ? (
                  <CaseNotice
                    error
                    title={
                      denied
                        ? m.exceptions_issue_unavailable()
                        : m.exceptions_detail_error_title()
                    }
                  >
                    {denied
                      ? m.exceptions_detail_denied_text()
                      : m.exceptions_detail_error_text()}
                  </CaseNotice>
                ) : null}
                {moved ? (
                  <CaseNotice title={m.exceptions_moved_title()}>
                    {m.exceptions_moved_text()}
                  </CaseNotice>
                ) : null}
                {item ? (
                  <>
                    <LiveCaseDetail
                      key={`${organizationId}:${exceptionId}`}
                      observation={observation}
                      expanded
                    />
                  </>
                ) : null}
              </IssuePanelLayout>
            ) : (
              <div className="inbox-placeholder">
                <h2>{m.exceptions_placeholder_title()}</h2>
                <p>{m.exceptions_placeholder_text()}</p>
              </div>
            )}
          </section>
        }
      />
      <ShortcutHelp
        open={help}
        onOpenChange={setHelp}
        groups={[listShortcutGroup(issueShortcuts)]}
      />
    </div>
  );
}
