import './decisions.css';
import '../workflows/workflows.css';

import type {
  DecisionDomain,
  DecisionItem,
  DecisionList,
  DecisionReason,
  DecisionView,
} from '@luma/api-contract';
import { CaseNotice } from '@luma/ui/components/issues/case-investigation';
import { elapsed } from '@luma/ui/components/issues/case-presentation';
import { IssueSplitView } from '@luma/ui/components/issues/issue-split-view';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { CollectionToolbar } from '@luma/ui/components/primitives/collection-toolbar';
import { DomainIcon } from '@luma/ui/components/primitives/domain-icon';
import { Empty } from '@luma/ui/components/primitives/empty';
import { Pagination } from '@luma/ui/components/primitives/pagination';
import { StatePill } from '@luma/ui/components/primitives/state';
import { Switch } from '@luma/ui/components/primitives/switch';
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from '@luma/ui/components/primitives/tabs';
import {
  onlineManager,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { ChevronDown, ChevronUp, CircleHelp, LayoutGrid } from 'lucide-react';
import {
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { isTypingTarget } from '../../lib/keyboard';
import { SignInRedirect } from '../identity/common';
import { contextOptions, IdentityError } from '../identity/data';
import { membersOptions } from '../settings/data';
import {
  assignDecision,
  decisionOptions,
  decisionsKey,
  decisionsOptions,
  needsYouFilters,
  type NeedsYouSearch,
} from './data';
import { DecisionDeadline, DecisionInspector, type Member } from './inspector';
import { type DecisionUpdates, useDecisionUpdates, useNow } from './live';
import { OwnerReview } from './owner-review';
import {
  actionable,
  decisionStatus,
  domainIcons,
  domainLabels,
  emptyCopy,
  groupDecisions,
  impactLabels,
  kindLabels,
  memberName,
  reasonLabels,
  viewLabels,
} from './presentation';

const views: DecisionView[] = ['all', 'mine', 'unassigned'];
const domains: DecisionDomain[] = [
  'orders',
  'fulfillment',
  'inventory',
  'procurement',
  'operations',
];
const reasons: DecisionReason[] = [
  'approval',
  'run',
  'recovery',
  'manual_intervention',
  'uncertainty',
];

/** Names a filter option with its waiting count; the applied option reads without one. */
const facetLabel = (label: string, count: number | undefined) =>
  count === undefined ? label : `${label} · ${count}`;

function DecisionRow({
  item,
  now,
  members,
  self,
}: {
  item: DecisionItem;
  now: number;
  members: readonly Member[];
  self: string | undefined;
}) {
  const status = decisionStatus(item);
  const assignee = memberName(item.assignment?.assigneeId, members, self);

  return (
    <div
      className="issue-row decision-row"
      data-state={status.state}
      data-actionable={actionable(item) || undefined}
    >
      <DomainIcon
        domain={domainIcons[item.domain]}
        size="sm"
        className="issue-row-icon"
      />
      <div className="issue-row-copy">
        <strong className="case-row-summary">{item.title}</strong>
        <span className="case-row-subject">
          <span>{kindLabels[item.kind]}</span>
          <span>{item.subject.label}</span>
          <span>{assignee ? `Owner: ${assignee}` : 'Unassigned'}</span>
        </span>
      </div>
      <div className="issue-row-meta">
        {item.urgency === 'expiring' ? (
          <DecisionDeadline deadline={item.deadline} now={now} />
        ) : (
          <span
            className="issue-severity"
            data-severity={item.impact.level === 'high' ? 'high' : undefined}
          >
            {impactLabels[item.impact.level]}
          </span>
        )}
        <StatePill state={status.state}>{status.label}</StatePill>
        <span className="case-row-time" title={item.requestedAt}>
          <time dateTime={item.requestedAt}>
            {elapsed(item.requestedAt, now)}
          </time>
        </span>
      </div>
    </div>
  );
}

/**
 * Presents the Needs you queue: views, filters, grouped rows, pagination and the selected
 * decision. It owns no fetching, so stories and the page share the same states.
 */
export function NeedsYouView({
  organizationId,
  search,
  list,
  loading = false,
  refreshing = false,
  error,
  offline = false,
  live = 'live',
  page,
  onPrevious,
  onNext,
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
  /** The current page, or the last page read before a failed refresh. */
  list?: DecisionList | undefined;
  loading?: boolean;
  refreshing?: boolean;
  error?: string | undefined;
  offline?: boolean;
  live?: DecisionUpdates;
  page?: number | undefined;
  onPrevious?: (() => void) | undefined;
  onNext: () => void;
  /** Applies new filters or selection; filters return to the first page. */
  onChange: (search: NeedsYouSearch) => void;
  onRefresh: () => void;
  now: number;
  members?: readonly Member[];
  self?: string | undefined;
  /** The open decision, `loading` while resolving a direct link, or `missing`. */
  selected?: DecisionItem | 'loading' | 'missing' | undefined;
  inspector?: ReactNode;
}) {
  const listPane = useRef<HTMLDivElement>(null);
  const view = search.view ?? 'all';
  const filters = needsYouFilters(search);
  const update = (patch: Partial<NeedsYouSearch>) =>
    onChange({
      ...filters,
      item: search.item,
      grouped: search.grouped,
      ...patch,
      cursor: undefined,
    });
  const filtered = !!(search.domain || search.reason);
  const items = list?.items ?? [];
  const unavailable = list?.sources.filter((s) => s.state === 'unavailable');
  const open = (id: string | undefined) => onChange({ ...search, item: id });
  const empty = emptyCopy(view, filtered);
  const row = (item: DecisionItem) => (
    <li key={item.id}>
      <Link
        id={`decision-${item.id}`}
        to="/app/$organizationId/needs-you"
        params={{ organizationId }}
        search={{ ...search, item: item.id }}
        resetScroll={false}
        aria-current={item.id === search.item ? 'page' : undefined}
      >
        <DecisionRow item={item} now={now} members={members} self={self} />
      </Link>
    </li>
  );

  return (
    <div
      className={`inbox page-full decisions ${search.item ? 'inbox-selected' : ''}`}
    >
      <header className="inbox-heading">
        <div className="decisions-heading-copy">
          <h1>Needs you</h1>
          <p>
            Approvals, manual steps and outcome checks from issues, workflows
            and apps, most urgent first.
          </p>
        </div>
        <div className="issue-summary" aria-live="polite">
          {list ? (
            <>
              <span className="issue-stat">
                <strong>{list.counts.views.all}</strong> waiting
              </span>
              <span className="issue-stat">
                <strong>{list.counts.views.mine}</strong> assigned to you
              </span>
              <span className="issue-stat">
                <strong>{list.counts.views.unassigned}</strong> unassigned
              </span>
            </>
          ) : null}
          <span className="decisions-live" data-state={live}>
            {live === 'live'
              ? 'Live'
              : live === 'connecting'
                ? 'Connecting…'
                : 'Checking every 30 s'}
          </span>
        </div>
      </header>
      <div className="decisions-toolbar">
        <CollectionToolbar
          refreshLabel="Refresh Needs you"
          refreshing={refreshing}
          onRefresh={onRefresh}
          views={
            <Tabs value={view} className="decisions-views">
              <TabsList aria-label="Decision views" activateOnFocus={false}>
                {views.map((option) => (
                  <TabsTrigger
                    key={option}
                    value={option}
                    nativeButton={false}
                    render={
                      <Link
                        to="/app/$organizationId/needs-you"
                        params={{ organizationId }}
                        search={{
                          ...filters,
                          view: option,
                          item: search.item,
                          grouped: search.grouped,
                          cursor: undefined,
                        }}
                        resetScroll={false}
                      />
                    }
                  >
                    {viewLabels[option]}
                    {list ? <Badge>{list.counts.views[option]}</Badge> : null}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          }
          filters={[
            {
              kind: 'choice',
              key: 'domain',
              label: 'Area',
              icon: LayoutGrid,
              value: search.domain,
              options: domains.map((domain) => ({
                value: domain,
                label: facetLabel(
                  domainLabels[domain],
                  domain !== search.domain && list
                    ? list.counts.domains[domain]
                    : undefined,
                ),
              })),
              onChange: (value) =>
                update({ domain: domains.find((domain) => domain === value) }),
            },
            {
              kind: 'choice',
              key: 'reason',
              label: 'Reason',
              icon: CircleHelp,
              value: search.reason,
              options: reasons.map((reason) => ({
                value: reason,
                label: facetLabel(
                  reasonLabels[reason],
                  reason !== search.reason && list
                    ? list.counts.reasons[reason]
                    : undefined,
                ),
              })),
              onChange: (value) =>
                update({ reason: reasons.find((reason) => reason === value) }),
            },
          ]}
          actions={
            <label className="decisions-grouping">
              <Switch
                checked={!!search.grouped}
                onCheckedChange={(checked) =>
                  update({ grouped: checked ? true : undefined })
                }
              />
              Group by cause
            </label>
          }
          onClear={() => update({ domain: undefined, reason: undefined })}
        />
      </div>
      {offline ? (
        <CaseNotice title="You’re offline">
          The list shows the last decisions Luma confirmed. Responses are paused
          until you reconnect.
        </CaseNotice>
      ) : null}
      {unavailable?.length ? (
        <CaseNotice error title="Some decisions couldn’t be loaded">
          {unavailable.map((source) => source.label).join(', ')} didn’t answer,
          so {unavailable.length === 1 ? 'its' : 'their'} decisions are missing
          from this list, not resolved. Refresh to try again.
        </CaseNotice>
      ) : null}
      <IssueSplitView
        selected={!!search.item}
        list={
          <div
            className="inbox-list"
            ref={listPane}
            tabIndex={-1}
            aria-label="Decisions"
          >
            {error ? (
              <CaseNotice error title="Needs you could not be refreshed">
                {list ? 'The list below may be out of date. ' : ''}
                {error}
                {search.cursor ? (
                  <Button variant="outline" onClick={() => update({})}>
                    Return to first page
                  </Button>
                ) : null}
              </CaseNotice>
            ) : null}
            {loading ? (
              <div className="decisions-loading" role="status">
                <span className="sr-only">Loading decisions…</span>
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
                    {filtered ? (
                      <Button
                        variant="outline"
                        onClick={() =>
                          update({ domain: undefined, reason: undefined })
                        }
                      >
                        Clear filters
                      </Button>
                    ) : null}
                  </Empty>
                ) : search.grouped ? (
                  <div className="decisions-groups">
                    {groupDecisions(items).map((group) => (
                      <section
                        key={group.key}
                        aria-labelledby={`group-${group.key}`}
                      >
                        <h2
                          className="decisions-group-heading"
                          id={`group-${group.key}`}
                        >
                          {group.label}
                          <span className="lu-numeric">
                            {group.items.length}
                          </span>
                        </h2>
                        <ul className="inbox-rows">{group.items.map(row)}</ul>
                      </section>
                    ))}
                    <p className="decisions-group-note">
                      Groups cover this page. Each decision still needs its own
                      response; nothing is approved in bulk.
                    </p>
                  </div>
                ) : (
                  <ul className="inbox-rows">{items.map(row)}</ul>
                )}
                <Pagination
                  count={items.length}
                  totalCount={list.totalCount}
                  offset={list.offset}
                  page={page}
                  hasNext={!!list.nextCursor}
                  onPrevious={onPrevious}
                  onNext={onNext}
                  disabled={refreshing}
                  itemLabel="decisions"
                  label="Decision pages"
                />
              </>
            ) : null}
          </div>
        }
        detail={
          <section
            className="inbox-detail"
            tabIndex={-1}
            aria-label="Selected decision"
            onKeyDown={(event) => {
              if (
                event.key !== 'Escape' ||
                event.defaultPrevented ||
                !search.item ||
                (event.target instanceof Element &&
                  event.target.closest(
                    'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]',
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
                  <span className="sr-only">Loading decision…</span>
                  <span className="lu-skeleton" />
                  <span className="lu-skeleton" />
                </div>
              ) : selected === 'missing' || !selected ? (
                <div className="inbox-placeholder">
                  <h2>This decision no longer needs you</h2>
                  <p>It was answered, expired or you no longer have access.</p>
                  <Button variant="outline" onClick={() => open(undefined)}>
                    Back to the list
                  </Button>
                </div>
              ) : (
                inspector
              )
            ) : (
              <div className="inbox-placeholder">
                <h2>Select a decision</h2>
                <p>
                  See why you’re needed, the exact change and what your response
                  does.
                </p>
              </div>
            )}
          </section>
        }
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
  const live = useDecisionUpdates(organizationId);
  const now = useNow();
  const online = useSyncExternalStore(
    (listener) => onlineManager.subscribe(listener),
    () => onlineManager.isOnline(),
    () => true,
  );
  const list = useQuery(decisionsOptions(organizationId, search));
  const context = useQuery(contextOptions(organizationId));
  const members = useQuery(membersOptions(organizationId));
  const self = context.data?.actor.id;
  const role = context.data?.actor.role;
  const denied =
    list.error instanceof IdentityError &&
    [403, 404].includes(list.error.status);
  const data = denied ? undefined : list.data;
  const onPage = data?.items.find((item) => item.id === search.item);
  const direct = useQuery({
    ...decisionOptions(organizationId, search.item ?? ''),
    enabled: !!search.item && !!data && !onPage,
  });
  // Keep an opened decision visible after it leaves the queue so its outcome stays readable.
  const current = onPage ?? direct.data ?? undefined;
  const [remembered, setRemembered] = useState<DecisionItem>();
  if (current && current !== remembered) setRemembered(current);
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

  const filterKey = JSON.stringify(needsYouFilters(search));
  const [trail, setTrail] = useState<Record<string, (string | undefined)[]>>(
    {},
  );
  const cursors = trail[filterKey] ?? [undefined];
  const pageIndex = cursors.indexOf(search.cursor);
  const change = (next: NeedsYouSearch) =>
    void navigate({ search: next, resetScroll: false });
  const goNext = () => {
    const nextCursor = data?.nextCursor;
    if (!nextCursor) return;
    if (pageIndex >= 0)
      setTrail((previous) => ({
        ...previous,
        [filterKey]: [...cursors.slice(0, pageIndex + 1), nextCursor],
      }));
    change({ ...search, cursor: nextCursor });
  };
  const goPrevious =
    pageIndex > 0
      ? () => change({ ...search, cursor: cursors[pageIndex - 1] })
      : undefined;
  const refresh = () => {
    if (search.cursor) change({ ...search, cursor: undefined });
    void client.invalidateQueries({ queryKey: decisionsKey(organizationId) });
  };

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
        error instanceof IdentityError
          ? error.message
          : 'The assignment could not be saved. Refresh and try again.',
      ),
    onSettled: () =>
      client.invalidateQueries({ queryKey: decisionsKey(organizationId) }),
  });

  // J and K move through the visible decisions, as in other Luma queues.
  const items = data?.items ?? [];
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
  const stepRef = useRef(step);
  useEffect(() => {
    stepRef.current = step;
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isTypingTarget(event.target)
      )
        return;
      if (event.key === 'j') stepRef.current(1);
      else if (event.key === 'k') stepRef.current(-1);
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', listener);

    return () => window.removeEventListener('keydown', listener);
  }, []);

  if (list.error instanceof IdentityError && list.error.status === 401)
    return <SignInRedirect />;
  const memberList: Member[] = (members.data ?? []).map((member) => ({
    userId: member.userId,
    name: member.name,
    email: member.email,
    role: member.role,
  }));
  const item = typeof selected === 'object' ? selected : undefined;
  const previousItem = position > 0 ? items[position - 1] : undefined;
  const nextItem = position >= 0 ? items[position + 1] : undefined;

  return (
    <NeedsYouView
      organizationId={organizationId}
      search={search}
      list={data}
      loading={list.isPending}
      refreshing={list.isFetching}
      error={
        denied
          ? 'You no longer have access to this workspace.'
          : list.isError
            ? list.error.message
            : undefined
      }
      offline={!online}
      live={live}
      page={pageIndex >= 0 ? pageIndex + 1 : undefined}
      onPrevious={goPrevious}
      onNext={goNext}
      onChange={change}
      onRefresh={refresh}
      now={now}
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
            members={memberList}
            self={self}
            role={role}
            now={now}
            assigning={assignment.isPending}
            assignError={assignError}
            onAssign={(assigneeId) => assignment.mutate({ item, assigneeId })}
            onClose={() => change({ ...search, item: undefined })}
            navigation={
              <>
                <Button
                  variant="ghost"
                  aria-label="Previous decision"
                  title="Previous decision (K)"
                  disabled={!previousItem}
                  onClick={() => step(-1)}
                >
                  <ChevronUp aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  aria-label="Next decision"
                  title="Next decision (J)"
                  disabled={!nextItem}
                  onClick={() => step(1)}
                >
                  <ChevronDown aria-hidden="true" />
                </Button>
              </>
            }
            review={
              <OwnerReview
                organizationId={organizationId}
                owner={item.owner}
                onChange={() =>
                  client.invalidateQueries({
                    queryKey: decisionsKey(organizationId),
                  })
                }
              />
            }
          />
        ) : null
      }
    />
  );
}
