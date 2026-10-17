import { exceptionClassLabel } from '@luma/exceptions';
import { z, type ZodTypeAny } from 'zod';

import { clip, type RecordReference } from '../../domain/answer.js';

/** Turns `awaiting_items` into "Awaiting items". */
export function humanize(value: string) {
  const text = value.replace(/_/g, ' ');

  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "49.90 EUR", or null when the source reports no amount. */
export function money(value: { amount: string; currency: string } | null) {
  return value ? `${value.amount} ${value.currency}` : null;
}

/** The latest of several observation times, or null. */
export function latest(times: (string | null)[]) {
  const known = times.filter((time): time is string => !!time).sort();

  return known.at(-1) ?? null;
}

/** Accepts ISO 8601 with an offset, as models often write local times, and normalizes to UTC. */
export const instant = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

/**
 * Lists every member of a string union. The record must name each member exactly once, so the
 * compiler reports values a read model adds or removes.
 */
export function members<T extends string>(values: Record<T, true>) {
  return Object.keys(values) as [T, ...T[]];
}

/** Wraps a schema as a tool parser that reports field problems instead of throwing. */
export function parser<Schema extends ZodTypeAny>(schema: Schema) {
  return (
    value: unknown,
  ): { input: z.output<Schema> } | { problems: string[] } => {
    const result = schema.safeParse(value);

    return result.success
      ? { input: result.data }
      : {
          problems: result.error.issues
            .slice(0, 5)
            .map(
              (issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`,
            ),
        };
  };
}

/** Formats an ISO time as a date for step summaries. */
function day(value: string | undefined) {
  return value ? value.slice(0, 10) : null;
}

/** "Searched orders · outstanding · “1001”" from the parts that were set. */
export function summary(
  action: string,
  parts: (string | null | false | undefined)[],
) {
  return [action, ...parts.filter((part): part is string => !!part)].join(
    ' · ',
  );
}

/** Joins a from–before range for step summaries. */
export function range(
  label: string,
  from: string | undefined,
  before: string | undefined,
) {
  if (!from && !before) return null;

  return `${label} ${day(from) ?? '…'} to ${day(before) ?? 'now'}`;
}

/** Current (not deleted) sources as citation source labels. */
export const sourcesOf = (
  sources: { label: string; system: string | null; deleted?: boolean }[],
): RecordReference['sources'] =>
  sources
    .filter((source) => !source.deleted)
    .map((source) => ({ label: source.label, system: source.system }));

/** A citable order with the observation time of the read that returned it. */
export function orderReference(order: {
  id: string;
  displayNumber: string | null;
  status: string;
  fulfillment: string;
  sources: {
    label: string;
    system: string | null;
    deleted: boolean;
  }[];
  observedAt: string;
  sourceUpdatedAt: string | null;
}): RecordReference {
  return {
    kind: 'order',
    id: order.id,
    label: order.displayNumber ? `Order ${order.displayNumber}` : 'Order',
    detail: `${humanize(order.status)} · ${humanize(order.fulfillment)}`,
    sources: sourcesOf(order.sources),
    observedAt: order.observedAt,
    sourceUpdatedAt: order.sourceUpdatedAt,
  };
}

/** A citable issue; `observedAt` is its last activity or detection. */
export function issueReference(issue: {
  id: string;
  class: string;
  state: string;
  summary?: string | undefined;
  sources?: string[] | undefined;
  observedAt: string | null;
}): RecordReference {
  return {
    kind: 'issue',
    id: issue.id,
    label: exceptionClassLabel(issue.class),
    detail: issue.summary ? clip(issue.summary, 120) : humanize(issue.state),
    sources: (issue.sources ?? []).map((label) => ({ label, system: null })),
    observedAt: issue.observedAt,
    sourceUpdatedAt: null,
  };
}

/** A citable return or refund with the observation time of the read that returned it. */
export function returnReference(
  item: {
    id: string;
    kind: 'return' | 'refund';
    name: string | null;
    stage: string;
    order: { displayNumber: string | null };
    observedAt: string;
    sourceUpdatedAt: string | null;
  },
  source: { label: string; system: string | null } | undefined,
): RecordReference {
  const name =
    item.name ??
    (item.order.displayNumber ? `for ${item.order.displayNumber}` : null);

  return {
    kind: 'return',
    id: item.id,
    label: [item.kind === 'refund' ? 'Refund' : 'Return', name]
      .filter(Boolean)
      .join(' '),
    detail: humanize(item.stage),
    sources: source ? [{ label: source.label, system: source.system }] : [],
    observedAt: item.observedAt,
    sourceUpdatedAt: item.sourceUpdatedAt,
  };
}
