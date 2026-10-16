import './inbox.css';

import {
  type CollectionGroup,
  type CollectionGrouping,
  collectionWhereIssues,
  inboxCatalog,
  type Mailbox,
  type ThreadSummary,
  type ThreadView,
} from '@luma/api-contract';
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
import { Empty } from '@luma/ui/components/primitives/empty';
import {
  listShortcutGroup,
  ShortcutHelp,
} from '@luma/ui/components/primitives/shortcut-help';
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from '@luma/ui/components/primitives/tabs';
import {
  formatWorkspaceInstant,
  WorkspaceDate,
  WorkspaceTimezone,
} from '@luma/ui/components/primitives/workspace-date';
import { PageTitle } from '@luma/ui/components/workspace/page-header';
import { useListKeyboard } from '@luma/ui/lib/list-keyboard';
import {
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
import { type ReactNode, useContext, useRef, useState } from 'react';

import { useCollectionControls } from '../../kit/collections/controls';
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
  collectionError,
  collectionServerIssue,
  useOnline,
} from '../../kit/collections/paging';
import { repairedState } from '../../kit/collections/repair';
import { type CollectionSearch, groupOf } from '../../kit/collections/state';
import {
  type CollectionView,
  useCollectionView,
} from '../../kit/collections/use-collection-view';
import { CollectionViewBar } from '../../kit/collections/view-bar';
import { SignInRedirect } from '../../kit/identity/common';
import { usePermissions } from '../../kit/identity/permissions';
import { useNow } from '../../kit/live/now';
import {
  defaultThreadSort,
  type InboxSearch,
  mailboxesOptions,
  messagingKey,
  readFailure,
  threadGroupOptions,
  threadListQuery,
  threadsOptions,
  threadView,
} from './data';
import { useInboxUpdates } from './live';
import { type Member, memberName, useMembers } from './people';
import {
  correspondentLabel,
  dueState,
  emptyCopy,
  recordKindLabels,
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

/** Row properties a view without its own shows. */
const threadProperties = [
  'subject',
  'owner',
  'status',
  'mailbox',
  'activity',
] as const;

const thread = () => m.messaging_area_thread();
const work = () => m.messaging_area_work();
const option =
  (labels: Readonly<Record<string, () => string>>) => (value: string) =>
    labels[value]?.() ?? value;

/** Names the inbox's catalog fields and options in filters, sorts, groups and Display. */
const threadPresentation: CatalogPresentation = {
  correspondent: { label: m.messaging_field_correspondent, group: thread },
  subject: { label: m.messaging_field_subject, group: thread },
  owner: { label: m.messaging_field_owner, group: work },
  status: {
    label: m.messaging_field_status,
    group: work,
    option: option(statusLabels),
  },
  mailbox: { label: m.messaging_field_mailbox, group: thread },
  due: { label: m.messaging_field_due, group: work },
  activity: { label: m.messaging_field_activity, group: thread },
  linkedRecord: {
    label: m.messaging_field_linked_record,
    group: thread,
    option: option(recordKindLabels),
  },
  hasAttachments: { label: m.messaging_field_has_attachments, group: thread },
  awaitingReply: { label: m.messaging_field_awaiting_reply, group: work },
  factsToReview: { label: m.messaging_field_facts_to_review, group: work },
};

const sameSort = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

/**
 * The view as the inbox shows it: a view without its own sort shows the newest activity first,
 * and choosing that again keeps the view unchanged rather than marking it Modified.
 */
function inboxView(view: CollectionView): CollectionView {
  return {
    ...view,
    state: {
      ...view.state,
      sort: view.state.sort ?? defaultThreadSort,
      layout: 'list',
    },
    change: (next) =>
      view.change({
        ...next,
        layout: 'list',
        sort:
          !view.base.sort && sameSort(next.sort, defaultThreadSort)
            ? null
            : next.sort,
      }),
  };
}

/** The toolbar controls the inbox shows beside search; stories may leave them out. */
export interface InboxControls {
  filters?: readonly CollectionFilter[] | undefined;
  conditions?: CollectionConditions | undefined;
  sort?: CollectionSort | undefined;
  /** Clears every condition; the view clears search itself. */
  clearConditions?: (() => void) | undefined;
}

/** The inbox's grouping and the groups the page shows. */
export interface InboxGrouping {
  grouping: CollectionGrouping;
  groups: readonly ShownGroup<ThreadSummary>[];
  label: (key: CollectionGroup['key']) => string;
  collapsed: readonly string[];
  onCollapsedChange: (id: string, collapsed: boolean) => void;
}

/** The list commands the inbox handles, for shortcut help. */
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

function ThreadDue({ thread, now }: { thread: ThreadSummary; now: number }) {
  const timeZone = useContext(WorkspaceTimezone);
  const due = dueState(thread);

  return due === 'overdue' ? (
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
  ) : null;
}

function ThreadTime({ at, now }: { at: string; now: number }) {
  const timeZone = useContext(WorkspaceTimezone);

  return (
    <span
      className="case-row-time"
      title={formatWorkspaceInstant(at, timeZone)}
    >
      <time dateTime={at}>{elapsed(at, now)}</time>
    </span>
  );
}

/**
 * The thread list: who wrote, about what, linked records, owner and reply state, with the
 * properties chosen in Display. Reply deadlines, awaiting replies, facts to review and
 * attachments always show, so attention never depends on a hidden property.
 */
export function ThreadList({
  label,
  organizationId,
  search,
  threads,
  members,
  self,
  now,
  showMailbox,
  properties = threadProperties,
  density = 'comfortable',
  focusedKey,
}: {
  /** Names the list, such as a group's name; the inbox's list name by default. */
  label?: string | undefined;
  organizationId: string;
  search: InboxSearch;
  threads: readonly ThreadSummary[];
  members: readonly Member[];
  self: string | undefined;
  now: number;
  /** More than one mailbox is connected, so rows name theirs. */
  showMailbox: boolean;
  properties?: readonly string[] | undefined;
  density?: CollectionListDensity | undefined;
  focusedKey?: string | undefined;
}) {
  const shown = new Set(properties);
  const line = (thread: ThreadSummary) =>
    properties.flatMap((key) => {
      if (key === 'owner')
        return [
          <span key={key}>
            {thread.ownerId
              ? m.messaging_row_owner({
                  name: memberName(thread.ownerId, members, self),
                })
              : m.messaging_row_unassigned()}
          </span>,
        ];
      if (key === 'status' && thread.status !== 'open')
        return [<span key={key}>{statusLabels[thread.status]()}</span>];
      if (key === 'mailbox' && showMailbox)
        return [<span key={key}>{thread.mailboxLabel}</span>];

      return [];
    });

  return (
    <CollectionList
      label={label ?? m.messaging_list_label()}
      variant="plain"
      density={density}
      items={threads}
      itemKey={(thread) => thread.id}
      current={search.thread}
      focusedKey={focusedKey}
      link={(thread) => (
        <Link
          id={`thread-${thread.id}`}
          to="/app/$organizationId/inbox"
          params={{ organizationId }}
          search={{ ...search, thread: thread.id }}
          resetScroll={false}
          className="messaging-row"
          data-awaiting={thread.awaitingReply || undefined}
          data-closed={thread.status === 'closed' || undefined}
        />
      )}
      leading={(thread) => (
        <span className="messaging-row-icon" aria-hidden="true">
          {thread.awaitingReply ? <Reply /> : <Mail />}
        </span>
      )}
      title={(thread) => (
        <span className="messaging-row-head">
          <span className="messaging-row-name">
            {correspondentLabel(thread)}
          </span>
          {thread.messageCount > 1 ? (
            <span className="messaging-row-count">
              {m.messaging_row_messages({ count: thread.messageCount })}
            </span>
          ) : null}
        </span>
      )}
      description={(thread) => {
        const facts = line(thread);

        return (
          <>
            {shown.has('subject') ? (
              <span className="messaging-row-subject">
                {thread.subject || m.messaging_subject_none()}
              </span>
            ) : null}
            {thread.snippet ? (
              <span className="messaging-row-snippet">{thread.snippet}</span>
            ) : null}
            {facts.length ? (
              <span className="case-row-subject">{facts}</span>
            ) : null}
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
          </>
        );
      }}
      status={(thread) => (
        <>
          <ThreadDue thread={thread} now={now} />
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
                {m.messaging_row_attachments({
                  count: thread.attachmentCount,
                })}
              </span>
              <span aria-hidden="true">
                {formatNumber(thread.attachmentCount)}
              </span>
            </span>
          ) : null}
        </>
      )}
      properties={properties.filter(
        (key) => key === 'due' || key === 'activity',
      )}
      property={(thread, key) =>
        key === 'activity' ? (
          <ThreadTime at={thread.lastMessageAt} now={now} />
        ) : key === 'due' && thread.replyDueAt ? (
          <WorkspaceDate value={thread.replyDueAt} />
        ) : null
      }
    />
  );
}

