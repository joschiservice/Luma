import type {
  SyncConnectionView,
  SyncOverview,
  SyncRecordType,
  SyncRunView,
  SyncStreamView,
} from '@luma/api-contract';
import type { OperationalState } from '@luma/ui/components/primitives/state';
import {
  Boxes,
  type LucideIcon,
  Package,
  Receipt,
  Truck,
  Users,
} from 'lucide-react';

export const recordTypes: Record<
  SyncRecordType,
  { title: string; noun: string; one: string; Icon: LucideIcon }
> = {
  orders: { title: 'Orders', noun: 'orders', one: 'order', Icon: Receipt },
  fulfillments: {
    title: 'Fulfillments',
    noun: 'fulfillments',
    one: 'fulfillment',
    Icon: Truck,
  },
  products: {
    title: 'Products',
    noun: 'products',
    one: 'product',
    Icon: Package,
  },
  inventory: {
    title: 'Stock levels',
    noun: 'stock levels',
    one: 'stock level',
    Icon: Boxes,
  },
  customers: {
    title: 'Customers',
    noun: 'customers',
    one: 'customer',
    Icon: Users,
  },
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

const numbers = new Intl.NumberFormat('en-US');

/** Formats a count with grouping, such as 12,480. */
export const count = (value: number) => numbers.format(value);

/** Pluralizes a record noun for a count, such as "1 order" or "3 orders". */
export function records(type: SyncRecordType, value: number) {
  return `${count(value)} ${value === 1 ? recordTypes[type].one : recordTypes[type].noun}`;
}

const days = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

/** Formats a calendar date for coverage statements, such as "Jul 31, 2026". */
export const day = (value: string) => days.format(new Date(value));

/** Describes a past time relative to now, such as "just now" or "12m ago". */
export function ago(value: string, now = Date.now()) {
  const seconds = Math.round((now - Date.parse(value)) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;

  return `${Math.floor(seconds / 86400)}d ago`;
}

/** Describes a future time relative to now, such as "now" or "in 4m". */
export function soon(value: string, now = Date.now()) {
  const seconds = Math.round((Date.parse(value) - now) / 1000);
  if (seconds < 10) return 'now';
  if (seconds < 60) return `in ${seconds}s`;
  if (seconds < 3600) return `in ${Math.ceil(seconds / 60)}m`;
  if (seconds < 86400) return `in ${Math.round(seconds / 3600)}h`;

  return `in ${Math.round(seconds / 86400)}d`;
}

/** The state dot and short label for a sync. */
export function streamState(stream: SyncStreamView): {
  state: OperationalState;
  label: string;
} {
  switch (stream.status) {
    case 'paused':
      return { state: 'idle', label: 'Paused' };
    case 'blocked':
      return {
        state: 'attention',
        label:
          stream.blocked === 'principal_unavailable'
            ? 'Needs someone to resume'
            : stream.blocked === 'capability_removed'
              ? 'Access removed'
              : 'Connection unavailable',
      };
    case 'failing':
      return { state: 'error', label: 'Failing' };
    case 'retrying':
      return { state: 'attention', label: 'Retrying' };
    case 'waiting':
      return { state: 'waiting', label: 'Waiting for orders' };
    case 'importing':
      return { state: 'running', label: 'Importing history' };
    case 'syncing':
      return {
        state: 'running',
        label:
          stream.scan?.kind === 'reconcile' || stream.scan?.since === null
            ? 'Checking all records'
            : 'Reading changes',
      };
    default:
      return { state: 'verified', label: 'Up to date' };
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

  return {
    value: total
      ? Math.min(100, (scan.records / Math.max(total, 1)) * 100)
      : null,
    text: total
      ? `${count(Math.min(scan.records, total))} of ${records(type, total)}`
      : `${records(type, scan.records)} read`,
  };
}

const dated: Partial<Record<SyncRecordType, string>> = {
  orders: 'placed',
  customers: 'created',
};

/**
 * States which records Luma holds for one sync: what the source shares, the creation dates
 * covered and any history limit. It never claims completeness before the first import ends.
 */
export function coverageStatement(
  type: SyncRecordType,
  stream: SyncStreamView,
): { text: string; limited: boolean } {
  const noun = recordTypes[type].noun;
  const verb = dated[type];
  if (stream.phase === 'backfill')
    return {
      text: stream.records.total
        ? `${records(type, stream.records.total)} so far. Coverage is complete when the history import finishes.`
        : 'Nothing imported yet. Coverage is complete when the history import finishes.',
      limited: false,
    };
  const range =
    verb && stream.coverage.oldest && stream.coverage.newest
      ? ` ${verb} ${day(stream.coverage.oldest)} – ${day(stream.coverage.newest)}`
      : '';
  if (stream.coverage.historyFrom)
    return {
      text: `${stream.records.total ? `${records(type, stream.records.total)}${range}` : `No ${noun}`}. The source didn’t share ${noun} ${verb ?? 'created'} before ${day(stream.coverage.historyFrom)}.`,
      limited: true,
    };
  if (!stream.records.total)
    return { text: `The source has no ${noun} to share.`, limited: false };

  return {
    text: `All ${records(type, stream.records.total)} the source shares${range}.`,
    limited: false,
  };
}

/** Explains a record type that has no sync for this connection. */
export function unavailableReason(
  availability: SyncConnectionView['recordTypes'][number]['availability'],
  connection: SyncConnectionView,
) {
  if (connection.status !== 'active')
    return 'Starts when the connection is active';
  if (availability === 'not_requested') return 'Not part of this connection';
  if (availability === 'not_granted') return 'The source did not grant access';

  return 'Starting shortly';
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
      title: 'Nothing to sync yet',
      detail: overview.connections.length
        ? 'Imports start as soon as a connection is active.'
        : 'Connect a store or ERP and Luma imports its history automatically.',
    };
  const needs = streams.filter((stream) =>
    ['failing', 'blocked'].includes(stream.status),
  ).length;
  if (needs)
    return {
      state: 'error',
      title: `${needs === 1 ? '1 sync needs' : `${needs} syncs need`} attention`,
      detail: 'Records that already arrived stay available while Luma waits.',
    };
  const importing = streams.filter((stream) => stream.phase === 'backfill');
  if (importing.length)
    return {
      state: 'running',
      title: 'Importing history',
      detail: `${streams.length - importing.length} of ${streams.length} ${streams.length === 1 ? 'record type' : 'record types'} imported. You can use Luma while this runs.`,
    };
  const retrying = streams.filter((s) => s.status === 'retrying').length;
  if (retrying)
    return {
      state: 'attention',
      title: 'Up to date, with retries',
      detail: `${retrying === 1 ? '1 sync is' : `${retrying} syncs are`} retrying a failed read automatically.`,
    };
  const latest = streams
    .map((stream) => stream.lastSuccessAt)
    .filter((value): value is string => !!value)
    .sort()
    .at(-1);

  return {
    state: 'verified',
    title: 'Up to date',
    detail: latest
      ? `Changes last read ${ago(latest, Date.parse(overview.asOf))}.`
      : 'Every connected record type is imported.',
  };
}

export const scanKinds: Record<SyncRunView['kind'], string> = {
  backfill: 'History import',
  incremental: 'Change sync',
  reconcile: 'Full check',
};

export const triggers: Record<SyncRunView['trigger'], string> = {
  connection: 'Connection',
  operator: 'Requested',
  schedule: 'Scheduled',
  webhook: 'Source notification',
};

/** Summarizes what a run changed, such as "12 updated · 480 unchanged". */
export function runSummary(run: SyncRunView) {
  const parts = [
    run.changed ? `${count(run.changed)} imported or updated` : '',
    run.unchanged ? `${count(run.unchanged)} unchanged` : '',
    run.pending ? `${count(run.pending)} waiting` : '',
    run.failed ? `${count(run.failed)} not imported` : '',
    run.missing ? `${count(run.missing)} no longer found` : '',
  ].filter(Boolean);

  return parts.length
    ? parts.join(' · ')
    : run.outcome === 'running'
      ? 'Reading…'
      : 'No records';
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
    : { state: summary.state, text: `${summary.title}. ${summary.detail}` };
}
