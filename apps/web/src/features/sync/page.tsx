import './sync.css';

import type {
  SyncCommand,
  SyncConnectionCommand,
  SyncConnectionView,
  SyncOverview,
  SyncRecordState,
  SyncStreamView,
} from '@luma/api-contract';
import { formatList } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import { CollectionList } from '@luma/ui/components/primitives/collection-list';
import { CollectionPreview } from '@luma/ui/components/primitives/collection-preview';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@luma/ui/components/primitives/dropdown-menu';
import { Empty } from '@luma/ui/components/primitives/empty';
import { Progress } from '@luma/ui/components/primitives/progress';
import { RefreshButton } from '@luma/ui/components/primitives/refresh-button';
import {
  listShortcutGroup,
  ShortcutHelp,
} from '@luma/ui/components/primitives/shortcut-help';
import { StateDot, StatePill } from '@luma/ui/components/primitives/state';
import { PageTitle } from '@luma/ui/components/workspace/page-header';
import { type ListShortcut, useListKeyboard } from '@luma/ui/lib/list-keyboard';
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
  ChevronRight,
  History,
  MoreHorizontal,
  Pause,
  Play,
  Plug,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { statuses } from '../../kit/connections/presentation';
import { ProviderIcon } from '../../kit/connections/provider-icon';
import { SignInRedirect } from '../../kit/identity/common';
import { IdentityError } from '../../kit/identity/data';
import { usePermissions } from '../../kit/identity/permissions';
import { AutomaticLinks } from './automatic-links';
import {
  sendConnectionCommand,
  sendSyncCommand,
  syncKey,
  syncOptions,
  syncRecordsOptions,
  syncRunsOptions,
} from './data';
import {
  ago,
  type AttentionItem,
  attentionItems,
  connectionCommands,
  count,
  coverageBrief,
  focusStream,
  overallState,
  providerName,
  recordNote,
  recordTypes,
  scanProgress,
  soon,
  streamState,
  syncFigures,
  syncHealth,
  type SyncItem,
  syncItems,
  unavailableReason,
  waitingStatement,
} from './presentation';
import {
  closedRecords,
  type ProblemRecords,
  type RunHistory,
  StreamDetail,
  type SyncMessage,
} from './stream-detail';

/** The commands the sync list handles, for shortcut help. */
const shortcuts: readonly ListShortcut[] = [
  'next',
  'previous',
  'preview',
  'escape',
  'help',
];

/**
 * Connects Data sync to workspace-scoped queries, the open sync in the address and sync
 * commands. One command runs at a time; a connection-wide command changes that connection's
 * syncs together or not at all. A link naming a connection and record type opens its sync.
 */
