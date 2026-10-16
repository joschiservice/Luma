import './sync.css';

import type { SyncOverview, SyncRecordType } from '@luma/api-contract';
import { formatNumber, formatPercent } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import {
  type OperationalState,
  StateDot,
} from '@luma/ui/components/primitives/state';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import { syncOptions } from './data';
import {
  ago,
  day,
  recordTypes,
  scanProgress,
  streamState,
  waitingStatement,
} from './presentation';

export interface CoverageItem {
  id: string;
  /** The sync this source's line describes, which its link opens in Data sync. */
  streamId: string;
  label: string;
  state: OperationalState;
  /** What Luma holds, such as "importing orders (8%)" or "orders since 31 Jul 2026". */
  text: string;
  /** Why the sync is not progressing, such as "Paused" or "Failing". */
  problem: string | null;
  importing: boolean;
  /** Recent history is imported and only older history is still importing. */
  olderOnly: boolean;
  /** Import progress as a percentage, when the source reported a total. */
  progress: number | null;
  historyFrom: string | null;
  lastSuccessAt: string | null;
}

/** Describes what Luma holds for a record type from each connection that syncs it. */
export function coverageItems(
  overview: SyncOverview,
  type: SyncRecordType,
): CoverageItem[] {
  return overview.connections.flatMap((connection) => {
    const stream = connection.recordTypes.find(
      (item) => item.recordType === type,
    )?.stream;
    if (!stream) return [];
    const noun = recordTypes[type].noun;
    const state = streamState(stream);
    const importing = stream.phase === 'backfill';
    const { historyFrom, recentFrom, recentCompletedAt } = stream.coverage;
    const recent =
      importing && recentCompletedAt && recentFrom ? recentFrom : null;
    const progress =
      importing && !recent ? (scanProgress(type, stream)?.value ?? null) : null;
    const since = recent
      ? {
          records: noun,
          date: day(historyFrom && historyFrom > recent ? historyFrom : recent),
        }
      : null;
    const text = since
      ? stream.records.failed || stream.records.pending
        ? m.sync_coverage_item_recent_read(since)
        : m.sync_coverage_item_recent_imported(since)
      : importing
        ? progress != null
          ? m.sync_coverage_item_importing_progress({
              records: noun,
              progress: formatPercent(Math.floor(progress) / 100),
            })
          : m.sync_coverage_item_importing({ records: noun })
        : stream.coverage.historyFrom
          ? m.sync_coverage_item_since({
              records: noun,
              date: day(stream.coverage.historyFrom),
            })
          : m.sync_coverage_item_all({ records: noun });

    return [
      {
        id: connection.connectionId,
        streamId: stream.id,
        label: connection.label,
        state: state.state,
        text,
        problem:
          stream.status === 'waiting'
            ? waitingStatement(stream)
            : stream.error || stream.blocked || stream.paused
              ? state.label
              : null,
        importing,
        olderOnly: !!recent,
        progress,
        historyFrom: stream.coverage.historyFrom,
        lastSuccessAt: stream.lastSuccessAt,
      },
    ];
  });
}

const severity: Record<OperationalState, number> = {
  error: 6,
  attention: 5,
  approval: 4,
  idle: 3,
  running: 2,
  waiting: 1,
  verified: 0,
};

/**
 * Condenses per-source coverage into one line, leading with sources that need attention, then
 * unfinished imports and history limits, and ending with the stalest successful sync. It never
 * calls a list complete while any import is running.
 */
