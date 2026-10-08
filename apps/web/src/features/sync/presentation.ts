import type {
  SyncConnectionView,
  SyncOverview,
  SyncRecordType,
  SyncRunView,
  SyncStreamView,
} from '@luma/api-contract';
import {
  formatDate,
  formatNumber,
  formatRelativeTime,
} from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import type { OperationalState } from '@luma/ui/components/primitives/state';
import {
  Boxes,
  type LucideIcon,
  Package,
  Receipt,
  Truck,
  Undo2,
  Users,
} from 'lucide-react';

type Message = () => string;

type CountMessage = (inputs: { count: number }) => string;

const recordType = (
  title: Message,
  noun: Message,
  one: Message,
  counted: CountMessage,
  Icon: LucideIcon,
) => ({
  /** The record type as a heading, such as "Orders". */
  get title() {
    return title();
  },
  /** The plural noun for use inside a sentence, such as "orders". */
  get noun() {
    return noun();
  },
  /** The singular noun, such as "order". */
  get one() {
    return one();
  },
  counted,
  Icon,
});

/** Display names, nouns and icons of each record type Luma syncs, in the active language. */
export const recordTypes: Record<
  SyncRecordType,
  {
    readonly title: string;
    readonly noun: string;
    readonly one: string;
    counted: CountMessage;
    Icon: LucideIcon;
  }
> = {
  orders: recordType(
    m.sync_type_orders_title,
    m.sync_type_orders_noun,
    m.sync_type_orders_one,
    m.sync_type_orders_count,
    Receipt,
  ),
  fulfillments: recordType(
    m.sync_type_fulfillments_title,
    m.sync_type_fulfillments_noun,
    m.sync_type_fulfillments_one,
    m.sync_type_fulfillments_count,
    Truck,
  ),
  products: recordType(
    m.sync_type_products_title,
    m.sync_type_products_noun,
    m.sync_type_products_one,
    m.sync_type_products_count,
    Package,
  ),
  inventory: recordType(
    m.sync_type_inventory_title,
    m.sync_type_inventory_noun,
    m.sync_type_inventory_one,
    m.sync_type_inventory_count,
    Boxes,
  ),
  customers: recordType(
    m.sync_type_customers_title,
    m.sync_type_customers_noun,
    m.sync_type_customers_one,
    m.sync_type_customers_count,
    Users,
  ),
  returns: recordType(
    m.sync_type_returns_title,
    m.sync_type_returns_noun,
    m.sync_type_returns_one,
    m.sync_type_returns_count,
    Undo2,
  ),
};

const providers: Record<string, string> = { shopify: 'Shopify', jtl: 'JTL' };

/** The display name of a provider ID, such as Shopify. */
export const providerName = (provider: string) =>
  providers[provider] ?? provider;

/** Shortens a provider global ID such as gid://shopify/InventoryItem/4410 to 4410. */
export const sourceId = (externalId: string) =>
  externalId.startsWith('gid://')
    ? (externalId.split('/').at(-1) ?? externalId)
    : externalId;

/** Formats a count with the active language's grouping, such as 12,480. */
export const count = (value: number) => formatNumber(value);

/** Counts records of one type with the right plural, such as "1 order" or "3 orders". */
export function records(type: SyncRecordType, value: number) {
  return recordTypes[type].counted({ count: value });
}

/** Formats a calendar date for coverage statements, such as "31 Jul 2026". */
export const day = (value: string) =>
  formatDate(value, { dateStyle: 'medium', timeZone: 'UTC' });

/** Describes a past time relative to now, such as "just now" or "12 minutes ago". */
export function ago(value: string, now = Date.now()) {
  if (now - Date.parse(value) < 10_000) return m.sync_time_just_now();

  return formatRelativeTime(value, now);
}

/** Describes a future time relative to now, such as "now" or "in 4 minutes". */
export function soon(value: string, now = Date.now()) {
  if (Date.parse(value) - now < 10_000) return m.sync_time_now();

  return formatRelativeTime(value, now);
}

