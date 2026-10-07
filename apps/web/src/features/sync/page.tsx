import './sync.css';

import type {
  SyncCommand,
  SyncConnectionView,
  SyncOverview,
  SyncRecordType,
  SyncStreamView,
} from '@luma/api-contract';
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
import { useRef, useState } from 'react';

import { statuses } from '../connections/presentation';
import { ProviderIcon } from '../connections/provider-icon';
import { SignInRedirect } from '../identity/common';
import { IdentityError } from '../identity/data';
import { usePermissions } from '../identity/permissions';
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
      setMessage({ tone: 'success', text: commandMessages[action] });
    } catch (error) {
      setMessage({
        tone: 'danger',
        text:
          error instanceof IdentityError && error.status === 403
            ? 'Your role doesn’t include Manage imports, so you can’t control syncs.'
            : 'Luma could not update this sync. Refresh and try again.',
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
      error={query.error ? 'Sync status could not be loaded.' : undefined}
      offline={query.isPaused}
      refreshing={query.isFetching}
      canManage={can('sync.manage')}
      pending={pending}
      message={message}
      command={(stream, action) => void command(stream, action)}
      refresh={() => void query.refetch()}
    />
  );
}

const commandMessages: Record<SyncCommand, string> = {
  pause: 'Sync paused. Records already imported stay available.',
  resume: 'Sync resumed with your access.',
  retry: 'Luma will try again now.',
  reconcile: 'Full check requested. Luma rereads every record from the source.',
  reimport:
    'History import restarted. Unchanged records are recognized and not duplicated.',
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
}: {
  organizationId: string;
  overview?: SyncOverview | undefined;
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
        title="Data sync"
        actions={
          <Button
            variant="outline"
            onClick={refresh}
            disabled={refreshing}
            aria-label="Refresh sync status"
          >
            <RefreshCw
              size={14}
              aria-hidden="true"
              className={refreshing ? 'sync-spin' : undefined}
            />
            Refresh
          </Button>
        }
      />
      {offline ? (
        <Alert role="status">You are offline. Reconnect to refresh.</Alert>
      ) : null}
      {error ? (
        <Alert tone="danger" role="alert">
          {error}{' '}
          <Button variant="outline" size="sm" onClick={refresh}>
            Retry
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
          Loading sync status…
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
              <h2>Connect a system to import its history</h2>
              <p>
                When you connect Shopify or JTL, Luma imports orders,
                fulfillments, products, stock and permitted customers, then
                keeps them in sync.
              </p>
              <Link
                className={buttonVariants({ variant: 'outline' })}
                to="/app/$organizationId/apps"
                params={{ organizationId }}
              >
                Connect a system
              </Link>
            </Empty>
          )}
          <RecentRuns overview={overview} />
          <p className="sync-footnote">
            Luma never changes records in your systems while syncing. Change
            notifications queue a read within seconds; source limits can delay
            it. Without them, Luma checks for changes every few minutes and
            rereads everything once a day.{' '}
            <a href="/docs/data-sync">How data sync works</a>
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
          <dt>Records in Luma</dt>
          <dd>{count(imported)}</dd>
        </div>
        <div>
          <dt>Connections</dt>
          <dd>{count(overview.connections.length)}</dd>
        </div>
        <div>
          <dt>Oldest full check</dt>
          <dd>
            {lastCheck ? (
              <span title={lastCheck}>
                {ago(lastCheck, Date.parse(overview.asOf))}
              </span>
            ) : (
              'Not yet'
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
              Manage connection
            </Link>
          ) : null}
        </div>
      </CardHeader>
      {connection.status !== 'active' ? (
        <CardDescription>
          Syncing pauses while the connection is not active. Records already
          imported stay in Luma.
        </CardDescription>
      ) : null}
      <ul
        className="sync-streams"
        aria-label={`${connection.label} record types`}
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
  const progress = ['importing', 'syncing'].includes(stream.status)
    ? scanProgress(type, stream)
    : null;
  const coverage = coverageStatement(type, stream);
  const noun = recordTypes[type].noun;
  const label = `${recordTypes[type].title} ${state.label.toLowerCase()}`;

  return (
    <div className="sync-stream" aria-label={label} role="group">
      <RecordType type={type} />
      <div className="sync-stream-status">
        <StatePill state={state.state}>{state.label}</StatePill>
        {progress ? (
          <div className="sync-stream-progress">
            <Progress
              value={progress.value}
              label={`${recordTypes[type].title} ${stream.scan?.kind === 'backfill' ? 'history import' : 'sync'}`}
              valueText={progress.text}
            />
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
            Recent history{' '}
            {stream.records.failed || stream.records.pending
              ? 'read'
              : 'imported'}
          </span>
        ) : null}
        <p>{coverage.text}</p>
      </div>
      <div className="sync-stream-time">
        {stream.lastSuccessAt ? (
          <span title={stream.lastSuccessAt}>
            Synced {ago(stream.lastSuccessAt, now)}
          </span>
        ) : (
          <span>Not synced yet</span>
        )}
        {stream.status === 'waiting' ? (
          <small>Starts after orders</small>
        ) : stream.nextRunAt && !stream.scan ? (
          <small title={stream.nextRunAt}>
            {soon(stream.nextRunAt, now) === 'now'
              ? 'Starting now'
              : `${stream.error ? 'Retry' : 'Next check'} ${soon(stream.nextRunAt, now)}`}
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
                  aria-label={`${recordTypes[type].title} sync actions`}
                />
              }
            >
              <MoreHorizontal aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {stream.paused ? (
                <DropdownMenuItem onClick={() => command(stream, 'resume')}>
                  <Play aria-hidden="true" /> Resume
                </DropdownMenuItem>
              ) : (
                <>
                  <DropdownMenuItem onClick={() => command(stream, 'retry')}>
                    <RefreshCw aria-hidden="true" />
                    {stream.error ? 'Retry now' : 'Sync now'}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={stream.phase === 'backfill'}
                    onClick={() => command(stream, 'reconcile')}
                  >
                    <ScanSearch aria-hidden="true" /> Check all records
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setConfirm(true)}>
                    <History aria-hidden="true" /> Re-import history
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => command(stream, 'pause')}>
                    <Pause aria-hidden="true" /> Pause
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
          <DialogTitle>Re-import {noun} history?</DialogTitle>
          <DialogDescription>
            Luma rereads every {recordTypes[type].one} the source shares.
            Records already in Luma stay available and unchanged records are not
            duplicated. Large histories can take a while.
          </DialogDescription>
          <div className="sync-dialog-actions">
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setConfirm(false);
                command(stream, 'reimport');
              }}
            >
              <RotateCcw aria-hidden="true" /> Re-import history
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
        <AlertTitle>This sync is waiting for someone to resume it</AlertTitle>
        <AlertDescription>
          The person it ran as no longer manages this workspace.
          {canManage ? ' Resume it to continue with your access.' : ''}
        </AlertDescription>
        {canManage ? (
          <Button
            size="sm"
            disabled={pending}
            onClick={() => command(stream, 'resume')}
          >
            <Play aria-hidden="true" /> Resume with my access
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
            ? `Failed ${count(stream.error.attempts)} times in a row`
            : 'The last read failed'}
        </AlertTitle>
        <AlertDescription>
          {stream.error.message}{' '}
          {stream.nextRunAt
            ? `Next attempt ${soon(stream.nextRunAt, now)}.`
            : ''}{' '}
          Last failure <WorkspaceDate value={stream.error.at} />.
        </AlertDescription>
        {canManage ? (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => command(stream, 'retry')}
          >
            <RefreshCw aria-hidden="true" /> Retry now
          </Button>
        ) : null}
      </Alert>,
    );
  if (stream.coverage.olderHistoryAvailable)
    notices.push(
      <Alert key="older" tone="success">
        <AlertTitle>Older {noun} are now available</AlertTitle>
        <AlertDescription>
          The source no longer limits history. Re-import to add {noun} from
          before{' '}
          {stream.coverage.historyFrom ? coverageDay(stream) : 'the import'}.
        </AlertDescription>
        {canManage ? (
          <Button size="sm" disabled={pending} onClick={onReimport}>
            <History aria-hidden="true" /> Import older {noun}
          </Button>
        ) : null}
      </Alert>,
    );
  else if (stream.coverage.historyFrom && stream.phase === 'incremental')
    notices.push(
      <Alert key="limited" tone="info">
        <AlertTitle>Only recent {noun} were shared</AlertTitle>
        <AlertDescription>
          The source shared {noun} from {coverageDay(stream)} onward
          {stream.coverage.historyRequirement
            ? `. Older ${noun} need the ${stream.coverage.historyRequirement} permission`
            : ''}
          . Luma keeps every {recordTypes[type].one} it has imported, so
          coverage grows from here.
        </AlertDescription>
      </Alert>,
    );
  const waiting = stream.records.pending;
  const failed = stream.records.failed;
  if (waiting)
    notices.push(
      <p key="waiting" className="sync-stream-note">
        {records(type, waiting)} waiting for related records to arrive. Luma
        imports them on a later pass.
      </p>,
    );
  if (failed)
    notices.push(
      <p key="failed" className="sync-stream-note">
        {records(type, failed)} could not be imported
        {stream.problems.length ? `: ${stream.problems.join('; ')}` : ''}.
      </p>,
    );
  if (stream.records.missing)
    notices.push(
      <p key="missing" className="sync-stream-note">
        {records(type, stream.records.missing)} no longer found at the source in
        the last full check. Luma keeps them; check whether they were deleted
        there.
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
      <summary>Recent sync runs</summary>
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
                  ? 'Recent history import'
                  : scanKinds[run.kind]}{' '}
                · {recordTypes[run.recordType].title}
              </strong>
              <small>
                {labels.get(run.connectionId) ?? 'Connection'} ·{' '}
                {triggers[run.trigger]}
                {run.outcome === 'cancelled'
                  ? ' · Replaced by a newer run'
                  : ''}
                {run.errors
                  ? ` · ${count(run.errors)} failed ${run.errors === 1 ? 'read' : 'reads'} retried`
                  : ''}
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
