import './sync.css';

import type { SyncOverview, SyncRecordType } from '@luma/api-contract';
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
} from './presentation';

export interface CoverageItem {
  id: string;
  label: string;
  state: OperationalState;
  /** What Luma holds, such as "importing orders (8%)" or "orders since Jul 31, 2026". */
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
    const text = recent
      ? `${noun} since ${day(historyFrom && historyFrom > recent ? historyFrom : recent)} ${stream.records.failed || stream.records.pending ? 'read' : 'imported'} · older history incomplete`
      : importing
        ? `importing ${noun}${progress != null ? ` (${Math.floor(progress)}%)` : ''}`
        : stream.coverage.historyFrom
          ? `${noun} since ${day(stream.coverage.historyFrom)}`
          : `all ${noun}`;

    return [
      {
        id: connection.connectionId,
        label: connection.label,
        state: state.state,
        text,
        problem:
          stream.error || stream.blocked || stream.paused ? state.label : null,
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

const sources = (count: number) => (count === 1 ? 'source' : 'sources');

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
  const problems = items.filter((item) => item.problem);
  const importing = items.filter((item) => item.importing);
  const limited = items.filter((item) => item.historyFrom);
  const parts: string[] = [];

  if (problems.length === 1)
    parts.push(`${problems[0]!.label}: ${problems[0]!.problem!.toLowerCase()}`);
  else if (problems.length)
    parts.push(`${problems.length} of ${total} sources need attention`);

  const who = (count: number) =>
    count === total
      ? total === 1
        ? 'the source'
        : `all ${total} sources`
      : `${count} of ${total} sources`;
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
        ? ` (${low}%)`
        : ` (${low}–${high}%)`
      : '';
    parts.push(`importing from ${who(full.length)}${progress}`);
  }
  if (older.length)
    parts.push(`older history importing from ${who(older.length)}`);
  if (importing.length) parts.push('list is incomplete');
  else if (!problems.length)
    parts.push(
      total === 1 ? '1 source imported' : `all ${total} sources imported`,
    );

  if (!importing.length && limited.length) {
    const dates = new Set(limited.map((item) => item.historyFrom));
    parts.push(
      limited.length === total && dates.size === 1
        ? `history since ${day(limited[0]!.historyFrom!)}`
        : `history limited on ${limited.length} ${sources(limited.length)}`,
    );
  }

  const synced = items
    .flatMap((item) => (item.lastSuccessAt ? [item.lastSuccessAt] : []))
    .sort()[0];
  if (synced) parts.push(`synced ${ago(synced, now)}`);

  const text = parts.join(' · ');
  const state = items.reduce<OperationalState>(
    (worst, item) =>
      severity[item.state] > severity[worst] ? item.state : worst,
    'verified',
  );

  return { state, text: text.charAt(0).toUpperCase() + text.slice(1) };
}

/**
 * States which sources a record list covers in one line, with per-source detail and a link to
 * Data sync behind a disclosure. Renders nothing until a sync exists for the record type.
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
        <span className="sync-coverage-label">Coverage</span>
        <span className="sync-coverage-summary">{summary.text}</span>
      </summary>
      <ul className="sync-coverage-items">
        {items.map((item) => (
          <li key={item.id}>
            <StateDot state={item.state} />
            <span>
              <strong>{item.label}</strong>{' '}
              {item.problem ? `${item.problem} · ` : ''}
              {item.text}
              {item.lastSuccessAt
                ? ` · synced ${ago(item.lastSuccessAt, now)}`
                : ''}
            </span>
          </li>
        ))}
      </ul>
      <Link to="/app/$organizationId/sync" params={{ organizationId }}>
        Open Data sync
      </Link>
    </Disclosure>
  );
}