/** The state dot and short label for a sync. */
export function streamState(stream: SyncStreamView): {
  state: OperationalState;
  label: string;
} {
  switch (stream.status) {
    case 'paused':
      return { state: 'idle', label: m.sync_state_paused() };
    case 'blocked':
      return {
        state: 'attention',
        label:
          stream.blocked === 'principal_unavailable'
            ? m.sync_state_needs_resume()
            : stream.blocked === 'capability_removed'
              ? m.sync_state_access_removed()
              : m.sync_state_connection_unavailable(),
      };
    case 'failing':
      return { state: 'error', label: m.sync_state_failing() };
    case 'retrying':
      return { state: 'attention', label: m.sync_state_retrying() };
    case 'waiting':
      return { state: 'waiting', label: m.sync_state_waiting_for_orders() };
    case 'importing':
      return {
        state: 'running',
        label: stream.scan?.waitingForExport
          ? m.sync_state_preparing_history()
          : stream.scan?.createdSince
            ? m.sync_state_importing_recent()
            : stream.coverage.recentCompletedAt && stream.coverage.recentFrom
              ? m.sync_state_importing_older()
              : m.sync_state_importing(),
      };
    case 'syncing':
      return {
        state: 'running',
        label:
          stream.scan?.kind === 'reconcile' || stream.scan?.since === null
            ? m.sync_state_checking_all()
            : m.sync_state_reading_changes(),
      };
    default:
      return { state: 'verified', label: m.sync_state_up_to_date() };
  }
}

/**
 * Progress of the scan in progress. The value is a percentage when the source reported a
 * total, or null when it did not.
 */
export function scanProgress(type: SyncRecordType, stream: SyncStreamView) {
  const scan = stream.scan;
  if (!scan) return null;
  const total = scan.total;
  if (scan.waitingForExport)
    return { value: null, text: m.sync_progress_preparing_export() };

  return {
    value: total
      ? Math.min(100, (scan.records / Math.max(total, 1)) * 100)
      : null,
    text: total
      ? m.sync_progress_of_total({
          done: count(Math.min(scan.records, total)),
          total: records(type, total),
        })
      : m.sync_progress_read({ records: records(type, scan.records) }),
  };
}

/** Sentences describing the dated range of records Luma holds, for types that have one. */
const ranges: Partial<
  Record<
    SyncRecordType,
    {
      held: (inputs: { records: string; from: string; to: string }) => string;
      all: (inputs: { records: string; from: string; to: string }) => string;
      limit: (inputs: { records: string; date: string }) => string;
    }
  >
> = {
  orders: {
    held: m.sync_coverage_range_placed,
    all: m.sync_coverage_all_range_placed,
    limit: m.sync_coverage_limit_placed,
  },
  customers: {
    held: m.sync_coverage_range_created,
    all: m.sync_coverage_all_range_created,
    limit: m.sync_coverage_limit_created,
  },
};

/**
 * States which records Luma holds for one sync: what the source shares, the creation dates
 * covered and any history limit. It never claims completeness before the first import ends.
 */
export function coverageStatement(
  type: SyncRecordType,
  stream: SyncStreamView,
): { text: string; limited: boolean } {
  const info = recordTypes[type];
  const noun = info.noun;
  const range = ranges[type];
  if (
    stream.phase === 'backfill' &&
    stream.coverage.recentCompletedAt &&
    stream.coverage.recentFrom
  ) {
    const from =
      stream.coverage.historyFrom &&
      stream.coverage.historyFrom > stream.coverage.recentFrom
        ? stream.coverage.historyFrom
        : stream.coverage.recentFrom;
    const recent = { records: info.title, date: day(from) };
    const imported =
      stream.records.failed || stream.records.pending
        ? m.sync_coverage_recent_read(recent)
        : m.sync_coverage_recent_imported(recent);
    const older = stream.paused
      ? m.sync_coverage_older_paused()
      : stream.error || stream.blocked
        ? m.sync_coverage_older_incomplete()
        : m.sync_coverage_older_continuing();

    return {
      text: m.sync_coverage_two_sentences({ first: imported, second: older }),
      limited: !!stream.coverage.historyFrom,
    };
  }
  if (stream.phase === 'backfill')
    return {
      text: stream.records.total
        ? m.sync_coverage_so_far({
            records: records(type, stream.records.total),
          })
        : m.sync_coverage_nothing_yet(),
      limited: false,
    };
  const dated =
    range && stream.coverage.oldest && stream.coverage.newest
      ? {
          from: day(stream.coverage.oldest),
          to: day(stream.coverage.newest),
        }
      : null;
  const total = stream.records.total;
  if (stream.coverage.historyFrom) {
    const held = !total
      ? m.sync_coverage_none_held({ records: noun })
      : dated && range
        ? range.held({ records: records(type, total), ...dated })
        : m.sync_coverage_held({ records: records(type, total) });
    const date = day(stream.coverage.historyFrom);
    const limit = range
      ? range.limit({ records: noun, date })
      : m.sync_coverage_limit_created_generic({ records: noun, date });

    return {
      text: m.sync_coverage_two_sentences({ first: held, second: limit }),
      limited: true,
    };
  }
  if (!total)
    return {
      text: m.sync_coverage_source_has_none({ records: noun }),
      limited: false,
    };

  return {
    text:
      dated && range
        ? range.all({ records: records(type, total), ...dated })
        : m.sync_coverage_all({ records: records(type, total) }),
    limited: false,
  };
}

