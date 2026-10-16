import type {
  SyncCommand,
  SyncRecordState,
  SyncRecordView,
  SyncRunView,
  SyncStreamView,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import { Progress } from '@luma/ui/components/primitives/progress';
import { StateDot, StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { Link } from '@tanstack/react-router';
import {
  ArrowRight,
  ChevronDown,
  CircleCheck,
  History,
  Pause,
  Play,
  RefreshCw,
  ScanSearch,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { PreviewFact } from '../../kit/collections/preview';
import {
  ago,
  count,
  coverageStatement,
  day,
  recordLists,
  records,
  recordTypes,
  runDuration,
  runKind,
  runSummary,
  scanProgress,
  soon,
  streamExplanation,
  streamState,
  type SyncItem,
  triggers,
} from './presentation';

/** A command's outcome, shown next to the sync it concerns when that sync is open. */
export interface SyncMessage {
  tone: 'success' | 'danger';
  text: string;
  /** The sync the command targeted, if it targeted one. */
  streamId?: string | undefined;
}

/** The open sync's run history as loaded for its detail pane, newest first. */
export interface RunHistory {
  runs?: SyncRunView[] | undefined;
  loading: boolean;
  error: boolean;
  /** Older runs exist beyond the loaded pages. */
  more?: boolean | undefined;
  loadingMore?: boolean | undefined;
  moreError?: boolean | undefined;
  loadMore?: (() => void) | undefined;
}

/** The open sync's records in one problem state, as listed beneath its count. */
export interface ProblemRecords {
  /** The state whose records are listed, if any. */
  state: SyncRecordState | null;
  onStateChange: (state: SyncRecordState | null) => void;
  records?: SyncRecordView[] | undefined;
  loading: boolean;
  error: boolean;
  more: boolean;
  loadingMore: boolean;
  loadMore: () => void;
}

/** No records listed, for views that do not load them. */
export const closedRecords: ProblemRecords = {
  state: null,
  onStateChange: () => undefined,
  loading: false,
  error: false,
  more: false,
  loadingMore: false,
  loadMore: () => undefined,
};

/**
 * The open sync's detail: what it is doing and what happens next, its import progress, the
 * records it holds and their problems, its schedule, its latest runs and the commands a manager
 * can send. Commands disable while any command runs.
 */
export function StreamDetail({
  organizationId,
  item,
  asOf,
  canManage,
  busy,
  pending,
  message,
  history,
  records = closedRecords,
  command,
  onReimport,
}: {
  organizationId: string;
  item: SyncItem;
  asOf: string;
  canManage: boolean;
  busy: boolean;
  pending: boolean;
  message: SyncMessage | null;
  history: RunHistory;
  records?: ProblemRecords;
  command: (stream: SyncStreamView, action: SyncCommand) => void;
  onReimport: () => void;
}) {
  const { stream, type, connection } = item;
  const now = Date.parse(asOf);
  const state = streamState(stream);
  const delayed =
    stream.status === 'waiting' && stream.waiting?.reason === 'delayed';

  return (
    <div
      className="collection-preview-body sync-detail"
      aria-busy={pending || undefined}
    >
      <section
        className="sync-detail-status"
        aria-label={m.sync_detail_status()}
      >
        <StatePill state={state.state}>{state.label}</StatePill>
        <p>{streamExplanation(stream, canManage)}</p>
        {stream.error ? (
          <p className="sync-detail-note">
            {stream.status === 'failing'
              ? m.sync_notice_failing_title({ count: stream.error.attempts })
              : m.sync_notice_failed_title()}
            {'. '}
            {stream.nextRunAt
              ? m.sync_notice_next_attempt({
                  time: soon(stream.nextRunAt, now),
                })
              : null}{' '}
            {rich(m.sync_notice_last_failure, {
              date: <WorkspaceDate value={stream.error.at} />,
            })}
          </p>
        ) : null}
        {message ? (
          <Alert tone={message.tone} role="status">
            {message.text}
          </Alert>
        ) : null}
        <PrimaryAction
          organizationId={organizationId}
          item={item}
          canManage={canManage}
          busy={busy}
          command={command}
        />
      </section>

      <ImportProgress item={item} now={now} />

      <section aria-labelledby="sync-detail-coverage">
        <h3 id="sync-detail-coverage" className="collection-preview-heading">
          {m.sync_detail_coverage()}
        </h3>
        <p className="sync-detail-text">
          {coverageStatement(type, stream).text}
        </p>
        {stream.coverage.historyFrom &&
        stream.phase === 'incremental' &&
        !stream.coverage.olderHistoryAvailable ? (
          <p className="collection-preview-note">
            {stream.coverage.historyRequirement
              ? m.sync_notice_limited_access({
                  records: recordTypes[type].noun,
                  date: day(stream.coverage.historyFrom),
                })
              : m.sync_notice_limited_description({
                  records: recordTypes[type].noun,
                  date: day(stream.coverage.historyFrom),
                })}
          </p>
        ) : null}
        {stream.coverage.olderHistoryAvailable ? (
          <div className="sync-detail-callout">
            <p>
              <strong>
                {m.sync_notice_older_title({ records: recordTypes[type].noun })}
              </strong>{' '}
              {stream.coverage.historyFrom
                ? m.sync_notice_older_description({
                    records: recordTypes[type].noun,
                    date: day(stream.coverage.historyFrom),
                  })
                : m.sync_notice_older_description_undated({
                    records: recordTypes[type].noun,
                  })}
            </p>
            {canManage ? (
              <Button size="sm" disabled={busy} onClick={onReimport}>
                <History aria-hidden="true" />{' '}
                {m.sync_notice_older_action({
                  records: recordTypes[type].noun,
                })}
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>

      <RecordHealth
        organizationId={organizationId}
        item={item}
        records={records}
        now={now}
      />

      <section aria-labelledby="sync-detail-schedule">
        <h3 id="sync-detail-schedule" className="collection-preview-heading">
          {m.sync_detail_schedule()}
        </h3>
        <dl className="collection-preview-facts">
          <PreviewFact label={m.sync_detail_last_sync()}>
            <Moment value={stream.lastSuccessAt} now={now} />
          </PreviewFact>
          <PreviewFact label={m.sync_detail_last_check()}>
            <Moment value={stream.lastFullScanAt} now={now} />
          </PreviewFact>
          <PreviewFact
            label={
              delayed
                ? m.sync_detail_due()
                : stream.error
                  ? m.sync_detail_next_retry()
                  : m.sync_detail_next_check()
            }
          >
            {stream.paused || stream.blocked || !stream.nextRunAt ? (
              m.sync_detail_not_scheduled()
            ) : delayed ? (
              <Moment value={stream.nextRunAt} now={now} />
            ) : (
              <span title={stream.nextRunAt}>
                {soon(stream.nextRunAt, now)}
              </span>
            )}
          </PreviewFact>
          <PreviewFact label={m.sync_detail_history()}>
            {stream.backfillCompletedAt
              ? rich(m.sync_detail_history_completed, {
                  date: <WorkspaceDate value={stream.backfillCompletedAt} />,
                })
              : stream.backfillStartedAt
                ? rich(m.sync_detail_history_started, {
                    date: <WorkspaceDate value={stream.backfillStartedAt} />,
                  })
                : m.sync_summary_not_yet()}
          </PreviewFact>
        </dl>
        <p className="collection-preview-note">{m.sync_detail_cadence()}</p>
      </section>

      <Runs history={history} now={now} />

      <Commands
        item={item}
        canManage={canManage}
        busy={busy}
        command={command}
        onReimport={onReimport}
      />
      <p className="collection-preview-note">
        {m.sync_detail_source({ connection: connection.label })}
      </p>
    </div>
  );
}

/** A past moment as relative time, with the exact workspace time beside it. */
function Moment({ value, now }: { value: string | null; now: number }) {
  if (!value) return m.sync_summary_not_yet();

  return (
    <span className="sync-detail-moment">
      {ago(value, now)}
      <small>
        <WorkspaceDate value={value} />
      </small>
    </span>
  );
}

/** The one step that moves this sync forward, when it needs a person. */
function PrimaryAction({
  organizationId,
  item,
  canManage,
  busy,
  command,
}: {
  organizationId: string;
  item: SyncItem;
  canManage: boolean;
  busy: boolean;
  command: (stream: SyncStreamView, action: SyncCommand) => void;
}) {
  const { stream, connection } = item;
  if (
    connection.appId &&
    (stream.blocked === 'capability_removed' ||
      stream.blocked === 'connection_inactive')
  )
    return (
      <Link
        className={buttonVariants({ size: 'sm' })}
        to="/app/$organizationId/apps/$appId/settings"
        params={{ organizationId, appId: connection.appId }}
        hash={`connection-${connection.connectionId}`}
      >
        {m.sync_connection_manage()}
      </Link>
    );
  if (!canManage) return null;
  if (stream.blocked === 'principal_unavailable')
    return (
      <Button
        size="sm"
        disabled={busy}
        onClick={() => command(stream, 'resume')}
      >
        <Play aria-hidden="true" /> {m.sync_notice_principal_resume()}
      </Button>
    );
  if (stream.paused)
    return (
      <Button
        size="sm"
        disabled={busy}
        onClick={() => command(stream, 'resume')}
      >
        <Play aria-hidden="true" /> {m.sync_action_resume()}
      </Button>
    );
  if (stream.status === 'failing' || stream.status === 'retrying')
    return (
      <Button
        size="sm"
        variant={stream.status === 'failing' ? 'default' : 'outline'}
        disabled={busy}
        onClick={() => command(stream, 'retry')}
      >
        <RefreshCw aria-hidden="true" /> {m.sync_action_retry_now()}
      </Button>
    );

  return null;
}

/**
 * The history import as steps when the source reads recent history first, else the running
 * read's progress. Nothing once history is imported and no read runs.
 */
function ImportProgress({ item, now }: { item: SyncItem; now: number }) {
  const { stream, type } = item;
  const progress = scanProgress(type, stream);
  const active = ['importing', 'syncing', 'waiting'].includes(stream.status);
  const meter =
    progress && active ? (
      <div className="sync-detail-progress">
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
        <small>
          {progress.text}
          {stream.scan
            ? stream.status === 'waiting'
              ? ` · ${m.sync_detail_read_started({ time: ago(stream.scan.startedAt, now) })}`
              : ` · ${m.sync_detail_running_for({
                  time: runDuration(
                    {
                      startedAt: stream.scan.startedAt,
                      finishedAt: null,
                    },
                    now,
                  ),
                })}`
            : null}
        </small>
      </div>
    ) : null;
  const { recentFrom, recentCompletedAt } = stream.coverage;
  if (stream.phase === 'incremental')
    return meter ? (
      <section aria-labelledby="sync-detail-read">
        <h3 id="sync-detail-read" className="collection-preview-heading">
          {m.sync_detail_current_read()}
        </h3>
        {meter}
      </section>
    ) : null;

  const steps: {
    key: string;
    label: string;
    done: boolean;
    current: boolean;
  }[] = recentFrom
    ? [
        {
          key: 'recent',
          label: m.sync_detail_step_recent({ date: day(recentFrom) }),
          done: !!recentCompletedAt,
          current: !recentCompletedAt,
        },
        {
          key: 'older',
          label: m.sync_detail_step_older(),
          done: false,
          current: !!recentCompletedAt,
        },
      ]
    : [
        {
          key: 'all',
          label: m.sync_detail_step_all(),
          done: false,
          current: true,
        },
      ];

  return (
    <section aria-labelledby="sync-detail-import">
      <h3 id="sync-detail-import" className="collection-preview-heading">
        {m.sync_detail_import()}
      </h3>
      <ol className="sync-detail-steps">
        {steps.map((step) => (
          <li
            key={step.key}
            data-done={step.done || undefined}
            data-current={step.current || undefined}
          >
            {step.done ? (
              <CircleCheck size={16} aria-hidden="true" />
            ) : (
              <StateDot
                state={
                  step.current
                    ? stream.status === 'importing'
                      ? 'running'
                      : streamState(stream).state
                    : 'idle'
                }
              />
            )}
            <div>
              <span>
                {step.label}
                <span className="sr-only">
                  {' '}
                  {step.done
                    ? m.sync_detail_step_done()
                    : step.current
                      ? m.sync_detail_step_current()
                      : m.sync_detail_step_next()}
                </span>
              </span>
              {step.current ? meter : null}
            </div>
          </li>
        ))}
      </ol>
      {['importing', 'syncing'].includes(stream.status) ? (
        <p className="collection-preview-note">{m.sync_detail_import_note()}</p>
      ) : null}
    </section>
  );
}

/**
 * Record counts by state, with what each problem means and a link to the records. Waiting,
 * failed and missing records can be listed beneath their count, one state at a time.
 */
function RecordHealth({
  organizationId,
  item,
  records: listed,
  now,
}: {
  organizationId: string;
  item: SyncItem;
  records: ProblemRecords;
  now: number;
}) {
  const { stream, type } = item;
  const { current, pending, failed, missing, retired } = stream.records;
  const problems: {
    key: SyncRecordState | 'retired';
    label: string;
    detail: ReactNode;
  }[] = [
    pending
      ? {
          key: 'pending' as const,
          label: m.sync_records_pending({ records: records(type, pending) }),
          detail: m.sync_records_pending_detail(),
        }
      : null,
    failed
      ? {
          key: 'failed' as const,
          label: m.sync_records_failed({ records: records(type, failed) }),
          detail: stream.problems.length
            ? m.sync_attention_failed_reasons({
                reasons: stream.problems.join('; '),
              })
            : m.sync_attention_failed_detail(),
        }
      : null,
    missing
      ? {
          key: 'missing' as const,
          label: m.sync_records_missing({ records: records(type, missing) }),
          detail: m.sync_records_missing_detail(),
        }
      : null,
    retired
      ? {
          key: 'retired' as const,
          label: m.sync_records_retired({ records: records(type, retired) }),
          detail: m.sync_records_retired_detail(),
        }
      : null,
  ].filter((problem) => problem !== null);

  return (
    <section aria-labelledby="sync-detail-records">
      <h3 id="sync-detail-records" className="collection-preview-heading">
        {m.sync_detail_records()}
      </h3>
      <div className="sync-detail-records">
        <p className="sync-detail-current">
          <strong>{count(current)}</strong>
          <span>{m.sync_records_current({ count: current })}</span>
        </p>
        <Link
          className="sync-detail-list-link"
          to={recordLists[type]}
          params={{ organizationId }}
        >
          {m.sync_detail_open_list({ type: recordTypes[type].title })}
          <ArrowRight size={14} aria-hidden="true" />
        </Link>
      </div>
      {problems.length ? (
        <ul className="sync-detail-problems">
          {problems.map((problem) => {
            const state = problem.key === 'retired' ? null : problem.key;
            const expanded = !!state && listed.state === state;

            return (
              <li key={problem.key} data-kind={problem.key}>
                <strong>{problem.label}</strong>
                <span>{problem.detail}</span>
                {state ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="sync-records-toggle"
                    aria-expanded={expanded}
                    aria-controls={`sync-records-${state}`}
                    onClick={() =>
                      listed.onStateChange(expanded ? null : state)
                    }
                  >
                    <ChevronDown aria-hidden="true" />
                    {expanded
                      ? m.sync_records_hide()
                      : m.sync_records_show({
                          records: recordTypes[type].noun,
                        })}
                  </Button>
                ) : null}
                {expanded ? (
                  <RecordList
                    id={`sync-records-${state}`}
                    label={problem.label}
                    connectionId={item.connection.connectionId}
                    organizationId={organizationId}
                    records={listed}
                    now={now}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * Lists problem records by source ID with their reason. Records Luma holds link to Records,
 * searched by that source ID within the connection.
 */
function RecordList({
  id,
  label,
  connectionId,
  organizationId,
  records,
  now,
}: {
  id: string;
  label: string;
  connectionId: string;
  organizationId: string;
  records: ProblemRecords;
  now: number;
}) {
  if (records.error)
    return (
      <p id={id} className="collection-preview-note" role="alert">
        {m.sync_records_load_failed()}
      </p>
    );
  if (!records.records)
    return (
      <p id={id} className="collection-preview-note" role="status">
        {m.sync_records_loading()}
      </p>
    );
  if (!records.records.length)
    return (
      <p id={id} className="collection-preview-note">
        {m.sync_records_none()}
      </p>
    );

  return (
    <div id={id} className="sync-record-list">
      <ul aria-label={label}>
        {records.records.map((record) => (
          <li key={`${record.resource}:${record.externalId}`}>
            <span className="sync-record-main">
              <code>{record.externalId}</code>
              {record.problem ? <span>{record.problem}</span> : null}
              <small>
                {record.missingSince
                  ? rich(m.sync_record_missing_since, {
                      date: <WorkspaceDate value={record.missingSince} />,
                    })
                  : m.sync_record_last_read({
                      time: ago(record.lastSeenAt, now),
                    })}
              </small>
            </span>
            {record.entityId && record.externalId.length <= 120 ? (
              <Link
                className="sync-detail-list-link"
                to="/app/$organizationId/records"
                params={{ organizationId }}
                search={{ q: record.externalId, connectionId }}
                aria-label={m.sync_record_open_label({
                  id: record.externalId,
                })}
              >
                {m.sync_record_open()}
                <ArrowRight size={14} aria-hidden="true" />
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
      {records.more ? (
        <Button
          variant="outline"
          size="sm"
          disabled={records.loadingMore}
          onClick={records.loadMore}
        >
          {records.loadingMore
            ? m.sync_records_loading()
            : m.common_show_more()}
        </Button>
      ) : null}
    </div>
  );
}

function Runs({ history, now }: { history: RunHistory; now: number }) {
  return (
    <section aria-labelledby="sync-detail-runs">
      <h3 id="sync-detail-runs" className="collection-preview-heading">
        {m.sync_runs_title()}
      </h3>
      {history.error ? (
        <p className="collection-preview-note" role="alert">
          {m.sync_runs_failed()}
        </p>
      ) : history.loading && !history.runs ? (
        <p className="collection-preview-note" role="status">
          {m.sync_runs_loading()}
        </p>
      ) : history.runs?.length ? (
        <ol className="sync-runs">
          {history.runs.map((run) => (
            <li key={run.id} data-outcome={run.outcome}>
              {run.outcome === 'completed' ? (
                <CircleCheck size={15} aria-hidden="true" />
              ) : (
                <StateDot
                  state={run.outcome === 'running' ? 'running' : 'idle'}
                />
              )}
              <span className="sync-run-main">
                <strong>{runKind(run)}</strong>
                <small>
                  {[
                    triggers[run.trigger](),
                    run.outcome === 'running'
                      ? m.sync_detail_running_for({
                          time: runDuration(run, now),
                        })
                      : run.outcome === 'cancelled'
                        ? m.sync_run_replaced()
                        : runDuration(run, now),
                    run.errors ? m.sync_run_retried({ count: run.errors }) : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
                <span className="sync-run-summary">{runSummary(run)}</span>
              </span>
              <small className="sync-run-time">
                <WorkspaceDate value={run.startedAt} />
              </small>
            </li>
          ))}
        </ol>
      ) : history.runs ? (
        <p className="collection-preview-note">{m.sync_runs_empty()}</p>
      ) : null}
      {history.moreError ? (
        <p className="collection-preview-note" role="alert">
          {m.sync_runs_more_failed()}
        </p>
      ) : null}
      {history.more && history.loadMore ? (
        <Button
          variant="outline"
          size="sm"
          className="sync-runs-more"
          disabled={history.loadingMore}
          onClick={history.loadMore}
        >
          {history.loadingMore ? m.sync_runs_loading() : m.sync_runs_more()}
        </Button>
      ) : null}
    </section>
  );
}

/** Every command for this sync with what it does; read-only members see why they can't. */
function Commands({
  item,
  canManage,
  busy,
  command,
  onReimport,
}: {
  item: SyncItem;
  canManage: boolean;
  busy: boolean;
  command: (stream: SyncStreamView, action: SyncCommand) => void;
  onReimport: () => void;
}) {
  const { stream, type } = item;
  const noun = recordTypes[type].noun;
  if (!canManage)
    return (
      <section aria-labelledby="sync-detail-commands">
        <h3 id="sync-detail-commands" className="collection-preview-heading">
          {m.sync_detail_commands()}
        </h3>
        <p className="collection-preview-note">{m.sync_detail_view_only()}</p>
      </section>
    );
  // A failing or retrying sync offers Retry now as its main step above, and a paused one Resume.
  const primary = stream.status === 'failing' || stream.status === 'retrying';
  const commands: {
    key: string;
    icon: ReactNode;
    label: string;
    detail: string;
    disabled?: boolean;
    hidden?: boolean;
    run: () => void;
  }[] = [
    {
      key: 'retry',
      icon: <RefreshCw aria-hidden="true" />,
      label: stream.error
        ? m.sync_action_retry_now()
        : m.sync_action_sync_now(),
      detail: m.sync_command_retry_detail(),
      disabled: !!stream.blocked,
      hidden: primary,
      run: () => command(stream, 'retry'),
    },
    {
      key: 'reconcile',
      icon: <ScanSearch aria-hidden="true" />,
      label: m.sync_action_check_all(),
      detail:
        stream.phase === 'backfill'
          ? m.sync_command_check_after_import()
          : m.sync_command_check_detail(),
      disabled: stream.phase === 'backfill' || !!stream.blocked,
      run: () => command(stream, 'reconcile'),
    },
    {
      key: 'reimport',
      icon: <History aria-hidden="true" />,
      label: m.sync_action_reimport(),
      detail: m.sync_command_reimport_detail({ records: noun }),
      disabled: !!stream.blocked,
      run: onReimport,
    },
    {
      key: 'pause',
      icon: <Pause aria-hidden="true" />,
      label: m.sync_action_pause(),
      detail: m.sync_command_pause_detail(),
      run: () => command(stream, 'pause'),
    },
  ].filter((entry) => !stream.paused && !entry.hidden);

  return (
    <section aria-labelledby="sync-detail-commands">
      <h3 id="sync-detail-commands" className="collection-preview-heading">
        {m.sync_detail_commands()}
      </h3>
      {stream.paused ? (
        <p className="collection-preview-note">
          {m.sync_detail_paused_commands()}
        </p>
      ) : null}
      <ul className="sync-detail-commands">
        {commands.map((entry) => (
          <li key={entry.key}>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || entry.disabled}
              aria-describedby={`sync-command-${entry.key}`}
              onClick={entry.run}
            >
              {entry.icon} {entry.label}
            </Button>
            <span id={`sync-command-${entry.key}`}>{entry.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
