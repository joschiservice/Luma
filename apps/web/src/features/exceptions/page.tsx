import { useEffect, useRef } from 'react';
import {
  Link,
  useParams,
  useMatch,
  useSearch,
  useNavigate,
} from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { caseClasses, caseStates } from '@luma/api-contract';
import { Button } from '@luma/ui/button';
import {
  CaseRow,
  CaseNotice,
  CaseLoading,
  caseLabel,
} from '@luma/ui/components/case-investigation';
import {
  casesOptions,
  caseOptions,
  casesKey,
  matchesView,
  type InboxSearch,
} from './data';
import { connectionsOptions } from '../connections/data';
import { IdentityError } from '../identity/data';
import { LiveCaseDetail } from './progress';
import { CaseResolution } from './resolution';

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
  const detail = useQuery(caseOptions(organizationId, exceptionId ?? ''));
  const connections = useQuery(connectionsOptions(organizationId));
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
  const denied =
    detail.error instanceof IdentityError &&
    [401, 403, 404].includes(detail.error.status);
  const item = denied ? undefined : detail.data;
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
  };
  return (
    <div className={`inbox ${exceptionId ? 'inbox-selected' : ''}`}>
      <header className="inbox-heading">
        <div>
          <p className="eyebrow">Exception Desk / Investigations</p>
          <h1>A clearer next step.</h1>
          <p>Investigated cases. Evidence before action.</p>
        </div>
        <Button
          variant="outline"
          onClick={refresh}
          disabled={list.isFetching || detail.isFetching}
        >
          Refresh
        </Button>
      </header>
      <div className="inbox-workspace">
        <div
          className="inbox-list"
          ref={listPane}
          tabIndex={-1}
          aria-label="Case inbox"
        >
          <nav className="inbox-views" aria-label="Case views">
            {(['needs_you', 'active', 'history'] as const).map((view) => (
              <Link
                key={view}
                {...destination}
                search={{ ...search, view, cursor: undefined }}
                resetScroll={false}
                aria-current={search.view === view ? 'page' : undefined}
              >
                {view === 'needs_you' ? 'Needs you' : caseLabel(view)}
              </Link>
            ))}
          </nav>
          <div className="inbox-filters">
            {(['state', 'class', 'severity'] as const).map((field) => (
              <label key={field}>
                {caseLabel(field)}
                <select
                  aria-label={caseLabel(field)}
                  value={search[field] ?? ''}
                  onChange={(event) =>
                    update({ [field]: event.target.value || undefined })
                  }
                >
                  <option value="">
                    All{' '}
                    {field === 'class'
                      ? 'classes'
                      : field === 'state'
                        ? 'states'
                        : 'severities'}
                  </option>
                  {(field === 'state'
                    ? caseStates
                    : field === 'class'
                      ? caseClasses
                      : ['high', 'medium']
                  ).map((value) => (
                    <option key={value} value={value}>
                      {caseLabel(value)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          {connections.isError ? (
            <CaseNotice title="Connection coverage unavailable">
              Case reads may still be available. Refresh to check connections.
            </CaseNotice>
          ) : connections.data &&
            !connections.data.some((c) => c.status === 'active') ? (
            <CaseNotice title="No active connections">
              Connect a commerce system to receive observations.{' '}
              <Link
                to="/app/$organizationId/connections"
                params={{ organizationId }}
              >
                Open connections
              </Link>
            </CaseNotice>
          ) : null}
          {list.isError ? (
            <CaseNotice error title="Inbox could not be refreshed">
              {listData ? 'The list below may be out of date. ' : ''}Try
              Refresh.
              {search.cursor ? (
                <Button variant="outline" onClick={() => update({})}>
                  Return to first page
                </Button>
              ) : null}
            </CaseNotice>
          ) : null}
          {list.isPending ? (
            <CaseLoading />
          ) : listData ? (
            <>
              {listData.coverage === 'unobserved' ? (
                <CaseNotice title="No observations yet">
                  Operational health is unknown until observations arrive.
                </CaseNotice>
              ) : null}
              {!listData.items.length ? (
                <div className="inbox-empty">
                  <span aria-hidden="true">○</span>
                  <h2>
                    {search.view === 'needs_you'
                      ? 'Nothing needs you.'
                      : search.view === 'history'
                        ? 'No history in this view.'
                        : 'No active cases in this view.'}
                  </h2>
                  <p>
                    {search.view === 'needs_you'
                      ? 'No cases match this attention queue. Active work and observation coverage are separate.'
                      : 'Try another view or adjust the filters.'}
                  </p>
                </div>
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
              <div className="inbox-pagination">
                {search.cursor ? (
                  <Link
                    {...destination}
                    search={{ ...search, cursor: undefined }}
                    resetScroll={false}
                  >
                    First page
                  </Link>
                ) : (
                  <span>{listData.items.length} cases</span>
                )}
                {listData.nextCursor ? (
                  <Link
                    {...destination}
                    search={{ ...search, cursor: listData.nextCursor }}
                    resetScroll={false}
                  >
                    Next page →
                  </Link>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
        <section
          className="inbox-detail"
          ref={pane}
          tabIndex={-1}
          aria-label="Selected case"
        >
          {exceptionId ? (
            <>
              <div className="inbox-case-nav">
                <Link
                  to="/app/$organizationId/exceptions"
                  params={{ organizationId }}
                  search={search}
                  resetScroll={false}
                >
                  ← Back to inbox
                </Link>
                {next ? (
                  <Link
                    to="/app/$organizationId/exceptions/$exceptionId"
                    params={{ organizationId, exceptionId: next.id }}
                    search={search}
                    resetScroll={false}
                  >
                    Next case →
                  </Link>
                ) : null}
              </div>
              <Button
                className="inbox-mobile-refresh"
                variant="outline"
                onClick={refresh}
                disabled={detail.isFetching}
              >
                Refresh case
              </Button>
              {detail.isPending ? <CaseLoading /> : null}
              {detail.isError ? (
                <CaseNotice
                  error
                  title={
                    denied ? 'Case unavailable' : 'Case could not be refreshed'
                  }
                >
                  {denied
                    ? 'This case is missing or you no longer have access.'
                    : 'The current investigation could not be confirmed. Refresh before relying on these findings.'}
                </CaseNotice>
              ) : null}
              {moved ? (
                <CaseNotice title="This case has left the current view">
                  Its state or attention requirement changed. It stays open here
                  while you finish reading.
                </CaseNotice>
              ) : null}
              {item ? (
                <>
                  <LiveCaseDetail
                    key={`${organizationId}:${exceptionId}`}
                    organizationId={organizationId}
                    exceptionId={exceptionId}
                  />
                  <CaseResolution
                    key={exceptionId}
                    organizationId={organizationId}
                    exceptionId={item.id}
                    disabled={detail.isError}
                    connectionLabels={Object.fromEntries(
                      (connections.data ?? []).map((connection) => [
                        connection.id,
                        `${connection.label} · ${caseLabel(connection.target.kind)}`,
                      ]),
                    )}
                  />
                </>
              ) : null}
            </>
          ) : (
            <div className="inbox-placeholder">
              <p className="eyebrow">From signal to understanding</p>
              <h2>
                Make room
                <br />
                for the whole story.
              </h2>
              <p>
                Select a case to see what happened,
                <br />
                what it means and the next step.
              </p>
              <span aria-hidden="true">↖</span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