/** Explains a record type that has no sync for this connection. */
export function unavailableReason(
  availability: SyncConnectionView['recordTypes'][number]['availability'],
  connection: SyncConnectionView,
) {
  if (connection.status !== 'active')
    return m.sync_unavailable_connection_inactive();
  if (availability === 'not_requested')
    return m.sync_unavailable_not_requested();
  if (availability === 'not_granted') return m.sync_unavailable_not_granted();

  return m.sync_unavailable_starting();
}

/** One sentence summarizing every sync in the workspace, with its operational state. */
export function overallState(overview: SyncOverview): {
  state: OperationalState;
  title: string;
  detail: string;
} {
  const streams = overview.connections.flatMap((connection) =>
    connection.recordTypes.flatMap(({ stream }) => (stream ? [stream] : [])),
  );
  if (!overview.connections.length || !streams.length)
    return {
      state: 'idle',
      title: m.sync_overall_nothing_title(),
      detail: overview.connections.length
        ? m.sync_overall_nothing_waiting()
        : m.sync_overall_nothing_connect(),
    };
  const needs = streams.filter((stream) =>
    ['failing', 'blocked'].includes(stream.status),
  ).length;
  if (needs)
    return {
      state: 'error',
      title: m.sync_overall_attention_title({ count: needs }),
      detail: m.sync_overall_attention_detail(),
    };
  const importing = streams.filter((stream) => stream.phase === 'backfill');
  if (importing.length && importing.every((stream) => stream.paused))
    return {
      state: 'idle',
      title: m.sync_overall_paused_title(),
      detail: m.sync_overall_paused_detail(),
    };
  if (importing.length)
    return {
      state: 'running',
      title: m.sync_overall_importing_title(),
      detail: importing.some(
        (stream) =>
          stream.coverage.recentCompletedAt && stream.coverage.recentFrom,
      )
        ? m.sync_overall_importing_recent_detail()
        : m.sync_overall_importing_detail({
            done: streams.length - importing.length,
            total: streams.length,
          }),
    };
  const retrying = streams.filter((s) => s.status === 'retrying').length;
  if (retrying)
    return {
      state: 'attention',
      title: m.sync_overall_retrying_title(),
      detail: m.sync_overall_retrying_detail({ count: retrying }),
    };
  const latest = streams
    .map((stream) => stream.lastSuccessAt)
    .filter((value): value is string => !!value)
    .sort()
    .at(-1);

  return {
    state: 'verified',
    title: m.sync_overall_current_title(),
    detail: latest
      ? m.sync_overall_current_detail({
          time: ago(latest, Date.parse(overview.asOf)),
        })
      : m.sync_overall_current_all(),
  };
}

/** Names of each kind of sync run, called during render. */
export const scanKinds: Record<SyncRunView['kind'], Message> = {
  backfill: m.sync_run_kind_backfill,
  incremental: m.sync_run_kind_incremental,
  reconcile: m.sync_run_kind_reconcile,
};

/** Names of what started a sync run, called during render. */
export const triggers: Record<SyncRunView['trigger'], Message> = {
  connection: m.sync_run_trigger_connection,
  operator: m.sync_run_trigger_operator,
  schedule: m.sync_run_trigger_schedule,
  webhook: m.sync_run_trigger_webhook,
};

/** Summarizes what a run changed, such as "12 imported or updated · 480 unchanged". */
export function runSummary(run: SyncRunView) {
  const parts = [
    run.changed ? m.sync_run_changed({ count: run.changed }) : '',
    run.unchanged ? m.sync_run_unchanged({ count: run.unchanged }) : '',
    run.pending ? m.sync_run_pending({ count: run.pending }) : '',
    run.failed ? m.sync_run_failed({ count: run.failed }) : '',
    run.missing ? m.sync_run_missing({ count: run.missing }) : '',
  ].filter(Boolean);

  return parts.length
    ? parts.join(' · ')
    : run.outcome === 'running'
      ? m.sync_run_reading()
      : m.sync_run_no_records();
}

/** A one-line sync summary for one connection, or null before any sync exists. */
export function connectionSummary(
  connection: SyncConnectionView,
  asOf: string,
): { state: OperationalState; text: string } | null {
  const summary = overallState({
    connections: [connection],
    runs: [],
    canManage: false,
    asOf,
  });

  return summary.state === 'idle'
    ? null
    : {
        state: summary.state,
        text: m.sync_connection_summary({
          title: summary.title,
          detail: summary.detail,
        }),
      };
}