export function SyncPage() {
  const { organizationId } = useParams({ from: '/app/$organizationId/sync' });
  const search = useSearch({ from: '/app/$organizationId/sync' });
  const navigate = useNavigate({ from: '/app/$organizationId/sync' });
  const query = useQuery(syncOptions(organizationId));
  const { can } = usePermissions(organizationId);
  const client = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<SyncMessage | null>(null);
  const lock = useRef(false);
  const open = search.stream;
  const openStream = query.data
    ? syncItems(query.data).find((item) => item.stream.id === open)?.stream
    : undefined;
  const runs = useInfiniteQuery(syncRunsOptions(organizationId, openStream));
  const [listed, setListed] = useState<{
    streamId: string;
    state: SyncRecordState;
  } | null>(null);
  const listing = openStream && listed?.streamId === open ? listed : null;
  const records = useInfiniteQuery(syncRecordsOptions(organizationId, listing));
  const target =
    query.data && search.connection && !open
      ? focusStream(query.data, search.connection, search.type)
      : undefined;

  useEffect(() => {
    if (!query.data || (!search.connection && !search.type)) return;
    // Replace the link's connection and type with the sync they name, so Back skips them.
    void navigate({
      search: (previous) => ({
        ...previous,
        connection: undefined,
        type: undefined,
        stream: previous.stream ?? target,
      }),
      replace: true,
      resetScroll: false,
    });
  }, [query.data, search.connection, search.type, target, navigate]);

  if (query.error instanceof IdentityError && query.error.status === 401)
    return <SignInRedirect />;

  async function run(
    target: string,
    send: () => Promise<string>,
    streamId?: string,
  ) {
    if (lock.current) return;
    lock.current = true;
    setPending(target);
    setMessage(null);
    try {
      setMessage({ tone: 'success', text: await send(), streamId });
    } catch (error) {
      setMessage({
        tone: 'danger',
        text:
          error instanceof IdentityError && error.status === 403
            ? m.sync_command_forbidden()
            : streamId
              ? m.sync_command_failed()
              : m.sync_command_all_failed(),
        streamId,
      });
    }
    await client.invalidateQueries({ queryKey: syncKey(organizationId) });
    lock.current = false;
    setPending(null);
  }

  return (
    <SyncView
      organizationId={organizationId}
      overview={query.isError ? undefined : query.data}
      loading={query.isPending}
      error={query.error ? m.sync_load_failed() : undefined}
      offline={query.isPaused}
      refreshing={query.isFetching}
      canManage={can('sync.manage')}
      pending={pending}
      message={message}
      open={open}
      onOpenChange={(stream) =>
        void navigate({
          search: (previous) => ({ ...previous, stream }),
          resetScroll: false,
        })
      }
      history={{
        runs: runs.data?.pages.flatMap((page) => page.runs),
        loading: runs.isPending,
        error: runs.isError && !runs.isFetchNextPageError,
        more: runs.hasNextPage,
        loadingMore: runs.isFetchingNextPage,
        moreError: runs.isFetchNextPageError,
        loadMore: () => void runs.fetchNextPage(),
      }}
      records={{
        state: listing?.state ?? null,
        onStateChange: (state) =>
          setListed(open && state ? { streamId: open, state } : null),
        records: records.data?.pages.flatMap((page) => page.records),
        loading: records.isPending,
        error: records.isError && !records.isFetchNextPageError,
        more: records.hasNextPage,
        loadingMore: records.isFetchingNextPage,
        loadMore: () => void records.fetchNextPage(),
      }}
      command={(stream, action) =>
        void run(
          stream.id,
          async () => {
            await sendSyncCommand(organizationId, stream.id, action);

            return commandMessages[action]();
          },
          stream.id,
        )
      }
      commandAll={(connection, action) =>
        void run(connection.connectionId, async () => {
          const { updated } = await sendConnectionCommand(
            organizationId,
            connection.connectionId,
            action,
          );

          return updated
            ? connectionMessages[action]({
                count: updated,
                connection: connection.label,
              })
            : m.sync_command_all_unchanged({ connection: connection.label });
        })
      }
      automaticLinks={
        query.data ? (
          <AutomaticLinks
            organizationId={organizationId}
            connections={query.data.connections}
            coverage={query.data.linkCoverage}
            canManage={can('sync.manage') && query.data.canManage}
          />
        ) : null
      }
      refresh={() => void query.refetch()}
    />
  );
}

const commandMessages: Record<SyncCommand, () => string> = {
  pause: m.sync_command_paused,
  resume: m.sync_command_resumed,
  retry: m.sync_command_retry,
  reconcile: m.sync_command_reconcile,
  reimport: m.sync_command_reimport,
};

const connectionMessages: Record<
  SyncConnectionCommand,
  (inputs: { count: number; connection: string }) => string
> = {
  retry: m.sync_command_all_retry,
  pause: m.sync_command_all_paused,
  resume: m.sync_command_all_resumed,
};

/**
 * Presents Data sync: the workspace's sync health, what needs a person, every connection's
 * syncs as rows and, beside them, the open sync's detail. Rows open the detail pane, which
 * also follows J and K.
 */
