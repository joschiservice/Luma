import './inbox.css';

import type { Mailbox, ThreadSummary, ThreadView } from '@luma/api-contract';
import {
  formatList,
  formatNumber,
  formatRelativeTime,
} from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { CaseNotice } from '@luma/ui/components/issues/case-investigation';
import { elapsed } from '@luma/ui/components/issues/case-presentation';
import { IssueSplitView } from '@luma/ui/components/issues/issue-split-view';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import { CollectionToolbar } from '@luma/ui/components/primitives/collection-toolbar';
import { Empty } from '@luma/ui/components/primitives/empty';
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from '@luma/ui/components/primitives/tabs';
import {
  formatWorkspaceInstant,
  WorkspaceTimezone,
} from '@luma/ui/components/primitives/workspace-date';
import { PageTitle } from '@luma/ui/components/workspace/page-header';
import {
  onlineManager,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import {
  ChevronDown,
  ChevronUp,
  Clock,
  FileSearch,
  Mail,
  Paperclip,
  Reply,
  Settings2,
} from 'lucide-react';
import {
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react';

import { isTypingTarget } from '../../lib/keyboard';
import { useNow } from '../decisions/live';
import { SignInRedirect } from '../identity/common';
import {
  inboxFilters,
  type InboxSearch,
  mailboxesOptions,
  messagingKey,
  readFailure,
  threadsOptions,
} from './data';
import { useInboxUpdates } from './live';
import { type Member, memberName, useMembers } from './people';
import {
  correspondentLabel,
  dueState,
  emptyCopy,
  statusLabels,
  syncStateLabels,
  threadViews,
  viewDescriptions,
  viewLabels,
} from './presentation';
import { RecordLink } from './records';
import { ThreadDetail } from './thread';

type Counts = Partial<Record<ThreadView, number>>;

/** Mailboxes whose reading needs someone, so the list may be incomplete. */
const troubledMailboxes = (mailboxes: readonly Mailbox[]) =>
  mailboxes.filter((mailbox) =>
    ['needs_rules', 'retrying', 'blocked', 'paused'].includes(mailbox.state),
  );

/** One thread in the list: who wrote, about what, linked records, owner and reply state. */
export function ThreadRow({
  thread,
  organizationId,
  members,
  self,
  now,
  showMailbox,
}: {
  thread: ThreadSummary;
  organizationId: string;
  members: readonly Member[];
  self: string | undefined;
  now: number;
  showMailbox: boolean;
}) {
  const timeZone = useContext(WorkspaceTimezone);
  const due = dueState(thread);

  return (
    <div
      className="issue-row messaging-row"
      data-awaiting={thread.awaitingReply || undefined}
      data-closed={thread.status === 'closed' || undefined}
    >
      <span className="messaging-row-icon" aria-hidden="true">
        {thread.awaitingReply ? <Reply /> : <Mail />}
      </span>
      <div className="issue-row-copy">
        <span className="messaging-row-head">
          <strong className="case-row-summary">
            {correspondentLabel(thread)}
          </strong>
          {thread.messageCount > 1 ? (
            <span className="messaging-row-count">
              {m.messaging_row_messages({ count: thread.messageCount })}
            </span>
          ) : null}
        </span>
        <span className="messaging-row-subject">
          {thread.subject || m.messaging_subject_none()}
        </span>
        {thread.snippet ? (
          <span className="messaging-row-snippet">{thread.snippet}</span>
        ) : null}
        <span className="case-row-subject">
          <span>
            {thread.ownerId
              ? m.messaging_row_owner({
                  name: memberName(thread.ownerId, members, self),
                })
              : m.messaging_row_unassigned()}
          </span>
          {thread.status !== 'open' ? (
            <span>{statusLabels[thread.status]()}</span>
          ) : null}
          {showMailbox ? <span>{thread.mailboxLabel}</span> : null}
        </span>
        {thread.links.length ? (
          <span className="messaging-row-records">
            {thread.links.slice(0, 3).map((record) => (
              <RecordLink
                key={`${record.kind}:${record.id}`}
                organizationId={organizationId}
                record={record}
                compact
                plain
              />
            ))}
            {thread.links.length > 3 ? (
              <span>
                {m.messaging_row_more_records({
                  count: thread.links.length - 3,
                })}
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      <div className="issue-row-meta messaging-row-meta">
        {due === 'overdue' ? (
          <span className="messaging-flag" data-tone="danger">
            <Clock aria-hidden="true" />
            {m.messaging_due_overdue()}
          </span>
        ) : due === 'due' && thread.replyDueAt ? (
          <span
            className="messaging-flag"
            title={formatWorkspaceInstant(thread.replyDueAt, timeZone)}
          >
            <Clock aria-hidden="true" />
            {m.messaging_due_in({
              time: formatRelativeTime(thread.replyDueAt, now),
            })}
          </span>
        ) : null}
        {thread.awaitingReply ? (
          <span className="messaging-flag" data-tone="info">
            {m.messaging_row_awaiting_reply()}
          </span>
        ) : null}
        {thread.factsToReview > 0 ? (
          <span className="messaging-flag" data-tone="warning">
            <FileSearch aria-hidden="true" />
            {m.messaging_row_facts({ count: thread.factsToReview })}
          </span>
        ) : null}
        {thread.attachmentCount > 0 ? (
          <span
            className="messaging-row-attachments"
            title={m.messaging_row_attachments({
              count: thread.attachmentCount,
            })}
          >
            <Paperclip aria-hidden="true" />
            <span className="sr-only">
              {m.messaging_row_attachments({ count: thread.attachmentCount })}
            </span>
            <span aria-hidden="true">
              {formatNumber(thread.attachmentCount)}
            </span>
          </span>
        ) : null}
        <span
          className="case-row-time"
          title={formatWorkspaceInstant(thread.lastMessageAt, timeZone)}
        >
          <time dateTime={thread.lastMessageAt}>
            {elapsed(thread.lastMessageAt, now)}
          </time>
        </span>
      </div>
    </div>
  );
}

/**
 * Presents the inbox: views with counts, search, mailbox filter, the thread list and the open
 * thread. It owns no fetching, so stories and the page share the same states.
 */
export function InboxView({
  organizationId,
  search,
  threads,
  counts,
  mailboxes,
  loading = false,
  refreshing = false,
  error,
  stale = false,
  offline = false,
  live = 'live',
  hasMore = false,
  loadingMore = false,
  onMore,
  onChange,
  onRefresh,
  now,
  members = [],
  self,
  detail,
}: {
  organizationId: string;
  search: InboxSearch;
  threads: readonly ThreadSummary[] | undefined;
  counts?: Counts | undefined;
  mailboxes?: readonly Mailbox[] | undefined;
  loading?: boolean;
  refreshing?: boolean;
  /** Why the list could not be read. */
  error?: string | undefined;
  /** The list shown is the last one read; the latest refresh failed. */
  stale?: boolean;
  offline?: boolean;
  live?: 'connecting' | 'live' | 'interrupted';
  hasMore?: boolean;
  loadingMore?: boolean;
  onMore?: () => void;
  onChange: (search: InboxSearch) => void;
  onRefresh: () => void;
  now: number;
  members?: readonly Member[];
  self?: string | undefined;
  detail?: ReactNode;
}) {
  const listPane = useRef<HTMLDivElement>(null);
  const filters = inboxFilters(search);
  const view = filters.view;
  const filtered = !!(filters.connectionId || filters.q);
  const update = (patch: Partial<InboxSearch>) =>
    onChange({ ...search, ...patch });
  const open = (thread: string | undefined) => update({ thread });
  const empty = emptyCopy(view, filtered);
  const troubled = troubledMailboxes(mailboxes ?? []);
  const noMailbox = mailboxes?.length === 0;

  return (
    <div
      className={`inbox page-full messaging ${search.thread ? 'inbox-selected' : ''}`}
    >
      <PageTitle
        title={m.messaging_page_title()}
        actions={
          <Link
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
            to="/app/$organizationId/inbox/settings"
            params={{ organizationId }}
          >
            <Settings2 aria-hidden="true" />
            {m.messaging_settings_link()}
          </Link>
        }
      />
      <div className="messaging-toolbar">
        <CollectionToolbar
          refreshLabel={m.messaging_refresh()}
          refreshing={refreshing}
          onRefresh={onRefresh}
          views={
            <Tabs value={view} className="messaging-views">
              <TabsList
                aria-label={m.messaging_views_label()}
                activateOnFocus={false}
              >
                {threadViews.map((option) => (
                  <TabsTrigger
                    key={option}
                    value={option}
                    nativeButton={false}
                    title={viewDescriptions[option]()}
                    render={
                      <Link
                        to="/app/$organizationId/inbox"
                        params={{ organizationId }}
                        search={{ ...search, view: option }}
                        resetScroll={false}
                      />
                    }
                  >
                    {viewLabels[option]()}
                    {counts?.[option] !== undefined ? (
                      <Badge>{formatNumber(counts[option] ?? 0)}</Badge>
                    ) : null}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          }
          search={{
            value: search.q,
            onChange: (q) => update({ q: q?.trim() || undefined }),
            label: m.messaging_search_label(),
            placeholder: m.messaging_search_placeholder(),
            maxLength: 200,
          }}
          filters={
            (mailboxes?.length ?? 0) > 1
              ? [
                  {
                    kind: 'choice',
                    key: 'mailbox',
                    label: m.messaging_filter_mailbox(),
                    icon: Mail,
                    value: search.connectionId,
                    options: (mailboxes ?? []).map((mailbox) => ({
                      value: mailbox.connectionId,
                      label: mailbox.address ?? mailbox.label,
                    })),
                    onChange: (connectionId) => update({ connectionId }),
                  },
                ]
              : []
          }
          onClear={() => update({ connectionId: undefined, q: undefined })}
        />
      </div>
      {offline ? (
        <CaseNotice title={m.messaging_offline_title()}>
          {m.messaging_offline_text()}
        </CaseNotice>
      ) : live === 'interrupted' ? (
        <CaseNotice title={m.messaging_live_interrupted_title()}>
          {m.messaging_live_interrupted_text()}
        </CaseNotice>
      ) : null}
      {troubled.length ? (
        <CaseNotice title={m.messaging_mailbox_attention_title()}>
          {m.messaging_mailbox_attention_text({
            mailboxes: formatList(
              troubled.map((mailbox) =>
                m.messaging_mailbox_state_item({
                  mailbox: mailbox.address ?? mailbox.label,
                  state: syncStateLabels[mailbox.state](),
                }),
              ),
            ),
          })}{' '}
          <Link
            to="/app/$organizationId/inbox/settings"
            params={{ organizationId }}
          >
            {m.messaging_mailbox_attention_link()}
          </Link>
        </CaseNotice>
      ) : null}
      <IssueSplitView
        selected={!!search.thread}
        list={
          <div
            className="inbox-list"
            ref={listPane}
            tabIndex={-1}
            aria-label={m.messaging_list_label()}
          >
            {error ? (
              <CaseNotice error title={m.messaging_list_error_title()}>
                {stale ? `${m.messaging_list_stale()} ` : ''}
                {error}
              </CaseNotice>
            ) : null}
            {loading ? (
              <div className="messaging-loading" role="status">
                <span className="sr-only">{m.messaging_loading_list()}</span>
                {[0, 1, 2, 3].map((key) => (
                  <span key={key} className="lu-skeleton" />
                ))}
              </div>
            ) : threads ? (
              threads.length === 0 ? (
                noMailbox && !filtered ? (
                  <Empty className="inbox-empty">
                    <Mail aria-hidden="true" />
                    <h2>{m.messaging_connect_title()}</h2>
                    <p>{m.messaging_connect_text()}</p>
                    <Link
                      className={buttonVariants({ variant: 'outline' })}
                      to="/app/$organizationId/apps"
                      params={{ organizationId }}
                    >
                      {m.messaging_connect_action()}
                    </Link>
                  </Empty>
                ) : (
                  <Empty className="inbox-empty">
                    <span aria-hidden="true">○</span>
                    <h2>{empty.title}</h2>
                    <p>{empty.text}</p>
                    {filtered ? (
                      <Button
                        variant="outline"
                        onClick={() =>
                          update({ connectionId: undefined, q: undefined })
                        }
                      >
                        {m.common_clear_filters()}
                      </Button>
                    ) : null}
                  </Empty>
                )
              ) : (
                <>
                  <ul className="inbox-rows">
                    {threads.map((thread) => (
                      <li key={thread.id}>
                        <Link
                          id={`thread-${thread.id}`}
                          to="/app/$organizationId/inbox"
                          params={{ organizationId }}
                          search={{ ...search, thread: thread.id }}
                          resetScroll={false}
                          aria-current={
                            thread.id === search.thread ? 'page' : undefined
                          }
                        >
                          <ThreadRow
                            thread={thread}
                            organizationId={organizationId}
                            members={members}
                            self={self}
                            now={now}
                            showMailbox={(mailboxes?.length ?? 0) > 1}
                          />
                        </Link>
                      </li>
                    ))}
                  </ul>
                  {hasMore ? (
                    <div className="messaging-more">
                      <Button
                        variant="outline"
                        disabled={loadingMore}
                        onClick={onMore}
                      >
                        {loadingMore
                          ? m.messaging_loading_more()
                          : m.messaging_show_more()}
                      </Button>
                    </div>
                  ) : null}
                </>
              )
            ) : null}
          </div>
        }
        detail={
          <section
            className="inbox-detail"
            tabIndex={-1}
            aria-label={m.messaging_selected_label()}
            onKeyDown={(event) => {
              if (
                event.key !== 'Escape' ||
                event.defaultPrevented ||
                !search.thread ||
                (event.target instanceof Element &&
                  event.target.closest(
                    'input, textarea, select, [contenteditable="true"], [role="combobox"], [role="dialog"], [role="menu"], [role="listbox"]',
                  ))
              )
                return;
              event.preventDefault();
              const current = search.thread;
              open(undefined);
              requestAnimationFrame(() =>
                (
                  document.getElementById(`thread-${current}`) ??
                  listPane.current
                )?.focus({ preventScroll: true }),
              );
            }}
          >
            {search.thread ? (
              detail
            ) : (
              <div className="inbox-placeholder">
                <h2>{m.messaging_placeholder_title()}</h2>
                <p>{m.messaging_placeholder_text()}</p>
              </div>
            )}
          </section>
        }
      />
    </div>
  );
}

/** Loads the inbox for the workspace in the URL and keeps its URL state. */
export function InboxPage() {
  const { organizationId } = useParams({
    from: '/app/$organizationId/inbox/',
  });

  return <TenantInbox key={organizationId} organizationId={organizationId} />;
}

function TenantInbox({ organizationId }: { organizationId: string }) {
  const search = useSearch({ from: '/app/$organizationId/inbox/' });
  const navigate = useNavigate({ from: '/app/$organizationId/inbox/' });
  const client = useQueryClient();
  const live = useInboxUpdates(organizationId);
  const now = useNow();
  const online = useSyncExternalStore(
    (listener) => onlineManager.subscribe(listener),
    () => onlineManager.isOnline(),
    () => true,
  );
  const filters = inboxFilters(search);
  const list = useInfiniteQuery(threadsOptions(organizationId, filters));
  const mailboxes = useQuery(mailboxesOptions(organizationId));
  const people = useMembers(organizationId);
  const failure = readFailure(list.error);
  const threads =
    failure === 'access'
      ? undefined
      : list.data?.pages.flatMap((page) => page.items);
  const counts = list.data?.pages[0]?.counts;
  const change = (next: InboxSearch) =>
    void navigate({ search: next, resetScroll: false });

  // J and K move through the visible threads, as in other Luma queues.
  const items = threads ?? [];
  const position = items.findIndex((item) => item.id === search.thread);
  const step = (offset: number) => {
    const target = items[position < 0 ? 0 : position + offset];
    if (!target) return;
    change({ ...search, thread: target.id });
    requestAnimationFrame(() =>
      document
        .getElementById(`thread-${target.id}`)
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

  if (failure === 'signin') return <SignInRedirect />;
  const previous = position > 0 ? items[position - 1] : undefined;
  const next = position >= 0 ? items[position + 1] : undefined;

  return (
    <InboxView
      organizationId={organizationId}
      search={search}
      threads={threads}
      counts={
        counts
          ? {
              open: counts.open,
              mine: counts.mine,
              unassigned: counts.unassigned,
              overdue: counts.overdue,
              review: counts.review,
            }
          : undefined
      }
      mailboxes={mailboxes.data?.items}
      loading={list.isPending}
      refreshing={list.isFetching && !list.isFetchingNextPage}
      error={
        failure === 'access'
          ? m.messaging_error_access()
          : failure
            ? m.messaging_error_unavailable()
            : undefined
      }
      stale={!!list.error && !!threads}
      offline={!online}
      live={live}
      hasMore={list.hasNextPage}
      loadingMore={list.isFetchingNextPage}
      onMore={() => void list.fetchNextPage()}
      onChange={change}
      onRefresh={() =>
        void client.invalidateQueries({
          queryKey: messagingKey(organizationId),
        })
      }
      now={now}
      members={people.members}
      self={people.self}
      detail={
        search.thread ? (
          <ThreadDetail
            key={search.thread}
            organizationId={organizationId}
            threadId={search.thread}
            people={people}
            now={now}
            onClose={() => change({ ...search, thread: undefined })}
            navigation={
              <>
                <Button
                  variant="ghost"
                  aria-label={m.messaging_previous()}
                  title={m.messaging_previous_shortcut()}
                  disabled={!previous}
                  onClick={() => step(-1)}
                >
                  <ChevronUp aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  aria-label={m.messaging_next()}
                  title={m.messaging_next_shortcut()}
                  disabled={!next}
                  onClick={() => step(1)}
                >
                  <ChevronDown aria-hidden="true" />
                </Button>
              </>
            }
          />
        ) : null
      }
    />
  );
}