/**
 * Presents the inbox: views with counts, search, filters, conditions and sort, the thread list
 * or its groups, and the open thread. J and K move through the threads, Space opens or closes
 * the focused thread, / focuses search, F opens the condition builder and Escape closes the
 * thread. It owns no fetching, so stories and the page share the same states.
 */
export function InboxView({
  organizationId,
  search,
  segment = threadView(search.view),
  savedView = false,
  viewBar,
  display,
  controls = {},
  conditionsApplied = false,
  notices,
  grouped,
  properties = threadProperties,
  density = 'comfortable',
  onOpenView,
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
  /** The thread view the list shows; a saved view reads its own. */
  segment?: ThreadView | undefined;
  /** A saved view is open, so no built-in view tab is current. */
  savedView?: boolean | undefined;
  /** The view bar with built-in and saved views; without it the built-in views are plain tabs. */
  viewBar?: ReactNode;
  /** The Display menu. */
  display?: ReactNode;
  controls?: InboxControls | undefined;
  /** The view has conditions, so an empty list says nothing matches. */
  conditionsApplied?: boolean | undefined;
  /** Repair and similar notices above the threads. */
  notices?: ReactNode;
  /** Groups to show instead of a flat list. */
  grouped?: InboxGrouping | undefined;
  /** Row properties in display order. */
  properties?: readonly string[] | undefined;
  density?: CollectionListDensity | undefined;
  /** Opens a built-in view from the tabs shown without a view bar; without it they are plain links. */
  onOpenView?: ((view: ThreadView) => void) | undefined;
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
  const searchInput = useRef<HTMLInputElement>(null);
  const [help, setHelp] = useState(false);
  const filtered = conditionsApplied || !!search.q?.trim();
  const update = (patch: Partial<InboxSearch>) =>
    onChange({ ...search, ...patch });
  const open = (thread: string | undefined) => update({ thread });
  const clear = () => {
    controls.clearConditions?.();
    update({ q: undefined });
  };
  const empty = emptyCopy(segment, filtered);
  const troubled = troubledMailboxes(mailboxes ?? []);
  const noMailbox = mailboxes?.length === 0;
  // Keys follow the order rows appear in, which grouping changes.
  const ordered = grouped
    ? grouped.groups
        .filter((group) => !grouped.collapsed.includes(group.id))
        .flatMap((group) => group.rows)
    : (threads ?? []);
  const keyboard = useListKeyboard({
    rows: listPane,
    count: ordered.length,
    keys: ordered.map((thread) => thread.id),
    preview: { open: search.thread, onOpenChange: open },
    onFocusSearch: () => searchInput.current?.focus(),
    onOpenFilter: controls.conditions
      ? () => controls.conditions?.onOpenChange?.(true)
      : undefined,
    onShowHelp: () => setHelp(true),
  });
  const list = (label: string | undefined, shown: readonly ThreadSummary[]) => (
    <ThreadList
      label={label}
      organizationId={organizationId}
      search={search}
      threads={shown}
      members={members}
      self={self}
      now={now}
      showMailbox={(mailboxes?.length ?? 0) > 1}
      properties={properties}
      density={density}
      focusedKey={keyboard.focusedKey}
    />
  );

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
            <>
              {viewBar ?? (
                <Tabs
                  value={savedView ? null : segment}
                  className="messaging-views"
                >
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
                            search={{
                              q: search.q,
                              thread: search.thread,
                              view: option,
                            }}
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
                        {counts?.[option] !== undefined ? (
                          <Badge>{formatNumber(counts[option] ?? 0)}</Badge>
                        ) : null}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              )}
            </>
          }
          search={{
            value: search.q,
            onChange: (q) => update({ q: q?.trim() || undefined }),
            label: m.messaging_search_label(),
            placeholder: m.messaging_search_placeholder(),
            maxLength: 200,
            inputRef: searchInput,
          }}
          filters={controls.filters ?? []}
          conditions={controls.conditions}
          display={display}
          sort={controls.sort}
          onClear={clear}
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
            {notices}
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
                      <Button variant="outline" onClick={clear}>
                        {m.common_clear_filters()}
                      </Button>
                    ) : null}
                  </Empty>
                )
              ) : grouped ? (
                <CollectionGroups
                  label={m.messaging_groups_label({
                    field:
                      threadPresentation[grouped.grouping.field]?.label() ??
                      grouped.grouping.field,
                  })}
                  collapsed={grouped.collapsed}
                  onCollapsedChange={grouped.onCollapsedChange}
                  groups={grouped.groups.map((group) => {
                    const label = grouped.label(group.group.key);

                    return {
                      key: group.id,
                      label,
                      count: group.group.count,
                      complete: group.group.complete,
                      content: group.rows.length ? (
                        list(label, group.rows)
                      ) : (
                        <p className="messaging-group-empty">
                          {m.messaging_group_empty()}
                        </p>
                      ),
                      more: groupMoreButton(group.more),
                    };
                  })}
                />
              ) : (
                <>
                  {list(undefined, threads)}
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
      <ShortcutHelp
        open={help}
        onOpenChange={setHelp}
        groups={[listShortcutGroup(shortcuts)]}
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
  const online = useOnline();
  const timeZone = useContext(WorkspaceTimezone);
  const permissions = usePermissions(organizationId);
  const can = permissions.can;
  const change = (next: InboxSearch) =>
    void navigate({ search: next, resetScroll: false });
  const view = useCollectionView({
    catalog: inboxCatalog,
    organizationId,
    search,
    // Changing the view keeps the search and the open thread.
    navigate: (next: Partial<CollectionSearch>) =>
      change({
        ...(search.q ? { q: search.q } : {}),
        ...(search.thread ? { thread: search.thread } : {}),
        ...next,
      }),
  });
  const listView = inboxView(view);
  const state = listView.state;
  const segment = threadView(state.segment);
  const mailboxes = useQuery(mailboxesOptions(organizationId));
  const people = useMembers(organizationId);
  const options = {
    members: people.members.map((member) => ({
      value: member.userId,
      label: memberName(member.userId, people.members, people.self),
    })),
    mailboxes: (mailboxes.data?.items ?? []).map((mailbox) => ({
      value: mailbox.connectionId,
      label: mailbox.address ?? mailbox.label,
    })),
  };
  const ready = permissions.ready;
  const clientIssues = ready
    ? collectionWhereIssues(inboxCatalog, state.where)
    : [];
  const query = threadListQuery(state, search.q, timeZone);
  const list = useInfiniteQuery({
    ...threadsOptions(organizationId, query),
    enabled: ready && !clientIssues.length,
  });
  const serverIssue = collectionServerIssue(list.error);
  const controls = useCollectionControls({
    view: listView,
    catalog: inboxCatalog,
    presentation: threadPresentation,
    can,
    options,
    title: 'correspondent',
    defaultProperties: threadProperties,
    serverIssues: serverIssue ? [serverIssue] : [],
    owner: { field: 'owner', members: options.members, unassigned: true },
  });
  const issues = [...clientIssues, ...(serverIssue ? [serverIssue] : [])];
  const repair = issues.length
    ? () => view.change(repairedState(inboxCatalog, view.state, issues, can))
    : undefined;
  const invalid = clientIssues.length
    ? { kind: 'invalid' as const, message: m.collections_needs_repair() }
    : collectionError(list.error, undefined);
  const failure =
    invalid?.kind === 'invalid' ? undefined : readFailure(list.error);
  const threads =
    failure === 'access' || invalid?.kind === 'invalid'
      ? undefined
      : list.data?.pages.flatMap((page) => page.items);
  const first = list.data?.pages[0];
  const counts: Counts | undefined = first?.counts && {
    open: first.counts.open,
    mine: first.counts.mine,
    unassigned: first.counts.unassigned,
    overdue: first.counts.overdue,
    review: first.counts.review,
  };

  const grouping = state.group;
  const groupPrefix = `${groupOf(state) ?? ''}=`;
  const collapsed = view.display.collapsedGroups
    .filter((id) => id.startsWith(groupPrefix))
    .map((id) => id.slice(groupPrefix.length));
  const more = useGroupPages<ThreadSummary>({
    resetKey: JSON.stringify([organizationId, query]),
    load: (key: CollectionGroup['key'], cursor: string) =>
      client
        .fetchQuery(
          threadGroupOptions(
            organizationId,
            threadListQuery(state, search.q, timeZone, { key, cursor }),
          ),
        )
        .then((page) => ({
          rows: page.items,
          nextCursor: page.groups?.[0]?.nextCursor ?? page.nextCursor,
        })),
  });
  const groups =
    threads && grouping && first?.groups
      ? shownGroups({
          items: threads,
          groups: first.groups,
          rowKey: (thread) => thread.id,
          field: inboxCatalog.fields.find(
            (field) => field.id === grouping.field,
          ),
          showEmpty: grouping.showEmpty,
          more,
        })
      : undefined;
  const groupLabel = (key: CollectionGroup['key']) =>
    grouping?.field === 'owner'
      ? typeof key === 'string'
        ? memberName(key, people.members, people.self)
        : m.messaging_row_unassigned()
      : collectionGroupLabel({
          presentation: threadPresentation,
          field: grouping?.field ?? '',
          granularity: undefined,
          key,
          options,
          runtime: { mailbox: 'mailboxes' },
          name: (id) =>
            threads?.find((thread) => thread.connectionId === id)?.mailboxLabel,
        });

  // The thread's previous and next buttons step through the visible threads.
  const items = groups
    ? groups.flatMap((group) => group.rows)
    : (threads ?? []);
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

  if (failure === 'signin') return <SignInRedirect />;
  const previous = position > 0 ? items[position - 1] : undefined;
  const next = position >= 0 ? items[position + 1] : undefined;

  return (
    <InboxView
      organizationId={organizationId}
      search={search}
      segment={segment}
      viewBar={
        <CollectionViewBar
          organizationId={organizationId}
          view={view}
          path="inbox"
          segmentLabel={(value) => viewLabels[threadView(value)]()}
          segments={threadViews.map((option) => ({
            value: option,
            label: viewLabels[option](),
            description: viewDescriptions[option](),
            count: counts?.[option],
          }))}
        />
      }
      display={controls.display}
      controls={{
        filters: controls.filters,
        conditions: controls.conditions,
        sort: controls.sort,
        clearConditions: controls.clearConditions,
      }}
      conditionsApplied={state.where.conditions.length > 0}
      notices={
        invalid?.kind === 'invalid' || invalid?.kind === 'page' ? (
          <CollectionNotices
            offline={false}
            error={invalid}
            hasRows={!!threads}
            retry={() => void list.refetch()}
            firstPage={() => void list.refetch()}
            repair={repair}
          />
        ) : first?.groupsTruncated ? (
          <CaseNotice title={m.collections_groups_truncated()} />
        ) : null
      }
      grouped={
        grouping && groups
          ? {
              grouping,
              groups,
              label: groupLabel,
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
      threads={threads}
      mailboxes={mailboxes.data?.items}
      loading={list.isPending && !invalid}
      refreshing={list.isFetching && !list.isFetchingNextPage}
      error={
        failure === 'access'
          ? m.messaging_error_access()
          : failure && invalid?.kind !== 'page'
            ? m.messaging_error_unavailable()
            : undefined
      }
      stale={!!list.error && !!threads}
      offline={!online}
      live={live}
      hasMore={!grouping && list.hasNextPage}
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
