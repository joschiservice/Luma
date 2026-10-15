import './sync.css';

import type {
  SyncCommand,
  SyncConnectionView,
  SyncOverview,
  SyncRecordType,
  SyncStreamView,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
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
import { StateDot, StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { PageTitle } from '@luma/ui/components/workspace/page-header';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import {
  CircleCheck,
  History,
  MoreHorizontal,
  Pause,
  Play,
  Plug,
  RefreshCw,
  RotateCcw,
  ScanSearch,
} from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';

import { statuses } from '../../kit/connections/presentation';
import { ProviderIcon } from '../../kit/connections/provider-icon';
import { SignInRedirect } from '../../kit/identity/common';
import { IdentityError } from '../../kit/identity/data';
import { usePermissions } from '../../kit/identity/permissions';
import { AutomaticLinks } from './automatic-links';
import { sendSyncCommand, syncKey, syncOptions } from './data';
import {
  ago,
  count,
  coverageStatement,
  day,
  overallState,
  providerName,
  records,
  recordTypes,
  runSummary,
  scanKinds,
  scanProgress,
  soon,
  streamState,
  triggers,
  unavailableReason,
  waitingStatement,
} from './presentation';

/** Connects the Data sync page to workspace-scoped queries and sync commands. */
export function SyncPage() {
  const { organizationId } = useParams({ from: '/app/$organizationId/sync' });
  const query = useQuery(syncOptions(organizationId));
  const { can } = usePermissions(organizationId);
  const client = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    tone: 'success' | 'danger';
    text: string;
  } | null>(null);
  const lock = useRef(false);
  if (query.error instanceof IdentityError && query.error.status === 401)
    return <SignInRedirect />;

  async function command(stream: SyncStreamView, action: SyncCommand) {
    if (lock.current) return;
    lock.current = true;
    setPending(stream.id);
    setMessage(null);
    try {
      await sendSyncCommand(organizationId, stream.id, action);
      setMessage({ tone: 'success', text: commandMessages[action]() });
    } catch (error) {
      setMessage({
        tone: 'danger',
        text:
          error instanceof IdentityError && error.status === 403
            ? m.sync_command_forbidden()
            : m.sync_command_failed(),
      });
    } finally {
      await client.invalidateQueries({ queryKey: syncKey(organizationId) });
      lock.current = false;
      setPending(null);
    }
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
      command={(stream, action) => void command(stream, action)}
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

/** Presents import progress, sync health and record coverage for every connection. */
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
  command,
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
  pending?: string | null;
  message?: { tone: 'success' | 'danger'; text: string } | null;
  command: (stream: SyncStreamView, action: SyncCommand) => void;
  refresh: () => void;
}) {
  const manage = canManage && (overview?.canManage ?? true);

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
      {message ? (
        <Alert tone={message.tone} role="status">
          {message.text}
        </Alert>
      ) : null}
      {loading && !overview ? (
        <div className="sync-loading" role="status">
          {m.sync_loading()}
        </div>
      ) : null}
      {overview ? (
        <>
          <SyncSummary overview={overview} />
          {overview.connections.length ? (
            overview.connections.map((connection) => (
              <ConnectionSync
                key={connection.connectionId}
                organizationId={organizationId}
                connection={connection}
                asOf={overview.asOf}
                canManage={manage}
                pending={pending}
                command={command}
              />
            ))
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
          <RecentRuns overview={overview} />
          <p className="sync-footnote">
            {m.sync_footnote()}{' '}
            <a href="/docs/data-sync">{m.sync_footnote_link()}</a>
          </p>
        </>
      ) : null}
    </main>
  );
}

function SyncSummary({ overview }: { overview: SyncOverview }) {
  const summary = overallState(overview);
  const streams = overview.connections.flatMap((connection) =>
    connection.recordTypes.flatMap(({ stream }) => (stream ? [stream] : [])),
  );
  const imported = streams.reduce((sum, s) => sum + s.records.total, 0);
  const lastCheck = streams
    .map((stream) => stream.lastFullScanAt)
    .filter((value): value is string => !!value)
    .sort()[0];

  return (
    <Card as="section" className="sync-summary" aria-labelledby="sync-summary">
      <div className="sync-summary-main">
        <StateDot state={summary.state} />
        <div>
          <h2 id="sync-summary">{summary.title}</h2>
          <p>{summary.detail}</p>
        </div>
      </div>
      <dl className="sync-summary-stats">
        <div>
          <dt>{m.sync_summary_records()}</dt>
          <dd>{count(imported)}</dd>
        </div>
        <div>
          <dt>{m.sync_summary_connections()}</dt>
          <dd>{count(overview.connections.length)}</dd>
        </div>
        <div>
          <dt>{m.sync_summary_oldest_check()}</dt>
          <dd>
            {lastCheck ? (
              <span title={lastCheck}>
                {ago(lastCheck, Date.parse(overview.asOf))}
              </span>
            ) : (
              m.sync_summary_not_yet()
            )}
          </dd>
        </div>
      </dl>
    </Card>
  );
}

function ConnectionSync({
  organizationId,
  connection,
  asOf,
  canManage,
  pending,
  command,
}: {
  organizationId: string;
  connection: SyncConnectionView;
  asOf: string;
  canManage: boolean;
  pending: string | null;
  command: (stream: SyncStreamView, action: SyncCommand) => void;
}) {
  const titleId = `sync-${connection.connectionId}`;

  return (
    <Card as="section" className="sync-connection" aria-labelledby={titleId}>
      <CardHeader>
        <div className="sync-connection-identity">
          <ProviderIcon provider={connection.provider} />
          <div>
            <p className="eyebrow">{providerName(connection.provider)}</p>
            <CardTitle as="h2" id={titleId}>
              {connection.label}
            </CardTitle>
          </div>
        </div>
        <div className="sync-connection-meta">
          <Badge
            tone={
              connection.status === 'active'
                ? 'success'
                : ['disconnected', 'revoked'].includes(connection.status)
                  ? 'neutral'
                  : 'warning'
            }
          >
            {statuses[connection.status]}
          </Badge>
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
      </CardHeader>
      {connection.status !== 'active' ? (
        <CardDescription>{m.sync_connection_inactive()}</CardDescription>
      ) : null}
      <ul
        className="sync-streams"
        aria-label={m.sync_connection_record_types({
          connection: connection.label,
        })}
      >
        {connection.recordTypes.map((item) => (
          <li key={item.recordType}>
            {item.stream ? (
              <StreamRow
                type={item.recordType}
                stream={item.stream}
                asOf={asOf}
                canManage={canManage}
                pending={pending === item.stream.id}
                command={command}
              />
            ) : (
              <div className="sync-stream sync-stream-unavailable">
                <RecordType type={item.recordType} />
                <span className="sync-stream-muted sync-stream-reason">
                  {unavailableReason(item.availability, connection)}
                </span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function RecordType({ type }: { type: SyncRecordType }) {
  const info = recordTypes[type];

  return (
    <span className="sync-record-type">
      <info.Icon size={15} aria-hidden="true" />
      <strong>{info.title}</strong>
    </span>
  );
}

function StreamRow({
  type,
  stream,
  asOf,
  canManage,
  pending,
  command,
}: {
  type: SyncRecordType;
  stream: SyncStreamView;
  asOf: string;
  canManage: boolean;
  pending: boolean;
  command: (stream: SyncStreamView, action: SyncCommand) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const now = Date.parse(asOf);
  const state = streamState(stream);
  const progress = ['importing', 'syncing', 'waiting'].includes(stream.status)
    ? scanProgress(type, stream)
    : null;
  const waiting = waitingStatement(stream);
  const coverage = coverageStatement(type, stream);
  const noun = recordTypes[type].noun;
  const label = m.sync_stream_label({
    type: recordTypes[type].title,
    state: state.label,
  });
  const startsNow = stream.nextRunAt
    ? Date.parse(stream.nextRunAt) - now < 10_000
    : false;

  return (
    <div className="sync-stream" aria-label={label} role="group">
      <RecordType type={type} />
      <div className="sync-stream-status">
        <StatePill state={state.state}>{state.label}</StatePill>
        {waiting ? <small className="sync-stream-note">{waiting}</small> : null}
        {progress ? (
          <div className="sync-stream-progress">
            {stream.status !== 'waiting' ? (
              <Progress
                value={progress.value}
                label={
                  stream.scan?.kind === 'backfill'
                    ? m.sync_stream_progress_backfill({
                        type: recordTypes[type].title,
                      })
                    : m.sync_stream_progress_sync({
                        type: recordTypes[type].title,
                      })
                }
                valueText={progress.text}
              />
            ) : null}
            <small>{progress.text}</small>
          </div>
        ) : null}
      </div>
      <div className="sync-stream-coverage">
        {stream.coverage.recentCompletedAt &&
        stream.coverage.recentFrom &&
        stream.phase === 'backfill' ? (
          <span className="sync-recent-coverage">
            <CircleCheck size={14} aria-hidden="true" />
            {stream.records.failed || stream.records.pending
              ? m.sync_stream_recent_read()
              : m.sync_stream_recent_imported()}
          </span>
        ) : null}
        <p>{coverage.text}</p>
      </div>
      <div className="sync-stream-time">
        {stream.lastSuccessAt ? (
          <span title={stream.lastSuccessAt}>
            {m.sync_stream_synced({ time: ago(stream.lastSuccessAt, now) })}
          </span>
        ) : (
          <span>{m.sync_stream_not_synced()}</span>
        )}
        {stream.status === 'waiting' &&
        stream.waiting?.until &&
        [
          'request_capacity',
          'admission_unavailable',
          'provider_cooldown',
        ].includes(stream.waiting.reason) ? (
          <small title={stream.waiting.until}>
            {m.sync_stream_next_retry({
              time: soon(stream.waiting.until, now),
            })}
          </small>
        ) : stream.status !== 'waiting' &&
          stream.nextRunAt &&
          (!stream.scan ||
            stream.status === 'retrying' ||
            stream.status === 'failing') ? (
          <small title={stream.nextRunAt}>
            {startsNow
              ? m.sync_stream_starting_now()
              : stream.error
                ? m.sync_stream_next_retry({
                    time: soon(stream.nextRunAt, now),
                  })
                : m.sync_stream_next_check({
                    time: soon(stream.nextRunAt, now),
                  })}
          </small>
        ) : null}
      </div>
      <div className="sync-stream-actions">
        {canManage ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={pending}
                  aria-label={m.sync_stream_actions({
                    type: recordTypes[type].title,
                  })}
                />
              }
            >
              <MoreHorizontal aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {stream.paused ? (
                <DropdownMenuItem onClick={() => command(stream, 'resume')}>
                  <Play aria-hidden="true" /> {m.sync_action_resume()}
                </DropdownMenuItem>
              ) : (
                <>
                  <DropdownMenuItem onClick={() => command(stream, 'retry')}>
                    <RefreshCw aria-hidden="true" />
                    {stream.error
                      ? m.sync_action_retry_now()
                      : m.sync_action_sync_now()}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={stream.phase === 'backfill'}
                    onClick={() => command(stream, 'reconcile')}
                  >
                    <ScanSearch aria-hidden="true" />{' '}
                    {m.sync_action_check_all()}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setConfirm(true)}>
                    <History aria-hidden="true" /> {m.sync_action_reimport()}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => command(stream, 'pause')}>
                    <Pause aria-hidden="true" /> {m.sync_action_pause()}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      <StreamNotices
        type={type}
        stream={stream}
        now={now}
        canManage={canManage}
        pending={pending}
        command={command}
        onReimport={() => setConfirm(true)}
      />
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogTitle>{m.sync_reimport_title({ records: noun })}</DialogTitle>
          <DialogDescription>
            {m.sync_reimport_description({ records: noun })}
          </DialogDescription>
          <div className="sync-dialog-actions">
            <Button variant="outline" onClick={() => setConfirm(false)}>
              {m.common_cancel()}
            </Button>
            <Button
              onClick={() => {
                setConfirm(false);
                command(stream, 'reimport');
              }}
            >
              <RotateCcw aria-hidden="true" /> {m.sync_reimport_confirm()}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StreamNotices({
  type,
  stream,
  now,
  canManage,
  pending,
  command,
  onReimport,
}: {
  type: SyncRecordType;
  stream: SyncStreamView;
  now: number;
  canManage: boolean;
  pending: boolean;
  command: (stream: SyncStreamView, action: SyncCommand) => void;
  onReimport: () => void;
}) {
  const notices = [];
  const noun = recordTypes[type].noun;
  if (stream.blocked === 'principal_unavailable')
    notices.push(
      <Alert key="principal" tone="warning">
        <AlertTitle>{m.sync_notice_principal_title()}</AlertTitle>
        <AlertDescription>
          {canManage
            ? m.sync_notice_principal_manage()
            : m.sync_notice_principal_view()}
        </AlertDescription>
        {canManage ? (
          <Button
            size="sm"
            disabled={pending}
            onClick={() => command(stream, 'resume')}
          >
            <Play aria-hidden="true" /> {m.sync_notice_principal_resume()}
          </Button>
        ) : null}
      </Alert>,
    );
  else if (stream.error)
    notices.push(
      <Alert
        key="error"
        tone={stream.status === 'failing' ? 'danger' : 'warning'}
      >
        <AlertTitle>
          {stream.status === 'failing'
            ? m.sync_notice_failing_title({ count: stream.error.attempts })
            : m.sync_notice_failed_title()}
        </AlertTitle>
        <AlertDescription>
          {stream.error.code === 'rate_limited'
            ? m.sync_wait_provider_cooldown()
            : stream.error.message}{' '}
          {stream.nextRunAt
            ? m.sync_notice_next_attempt({ time: soon(stream.nextRunAt, now) })
            : ''}{' '}
          {rich(m.sync_notice_last_failure, {
            date: <WorkspaceDate value={stream.error.at} />,
          })}
        </AlertDescription>
        {canManage ? (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => command(stream, 'retry')}
          >
            <RefreshCw aria-hidden="true" /> {m.sync_action_retry_now()}
          </Button>
        ) : null}
      </Alert>,
    );
  if (stream.coverage.olderHistoryAvailable)
    notices.push(
      <Alert key="older" tone="success">
        <AlertTitle>{m.sync_notice_older_title({ records: noun })}</AlertTitle>
        <AlertDescription>
          {stream.coverage.historyFrom
            ? m.sync_notice_older_description({
                records: noun,
                date: coverageDay(stream),
              })
            : m.sync_notice_older_description_undated({ records: noun })}
        </AlertDescription>
        {canManage ? (
          <Button size="sm" disabled={pending} onClick={onReimport}>
            <History aria-hidden="true" />{' '}
            {m.sync_notice_older_action({ records: noun })}
          </Button>
        ) : null}
      </Alert>,
    );
  else if (stream.coverage.historyFrom && stream.phase === 'incremental')
    notices.push(
      <Alert key="limited" tone="info">
        <AlertTitle>
          {m.sync_notice_limited_title({ records: noun })}
        </AlertTitle>
        <AlertDescription>
          {stream.coverage.historyRequirement
            ? m.sync_notice_limited_access({
                records: noun,
                date: coverageDay(stream),
              })
            : m.sync_notice_limited_description({
                records: noun,
                date: coverageDay(stream),
              })}
        </AlertDescription>
      </Alert>,
    );
  const waiting = stream.records.pending;
  const failed = stream.records.failed;
  if (waiting)
    notices.push(
      <p key="waiting" className="sync-stream-note">
        {m.sync_note_waiting({ records: records(type, waiting) })}
      </p>,
    );
  if (failed)
    notices.push(
      <p key="failed" className="sync-stream-note">
        {stream.problems.length
          ? m.sync_note_failed_reasons({
              records: records(type, failed),
              reasons: stream.problems.join('; '),
            })
          : m.sync_note_failed({ records: records(type, failed) })}
      </p>,
    );
  if (stream.records.retired)
    notices.push(
      <p key="retired" className="sync-stream-note">
        {m.sync_note_retired({
          records: records(type, stream.records.retired),
        })}
      </p>,
    );
  if (stream.records.missing)
    notices.push(
      <p key="missing" className="sync-stream-note">
        {m.sync_note_missing({
          records: records(type, stream.records.missing),
        })}
      </p>,
    );

  return notices.length ? (
    <div className="sync-stream-notices">{notices}</div>
  ) : null;
}

const coverageDay = (stream: SyncStreamView) =>
  day(stream.coverage.historyFrom!);

function RecentRuns({ overview }: { overview: SyncOverview }) {
  const labels = new Map(
    overview.connections.map((connection) => [
      connection.connectionId,
      connection.label,
    ]),
  );
  if (!overview.runs.length) return null;

  return (
    <Disclosure className="sync-runs">
      <summary>{m.sync_runs_title()}</summary>
      <ol>
        {overview.runs.map((run) => (
          <li key={run.id}>
            {run.outcome === 'completed' ? (
              <CircleCheck size={15} aria-hidden="true" />
            ) : (
              <StateDot
                state={run.outcome === 'running' ? 'running' : 'idle'}
              />
            )}
            <span className="sync-run-main">
              <strong>
                {run.createdSince
                  ? m.sync_run_kind_recent()
                  : scanKinds[run.kind]()}{' '}
                · {recordTypes[run.recordType].title}
              </strong>
              <small>
                {[
                  labels.get(run.connectionId) ?? m.sync_run_connection(),
                  triggers[run.trigger](),
                  run.outcome === 'cancelled' ? m.sync_run_replaced() : '',
                  run.errors ? m.sync_run_retried({ count: run.errors }) : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </small>
            </span>
            <span className="sync-run-summary">{runSummary(run)}</span>
            <small className="sync-run-time">
              <WorkspaceDate value={run.startedAt} />
            </small>
          </li>
        ))}
      </ol>
    </Disclosure>
  );
}
