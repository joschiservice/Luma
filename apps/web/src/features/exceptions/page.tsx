import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import {
  caseLabel,
  CaseLoading,
  CaseNotice,
  CaseRow,
} from '@luma/ui/components/issues/case-investigation';
import { IssueInspectorHeader } from '@luma/ui/components/issues/issue-inspector-header';
import { IssueListToolbar } from '@luma/ui/components/issues/issue-list-toolbar';
import { IssuePanelLayout } from '@luma/ui/components/issues/issue-panel-layout';
import { IssueSplitView } from '@luma/ui/components/issues/issue-split-view';
import { IssueSummary } from '@luma/ui/components/issues/issue-summary';
import { IssueViewTabs } from '@luma/ui/components/issues/issue-view-tabs';
import { Button } from '@luma/ui/components/primitives/button';
import { Empty } from '@luma/ui/components/primitives/empty';
import { Pagination } from '@luma/ui/components/primitives/pagination';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Link,
  useMatch,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { ChevronRight, Maximize2, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { connectionsOptions } from '../connections/data';
import { IdentityError } from '../identity/data';
import { overviewOptions } from '../overview/data';
import { IssueActions } from './actions';
import { casesKey, casesOptions, type InboxSearch, matchesView } from './data';
import { useCaseObservation } from './observation';
import { LiveCaseDetail } from './progress';

/**
 * Displays the filtered case inbox and selected investigation using URL-backed navigation
 * state.
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
  const list = useQuery(casesOptions(organizationId, search));
  const observation = useCaseObservation(organizationId, exceptionId ?? '');
  const detail = observation.snapshot;
  const connections = useQuery(connectionsOptions(organizationId));
  const overview = useQuery(overviewOptions(organizationId, '24h'));
  const [pageCursors, setPageCursors] = useState<
    Record<string, (string | undefined)[]>
  >({});
  const filterKey = JSON.stringify([
    search.view,
    search.class,
    search.state,
    search.severity,
  ]);
  const cursors = pageCursors[filterKey] ?? [undefined];
  const pageIndex = cursors.indexOf(search.cursor);
  const goNext = () => {
    if (!list.data?.nextCursor) return;
    const nextCursor = list.data.nextCursor;
    if (pageIndex >= 0)
      setPageCursors((previous) => ({
        ...previous,
        [filterKey]: [...cursors.slice(0, pageIndex + 1), nextCursor],
      }));
    void navigate({
      ...destination,
      search: { ...search, cursor: nextCursor },
      resetScroll: false,
    });
  };
  const goPrevious =
    pageIndex > 0
      ? () => {
          void navigate({
            ...destination,
            search: { ...search, cursor: cursors[pageIndex - 1] },
            resetScroll: false,
          });
        }
      : undefined;
  const pane = useRef<HTMLElement>(null);
  const listPane = useRef<HTMLDivElement>(null);
  const previous = useRef<string | undefined>(undefined);
  const savedScroll = useRef(0);
  useEffect(() => {
    // Only navigation moves focus. Refetches leave the reader's position alone.
    if (exceptionId !== previous.current) {
      if (exceptionId) pane.current?.focus({ preventScroll: true });
      else if (previous.current) {
        const row = document.getElementById(`case-${previous.current}`);
        (row ?? listPane.current)?.focus({ preventScroll: true });
        if (listPane.current) listPane.current.scrollTop = savedScroll.current;
      }
      previous.current = exceptionId;
    }
  }, [exceptionId]);
  const destination = {
    to: exceptionId
      ? ('/app/$organizationId/exceptions/$exceptionId' as const)
      : ('/app/$organizationId/exceptions' as const),
    params: { organizationId, exceptionId: exceptionId ?? '' },
  };
  const update = (patch: Partial<InboxSearch>) =>
    void navigate({
      ...destination,
      search: { ...search, ...patch, cursor: undefined },
      resetScroll: false,
    });
  const denied = observation.denied;
  const item = denied ? undefined : detail.data?.detail;
  const moved = item && !matchesView(item, search);
  const listDenied =
    list.error instanceof IdentityError &&
    [401, 403, 404].includes(list.error.status);
  const listData = listDenied ? undefined : list.data;
  const selectedIndex =
    listData?.items.findIndex((row) => row.id === exceptionId) ?? -1;
  const next = listData?.items[selectedIndex + 1];
  const refresh = () => {
    if (search.cursor)
      void navigate({
        ...destination,
        search: { ...search, cursor: undefined },
        resetScroll: false,
      });
    void client.invalidateQueries({ queryKey: casesKey(organizationId) });
    void connections.refetch();
    void overview.refetch();
  };

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
      <IssueListToolbar
        filters={search}
        onFiltersChange={update}
        onRefresh={refresh}
        refreshing={list.isFetching || detail.isFetching}
        views={
          <IssueViewTabs
            value={search.view}
            renderLink={(view) => (
              <Link
                {...destination}
                search={{ ...search, view, cursor: undefined }}
                resetScroll={false}
              />
            )}
          />
        }
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
            {list.isError ? (
              <CaseNotice error title={m.exceptions_list_error_title()}>
                {listData
                  ? m.exceptions_list_error_stale()
                  : m.exceptions_list_error_text()}
                {search.cursor ? (
                  <Button variant="outline" onClick={() => update({})}>
                    {m.exceptions_first_page()}
                  </Button>
                ) : null}
              </CaseNotice>
            ) : null}
            {list.isPending ? (
              <CaseLoading />
            ) : listData ? (
              <>
                {listData.coverage === 'unobserved' ? (
                  <CaseNotice title={m.exceptions_no_data_title()}>
                    {m.exceptions_no_data_text()}
                  </CaseNotice>
                ) : null}
                {!listData.items.length ? (
                  <Empty className="inbox-empty">
                    <span aria-hidden="true">○</span>
                    <h2>
                      {[search.class, search.state, search.severity].some(
                        Boolean,
                      )
                        ? m.exceptions_empty_filtered_title()
                        : search.view === 'needs_you'
                          ? m.exceptions_empty_needs_you_title()
                          : search.view === 'history'
                            ? m.exceptions_empty_history_title()
                            : m.exceptions_empty_view_title()}
                    </h2>
                    <p>
                      {[search.class, search.state, search.severity].some(
                        Boolean,
                      )
                        ? m.exceptions_empty_filtered_text()
                        : search.view === 'needs_you'
                          ? m.exceptions_empty_needs_you_text()
                          : m.exceptions_empty_view_text()}
                    </p>
                  </Empty>
                ) : (
                  <ul className="inbox-rows">
                    {[
                      ...new Map(
                        listData.items.map((row) => [row.id, row]),
                      ).values(),
                    ].map((row) => (
                      <li key={row.id}>
                        <Link
                          id={`case-${row.id}`}
                          to="/app/$organizationId/exceptions/$exceptionId"
                          params={{ organizationId, exceptionId: row.id }}
                          search={search}
                          resetScroll={false}
                          aria-current={
                            row.id === exceptionId ? 'page' : undefined
                          }
                          onClick={() => {
                            savedScroll.current =
                              listPane.current?.scrollTop ?? 0;
                          }}
                        >
                          <CaseRow item={row} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
                <Pagination
                  count={listData.items.length}
                  totalCount={listData.totalCount}
                  offset={listData.offset}
                  page={pageIndex >= 0 ? pageIndex + 1 : undefined}
                  hasNext={Boolean(listData.nextCursor)}
                  onPrevious={goPrevious}
                  onNext={goNext}
                  disabled={list.isFetching}
                  formatTotal={(count) =>
                    m.exceptions_pagination_total({ count })
                  }
                  label={m.exceptions_pagination_label()}
                />
                {search.cursor && pageIndex < 0 && (
                  <Button variant="ghost" onClick={() => update({})}>
                    {m.exceptions_first_page()}
                  </Button>
                )}
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
                            system: caseLabel(connection.target.kind),
                          }),
                        ]),
                      )}
                    />
                  ) : null
                }
                header={
                  <IssueInspectorHeader
                    refresh={
                      <Button
                        variant="ghost"
                        aria-label={m.exceptions_refresh_issue()}
                        title={m.exceptions_refresh_issue()}
                        onClick={observation.restart}
                        disabled={detail.isFetching}
                      >
                        <RefreshCw size={14} aria-hidden="true" />
                      </Button>
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
    </div>
  );
}
