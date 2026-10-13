import type { RunDetail, RunSummary } from '@luma/simulator-contract';

const counts = new Intl.NumberFormat('en');

/** Formats a count with grouping, such as "12,000". */
export const formatCount = (value: number) => counts.format(value);

/** Formats a share from 0 to 1 as a percentage with up to `digits` decimals. */
export function formatPercent(rate: number, digits = 1) {
  return `${new Intl.NumberFormat('en', {
    maximumFractionDigits: digits,
  }).format(rate * 100)}%`;
}

/** Converts a share from 0 to 1 to an editable percentage without float noise. */
export const toPercent = (rate: number) => Number((rate * 100).toFixed(4));

/** Converts an edited percentage back to a share from 0 to 1. */
export const fromPercent = (percent: number) =>
  Number((percent / 100).toFixed(6));

const units = [
  { ms: 86_400_000, label: 'd' },
  { ms: 3_600_000, label: 'h' },
  { ms: 60_000, label: 'min' },
  { ms: 1_000, label: 's' },
] as const;

/** Formats a duration with its two largest units, such as "1 h 5 min" or "45 s". */
export function formatDuration(ms: number) {
  const absolute = Math.abs(ms);
  if (absolute < 1_000) return `${Math.round(absolute)} ms`;
  const parts: string[] = [];
  let rest = absolute;
  for (const unit of units) {
    const amount = Math.floor(rest / unit.ms);
    rest -= amount * unit.ms;
    if (amount > 0) parts.push(`${amount} ${unit.label}`);
    else if (parts.length > 0) break;
    if (parts.length === 2) break;
  }

  return parts.join(' ');
}

/** Formats a latency in milliseconds, switching to seconds above one second. */
export function formatLatency(ms: number) {
  return ms < 1_000
    ? `${Math.round(ms)} ms`
    : `${new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(ms / 1_000)} s`;
}

/** Offsets within this tolerance count as keeping real time. */
const realTimeTolerance = 2_000;

/** Describes how far simulation time is from real time. */
export function describeOffset(offsetMs: number) {
  if (Math.abs(offsetMs) <= realTimeTolerance)
    return { state: 'real-time', text: 'Real time' } as const;

  return offsetMs > 0
    ? ({
        state: 'ahead',
        text: `Ahead of real time by ${formatDuration(offsetMs)}`,
      } as const)
    : ({
        state: 'behind',
        text: `Behind real time by ${formatDuration(offsetMs)}`,
      } as const);
}

/** Names a clock speed: 1× keeps real time, faster speeds fast-forward. */
export function speedLabel(speed: number) {
  if (speed === 1) return 'Real time';

  return speed > 1 ? `Fast-forward ${speed}×` : `Slow motion ${speed}×`;
}

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
});
const time = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' });
const shortTime = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
});
const dayTime = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/** Formats a simulation instant in the browser's time zone, with seconds. */
export const formatDateTime = (epochMs: number) => dateTime.format(epochMs);

/** Formats the time of day with seconds. */
export const formatTime = (epochMs: number) => time.format(epochMs);

/** Formats a bucket start for chart axes; spans over a day include the weekday. */
export const formatBucket = (epochMs: number, spanMs: number) =>
  spanMs > 86_400_000 ? dayTime.format(epochMs) : shortTime.format(epochMs);

/** Converts epoch milliseconds to a `datetime-local` input value in the browser's zone. */
export function toLocalInput(epochMs: number) {
  const date = new Date(epochMs);
  const pad = (value: number) => String(value).padStart(2, '0');

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Parses a `datetime-local` input value in the browser's zone; null when incomplete. */
export function fromLocalInput(value: string) {
  const parsed = new Date(value).getTime();

  return Number.isNaN(parsed) ? null : parsed;
}

/** Describes provisioning progress, such as "Generating catalog: 12,000 / 40,000". */
export function progressText(progress: RunSummary['progress']) {
  if (!progress) return 'Preparing the run';
  const step = progress.step.charAt(0).toUpperCase() + progress.step.slice(1);

  return progress.total > 0
    ? `${step}: ${formatCount(progress.done)} / ${formatCount(progress.total)}`
    : step;
}

/** Names a run's lifecycle state in words. */
export function runStatusText(run: Pick<RunSummary, 'status' | 'progress'>) {
  if (run.status === 'ready') return 'Ready';
  if (run.status === 'failed') return 'Failed';

  return run.progress && run.progress.total > 0
    ? `Provisioning ${formatCount(run.progress.done)} / ${formatCount(run.progress.total)}`
    : 'Provisioning';
}

/** Names the unit of an incident rate. */
export const incidentUnitLabel = (unit: 'order' | 'day') =>
  unit === 'order' ? 'per 1,000 orders' : 'per day';

/** Labels a provider kind. */
export const providerLabel = (kind: RunDetail['instances'][number]['kind']) =>
  ({
    shopify: 'Shopify',
    cin7: 'Cin7',
    jtl: 'JTL',
    gmail: 'Gmail',
    starshipit: 'Starshipit',
  })[kind];

/** Pretty-prints JSON, falling back to the string form of values JSON cannot represent. */
export function formatJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Shortens one-line JSON for list rows. */
export function summarizeJson(value: unknown, max = 160) {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }

  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