export function SyncView({
  organizationId,
  overview,
  loading = false,
  error,
  offline = false,
  refreshing = false,
  canManage,
  pending = null,
  message = null,
  open,
  onOpenChange,
  history = { loading: false, error: false },
  records = closedRecords,
  command,
  commandAll,
  refresh,
  automaticLinks,
}: {
  organizationId: string;
  overview?: SyncOverview | undefined;
  automaticLinks?: ReactNode;
  loading?: boolean;
  error?: string | undefined;
  offline?: boolean;
  refreshing?: boolean;
  canManage: boolean;
  /** The sync or connection a command is updating. */
  pending?: string | null;
  message?: SyncMessage | null;
  /** The sync open in the detail pane. */
  open?: string | undefined;
  onOpenChange: (stream: string | undefined) => void;
  history?: RunHistory;
  /** The open sync's listed problem records. */
  records?: ProblemRecords;
  command: (stream: SyncStreamView, action: SyncCommand) => void;
  commandAll: (
    connection: SyncConnectionView,
    action: SyncConnectionCommand,
  ) => void;
  refresh: () => void;
}) {
  const manage = canManage && (overview?.canManage ?? true);
  const rows = useRef<HTMLDivElement>(null);
  const [help, setHelp] = useState(false);
  const [reimport, setReimport] = useState<SyncItem | null>(null);
  const items = overview ? syncItems(overview) : [];
  const keys = items.map((item) => item.stream.id);
  const openItem = items.find((item) => item.stream.id === open);
  const keyboard = useListKeyboard({
    rows,
    count: keys.length,
    keys,
    preview: { open, onOpenChange },
    onShowHelp: () => setHelp(true),
  });
  const busy = pending !== null;
  const paneMessage =
    message?.streamId && message.streamId === open ? message : null;
  const pageMessage = paneMessage ? null : message;

  const list = (
    <div className="sync-content">
      {pageMessage ? (
        <Alert tone={pageMessage.tone} role="status">
          {pageMessage.text}
        </Alert>
      ) : null}
      {overview ? (
        <>
          <SyncStatus overview={overview} />
          <Attention
            organizationId={organizationId}
            items={attentionItems(overview, manage)}
            canManage={manage}
            busy={busy}
            command={command}
            onReimport={setReimport}
            onOpen={onOpenChange}
          />
          {overview.connections.length ? (
            <section
              className="sync-connections"
              aria-labelledby="sync-connections-title"
            >
              <h2 id="sync-connections-title" className="sync-section-title">
                {m.sync_connections_title()}
                <span className="sync-section-count">
                  {count(overview.connections.length)}
                </span>
              </h2>
              <div ref={rows} className="sync-connection-list">
                {overview.connections.map((connection) => (
                  <ConnectionSync
                    key={connection.connectionId}
                    organizationId={organizationId}
                    connection={connection}
                    asOf={overview.asOf}
                    canManage={manage}
                    busy={busy}
                    pending={pending === connection.connectionId}
                    open={open}
                    focusedKey={keyboard.focusedKey}
                    onOpen={onOpenChange}
                    commandAll={commandAll}
                  />
                ))}
              </div>
            </section>
          ) : (
            <Empty>
              <Plug size={28} aria-hidden="true" />
              <h2>{m.sync_empty_title()}</h2>
              <p>{m.sync_empty_description()}</p>
              <Link
                className={buttonVariants({ variant: 'outline' })}
                to="/app/$organizationId/apps"
                params={{ organizationId }}
              >
                {m.sync_empty_action()}
              </Link>
            </Empty>
          )}
          {automaticLinks}
          <p className="sync-footnote">
            {m.sync_footnote()}{' '}
            <a href="/docs/data-sync">{m.sync_footnote_link()}</a>
          </p>
        </>
      ) : null}
    </div>
  );

  return (
    <main className="sync-page">
      <PageTitle
        title={m.sync_page_title()}
        actions={
          <RefreshButton
            label={m.sync_refresh_label()}
            refreshing={refreshing}
            onClick={refresh}
          />
        }
      />
      {offline ? <Alert role="status">{m.common_offline()}</Alert> : null}
      {error ? (
        <Alert tone="danger" role="alert">
          {error}{' '}
          <Button variant="outline" size="sm" onClick={refresh}>
            {m.common_retry()}
          </Button>
        </Alert>
      ) : null}
      {loading && !overview ? <SyncLoading /> : null}
      {overview ? (
        <CollectionPreview
          className="sync-split"
          open={!!open}
          list={list}
          label={m.sync_detail_label()}
          title={
            openItem
              ? m.sync_detail_title({
                  type: recordTypes[openItem.type].title,
                  connection: openItem.connection.label,
                })
              : undefined
          }
          preview={
            openItem ? (
              <StreamDetail
                key={openItem.stream.id}
                organizationId={organizationId}
                item={openItem}
                asOf={overview.asOf}
                canManage={manage}
                busy={busy}
                pending={pending === openItem.stream.id}
                message={paneMessage}
                history={history}
                records={records}
                command={command}
                onReimport={() => setReimport(openItem)}
              />
            ) : open ? (
              <div className="sync-detail-missing" role="status">
                <h3>{m.sync_detail_missing_title()}</h3>
                <p>{m.sync_detail_missing_description()}</p>
              </div>
            ) : null
          }
          onClose={() => onOpenChange(undefined)}
        />
      ) : null}
      <ReimportDialog
        item={reimport}
        onClose={() => setReimport(null)}
        onConfirm={(item) => {
          setReimport(null);
          command(item.stream, 'reimport');
        }}
      />
      <ShortcutHelp
        open={help}
        onOpenChange={setHelp}
        groups={[listShortcutGroup(shortcuts)]}
      />
    </main>
  );
}