export function coverageSummary(
  items: readonly CoverageItem[],
  now = Date.now(),
): { state: OperationalState; text: string } {
  const total = items.length;
  const problems = items.filter(
    (item) => item.problem && item.state !== 'waiting',
  );
  const waiting = items.filter((item) => item.state === 'waiting');
  const importing = items.filter((item) => item.importing);
  const limited = items.filter((item) => item.historyFrom);
  const parts: string[] = [];

  if (problems.length === 1)
    parts.push(
      m.sync_coverage_source_problem({
        source: problems[0]!.label,
        problem: problems[0]!.problem!,
      }),
    );
  else if (problems.length)
    parts.push(
      m.sync_coverage_sources_attention({ count: problems.length, total }),
    );

  if (waiting.length === 1)
    parts.push(
      m.sync_coverage_source_problem({
        source: waiting[0]!.label,
        problem: waiting[0]!.problem ?? m.sync_state_waiting(),
      }),
    );
  else if (waiting.length)
    parts.push(
      m.sync_coverage_sources_waiting({ count: waiting.length, total }),
    );

  const older = importing.filter((item) => item.olderOnly);
  const full = importing.filter((item) => !item.olderOnly);

  if (full.length) {
    const values = full.flatMap((item) =>
      item.progress == null ? [] : [Math.floor(item.progress)],
    );
    const low = Math.min(...values);
    const high = Math.max(...values);
    const progress = values.length
      ? low === high
        ? formatPercent(low / 100)
        : m.sync_coverage_percent_range({
            low: formatNumber(low),
            high: formatPercent(high / 100),
          })
      : null;
    const count = full.length;
    parts.push(
      count < total
        ? progress
          ? m.sync_coverage_importing_some_progress({ count, total, progress })
          : m.sync_coverage_importing_some({ count, total })
        : total > 1
          ? progress
            ? m.sync_coverage_importing_all_progress({ total, progress })
            : m.sync_coverage_importing_all({ total })
          : progress
            ? m.sync_coverage_importing_one_progress({ progress })
            : m.sync_coverage_importing_one(),
    );
  }
  if (older.length)
    parts.push(
      older.length < total
        ? m.sync_coverage_older_some({ count: older.length, total })
        : total > 1
          ? m.sync_coverage_older_all({ total })
          : m.sync_coverage_older_one(),
    );
  if (importing.length) parts.push(m.sync_coverage_incomplete());
  else if (!problems.length)
    parts.push(
      total === 1
        ? m.sync_coverage_imported_one()
        : m.sync_coverage_imported_all({ total }),
    );

  if (!importing.length && limited.length) {
    const dates = new Set(limited.map((item) => item.historyFrom));
    parts.push(
      limited.length === total && dates.size === 1
        ? m.sync_coverage_history_since({
            date: day(limited[0]!.historyFrom!),
          })
        : m.sync_coverage_history_limited({ count: limited.length }),
    );
  }

  const synced = items
    .flatMap((item) => (item.lastSuccessAt ? [item.lastSuccessAt] : []))
    .sort()[0];
  if (synced) parts.push(m.sync_coverage_synced({ time: ago(synced, now) }));

  const text = parts.join(' · ');
  const state = items.reduce<OperationalState>(
    (worst, item) =>
      severity[item.state] > severity[worst] ? item.state : worst,
    'verified',
  );

  return { state, text: text.charAt(0).toUpperCase() + text.slice(1) };
}

/**
 * States which sources a record list covers in one line, with per-source detail behind a
 * disclosure. Each source opens its sync in Data sync; a final link opens the whole page.
 * Renders nothing until a sync exists for the record type.
 */
export function SyncCoverage({
  organizationId,
  type,
}: {
  organizationId: string;
  type: SyncRecordType;
}) {
  const overview = useQuery(syncOptions(organizationId));
  const items = overview.data ? coverageItems(overview.data, type) : [];
  if (!items.length) return null;
  const now = Date.parse(overview.data!.asOf);
  const summary = coverageSummary(items, now);

  return (
    <Disclosure variant="plain" className="sync-coverage">
      <summary>
        <StateDot state={summary.state} />
        <span className="sync-coverage-label">{m.sync_coverage_label()}</span>
        <span className="sync-coverage-summary">{summary.text}</span>
      </summary>
      <ul className="sync-coverage-items">
        {items.map((item) => (
          <li key={item.id}>
            <StateDot state={item.state} />
            <span>
              <Link
                to="/app/$organizationId/sync"
                params={{ organizationId }}
                search={{ stream: item.streamId }}
                aria-label={m.sync_coverage_open_source({
                  records: recordTypes[type].noun,
                  connection: item.label,
                })}
              >
                <strong>{item.label}</strong>
              </Link>{' '}
              {[
                item.problem,
                item.text,
                item.lastSuccessAt
                  ? m.sync_coverage_synced({
                      time: ago(item.lastSuccessAt, now),
                    })
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </li>
        ))}
      </ul>
      <Link to="/app/$organizationId/sync" params={{ organizationId }}>
        {m.sync_coverage_open()}
      </Link>
    </Disclosure>
  );
}