function SyncLoading() {
  return (
    <div className="sync-loading" role="status">
      <span className="sr-only">{m.sync_loading()}</span>
      <span className="lu-skeleton sync-skeleton-status" />
      <span className="lu-skeleton sync-skeleton-connection" />
      <span className="lu-skeleton sync-skeleton-connection" />
    </div>
  );
}

/** The workspace summary: one sentence, syncs per state and how fresh the records are. */
function SyncStatus({ overview }: { overview: SyncOverview }) {
  const summary = overallState(overview);
  const health = syncHealth(overview);
  const figures = syncFigures(overview);
  const now = Date.parse(overview.asOf);
  const time = (value: string | null) =>
    value ? (
      <span title={value}>{ago(value, now)}</span>
    ) : (
      m.sync_summary_not_yet()
    );

  return (
    <Card as="section" className="sync-status" aria-labelledby="sync-status">
      <div className="sync-status-main">
        <StateDot state={summary.state} />
        <div>
          <h2 id="sync-status">{summary.title}</h2>
          <p>{summary.detail}</p>
        </div>
      </div>
      {health.length ? (
        <div className="sync-health">
          <div className="sync-health-bar" aria-hidden="true">
            {health.map((group) => (
              <span
                key={group.group}
                data-state={group.state}
                style={{ flexGrow: group.count }}
              />
            ))}
          </div>
          <ul className="sync-health-legend" aria-label={m.sync_health_label()}>
            {health.map((group) => (
              <li key={group.group}>
                <StateDot state={group.state} />
                {group.label}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {figures.total ? (
        <dl className="sync-figures">
          <div>
            <dt>{m.sync_summary_records()}</dt>
            <dd>{count(figures.records)}</dd>
          </div>
          <div>
            <dt>{m.sync_summary_history()}</dt>
            <dd>
              {m.sync_summary_history_value({
                done: figures.imported,
                total: figures.total,
              })}
            </dd>
          </div>
          <div>
            <dt>{m.sync_summary_oldest_sync()}</dt>
            <dd>
              {figures.neverSynced && figures.neverSynced < figures.total
                ? m.sync_summary_not_synced({ count: figures.neverSynced })
                : time(figures.oldestSync)}
            </dd>
          </div>
          <div>
            <dt>{m.sync_summary_oldest_check()}</dt>
            <dd>{time(figures.oldestCheck)}</dd>
          </div>
        </dl>
      ) : null}
    </Card>
  );
}

/** What needs a person, each with the step that resolves it. */
function Attention({
  organizationId,
  items,
  canManage,
  busy,
  command,
  onReimport,
  onOpen,
}: {
  organizationId: string;
  items: AttentionItem[];
  canManage: boolean;
  busy: boolean;
  command: (stream: SyncStreamView, action: SyncCommand) => void;
  onReimport: (item: SyncItem) => void;
  onOpen: (stream: string) => void;
}) {
  if (!items.length) return null;

  return (
    <section className="sync-attention" aria-labelledby="sync-attention-title">
      <h2 id="sync-attention-title" className="sync-section-title">
        {m.sync_attention_title()}
        <span className="sync-section-count">{count(items.length)}</span>
      </h2>
      <ul>
        {items.map((entry) => (
          <li key={entry.key} data-tone={entry.tone}>
            <div className="sync-attention-text">
              <span className="sync-attention-context">
                {entry.item ? (
                  <>
                    {(() => {
                      const Icon = recordTypes[entry.item.type].Icon;

                      return <Icon size={13} aria-hidden="true" />;
                    })()}
                    {m.sync_detail_title({
                      type: recordTypes[entry.item.type].title,
                      connection: entry.connection.label,
                    })}
                  </>
                ) : (
                  <>
                    <ProviderIcon provider={entry.connection.provider} />
                    {entry.connection.label}
                  </>
                )}
              </span>
              <strong>{entry.title}</strong>
              <p>{entry.detail}</p>
            </div>
            <div className="sync-attention-actions">
              <AttentionAction
                organizationId={organizationId}
                entry={entry}
                canManage={canManage}
                busy={busy}
                command={command}
                onReimport={onReimport}
              />
              {entry.item ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onOpen(entry.item!.stream.id)}
                >
                  {m.sync_attention_details()}
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AttentionAction({
  organizationId,
  entry,
  canManage,
  busy,
  command,
  onReimport,
}: {
  organizationId: string;
  entry: AttentionItem;
  canManage: boolean;
  busy: boolean;
  command: (stream: SyncStreamView, action: SyncCommand) => void;
  onReimport: (item: SyncItem) => void;
}) {
  const { action, item, connection } = entry;
  if (action === 'connection' && connection.appId)
    return (
      <Link
        className={buttonVariants({ variant: 'outline', size: 'sm' })}
        to="/app/$organizationId/apps/$appId/settings"
        params={{ organizationId, appId: connection.appId }}
        hash={`connection-${connection.connectionId}`}
      >
        {m.sync_connection_manage()}
      </Link>
    );
  if (!canManage || !item) return null;
  if (action === 'resume')
    return (
      <Button
        size="sm"
        disabled={busy}
        onClick={() => command(item.stream, 'resume')}
      >
        <Play aria-hidden="true" /> {m.sync_notice_principal_resume()}
      </Button>
    );
  if (action === 'retry')
    return (
      <Button
        size="sm"
        disabled={busy}
        onClick={() => command(item.stream, 'retry')}
      >
        <RefreshCw aria-hidden="true" /> {m.sync_action_retry_now()}
      </Button>
    );
  if (action === 'reimport')
    return (
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => onReimport(item)}
      >
        <History aria-hidden="true" />{' '}
        {m.sync_notice_older_action({ records: recordTypes[item.type].noun })}
      </Button>
    );

  return null;
}

/** One connection: its overall state, a row per sync and the record types it doesn't sync. */
function ConnectionSync({
  organizationId,
  connection,
  asOf,
  canManage,
  busy,
  pending,
  open,
  focusedKey,
  onOpen,
  commandAll,
}: {
  organizationId: string;
  connection: SyncConnectionView;
  asOf: string;
  canManage: boolean;
  busy: boolean;
  pending: boolean;
  open: string | undefined;
  focusedKey: string | undefined;
  onOpen: (stream: string) => void;
  commandAll: (
    connection: SyncConnectionView,
    action: SyncConnectionCommand,
  ) => void;
}) {
  const titleId = `sync-${connection.connectionId}`;
  const items = syncItems({
    connections: [connection],
    runs: [],
    canManage,
    asOf,
  });
  const summary = overallState({
    connections: [connection],
    runs: [],
    canManage: false,
    asOf,
  });
  const unavailable = connection.recordTypes.filter((item) => !item.stream);
  const reasons = new Map<string, string[]>();
  for (const item of unavailable) {
    const reason = unavailableReason(item.availability, connection);
    reasons.set(reason, [
      ...(reasons.get(reason) ?? []),
      recordTypes[item.recordType].title,
    ]);
  }
  const commands = connectionCommands(connection);
  const now = Date.parse(asOf);

  return (
    <Card
      as="section"
      className="sync-connection"
      aria-labelledby={titleId}
      data-pending={pending || undefined}
    >
      <header className="sync-connection-header">
        <div className="sync-connection-identity">
          <ProviderIcon provider={connection.provider} />
          <div>
            <h3 id={titleId}>{connection.label}</h3>
            <p>{providerName(connection.provider)}</p>
          </div>
        </div>
        <div className="sync-connection-meta">
          {connection.status !== 'active' ? (
            <Badge
              tone={
                ['disconnected', 'revoked'].includes(connection.status)
                  ? 'neutral'
                  : 'warning'
              }
            >
              {statuses[connection.status]}
            </Badge>
          ) : summary.state !== 'idle' ? (
            <StatePill state={summary.state}>{summary.title}</StatePill>
          ) : null}
          {connection.appId ? (
            <Link
              className="sync-manage-link"
              to="/app/$organizationId/apps/$appId/settings"
              params={{ organizationId, appId: connection.appId }}
              hash={`connection-${connection.connectionId}`}
            >
              {m.sync_connection_manage()}
            </Link>
          ) : null}
        </div>
        {canManage && items.length ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={busy}
                  aria-label={m.sync_connection_actions({
                    connection: connection.label,
                  })}
                />
              }
            >
              <MoreHorizontal aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {commands.retry.length ? (
                <DropdownMenuItem
                  onClick={() => commandAll(connection, 'retry')}
                >
                  <RefreshCw aria-hidden="true" /> {m.sync_action_sync_all()}
                </DropdownMenuItem>
              ) : null}
              {commands.resume.length ? (
                <DropdownMenuItem
                  onClick={() => commandAll(connection, 'resume')}
                >
                  <Play aria-hidden="true" /> {m.sync_action_resume_all()}
                </DropdownMenuItem>
              ) : null}
              {commands.pause.length ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => commandAll(connection, 'pause')}
                  >
                    <Pause aria-hidden="true" /> {m.sync_action_pause_all()}
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </header>
      {items.length ? (
        <CollectionList
          label={m.sync_connection_record_types({
            connection: connection.label,
          })}
          variant="plain"
          className="sync-streams"
          items={items}
          itemKey={(item) => item.stream.id}
          current={open}
          focusedKey={focusedKey}
          link={(item) => (
            <Link
              to="/app/$organizationId/sync"
              params={{ organizationId }}
              search={{ stream: item.stream.id }}
              resetScroll={false}
              aria-label={m.sync_stream_label({
                type: recordTypes[item.type].title,
                state: streamState(item.stream).label,
              })}
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
                onOpen(item.stream.id);
              }}
            />
          )}
          leading={(item) => {
            const Icon = recordTypes[item.type].Icon;

            return <Icon size={16} aria-hidden="true" />;
          }}
          title={(item) => recordTypes[item.type].title}
          description={(item) => <StreamBrief item={item} />}
          status={(item) => {
            const state = streamState(item.stream);

            return <StatePill state={state.state}>{state.label}</StatePill>;
          }}
          properties={['progress', 'synced']}
          property={(item, key) =>
            key === 'progress' ? (
              <StreamProgress item={item} />
            ) : (
              <StreamFreshness stream={item.stream} now={now} />
            )
          }
        />
      ) : null}
      {unavailable.length ? (
        <p className="sync-connection-unavailable">
          {[...reasons].map(([reason, types]) => (
            <span key={reason}>
              {m.sync_unavailable_types({
                reason,
                types: formatList(types),
              })}
            </span>
          ))}
        </p>
      ) : null}
    </Card>
  );
}

function StreamBrief({ item }: { item: SyncItem }) {
  const note = recordNote(item.type, item.stream);
  const waiting = waitingStatement(item.stream);

  return (
    <span className="sync-stream-brief">
      <span>{coverageBrief(item.type, item.stream)}</span>
      {note ? <span className="sync-stream-flag">{note}</span> : null}
      {waiting ? (
        <span
          className="sync-stream-wait"
          data-delayed={item.stream.waiting?.reason === 'delayed' || undefined}
        >
          {waiting}
        </span>
      ) : null}
    </span>
  );
}

/** A compact progress meter for a running read; nothing when no read runs. */
function StreamProgress({ item }: { item: SyncItem }) {
  const { stream, type } = item;
  if (!['importing', 'syncing', 'waiting'].includes(stream.status)) return null;
  const progress = scanProgress(type, stream);
  if (!progress) return null;

  return (
    <span className="sync-stream-progress">
      {stream.status !== 'waiting' ? (
        <Progress
          value={progress.value}
          label={
            stream.scan?.kind === 'backfill'
              ? m.sync_stream_progress_backfill({
                  type: recordTypes[type].title,
                })
              : m.sync_stream_progress_sync({ type: recordTypes[type].title })
          }
          valueText={progress.text}
        />
      ) : null}
      <small>{progress.text}</small>
    </span>
  );
}

/** When a sync last read successfully, and the next retry while it waits or fails. */
function StreamFreshness({
  stream,
  now,
}: {
  stream: SyncStreamView;
  now: number;
}) {
  const retry =
    stream.status === 'waiting' && stream.waiting?.until
      ? [
          'request_capacity',
          'admission_unavailable',
          'provider_cooldown',
        ].includes(stream.waiting.reason)
        ? stream.waiting.until
        : null
      : ['retrying', 'failing'].includes(stream.status)
        ? stream.nextRunAt
        : null;

  return (
    <span className="sync-stream-time">
      {stream.lastSuccessAt ? (
        <span title={stream.lastSuccessAt}>
          {m.sync_stream_synced({ time: ago(stream.lastSuccessAt, now) })}
        </span>
      ) : (
        <span>{m.sync_stream_not_synced()}</span>
      )}
      {retry ? (
        <small title={retry}>
          {m.sync_stream_next_retry({ time: soon(retry, now) })}
        </small>
      ) : stream.status === 'up_to_date' &&
        stream.nextRunAt &&
        Date.parse(stream.nextRunAt) > now ? (
        <small title={stream.nextRunAt}>
          {m.sync_stream_next_check({ time: soon(stream.nextRunAt, now) })}
        </small>
      ) : null}
      <ChevronRight
        className="sync-stream-chevron"
        size={16}
        aria-hidden="true"
      />
    </span>
  );
}

function ReimportDialog({
  item,
  onClose,
  onConfirm,
}: {
  item: SyncItem | null;
  onClose: () => void;
  onConfirm: (item: SyncItem) => void;
}) {
  const [shown, setShown] = useState(item);
  if (item && item !== shown) setShown(item);
  const noun = shown ? recordTypes[shown.type].noun : '';

  return (
    <Dialog
      open={!!item}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>{m.sync_reimport_title({ records: noun })}</DialogTitle>
        <DialogDescription>
          {m.sync_reimport_description({ records: noun })}
        </DialogDescription>
        <div className="sync-dialog-actions">
          <Button variant="outline" onClick={onClose}>
            {m.common_cancel()}
          </Button>
          <Button onClick={() => item && onConfirm(item)}>
            <RotateCcw aria-hidden="true" /> {m.sync_reimport_confirm()}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
