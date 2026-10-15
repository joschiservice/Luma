import type { ActivityEvent } from './activity.js';

/** Rows one activity export may contain; more matching events cut the file off. */
export const activityExportRowLimit = 5000;

/** The columns an export writes, in order. */
const activityExportColumns = [
  'recordedAt',
  'occurredAt',
  'action',
  'type',
  'outcome',
  'actorKind',
  'actor',
  'actorEmail',
  'workflow',
  'issueClass',
  'resourceKind',
  'resource',
  'summary',
  'system',
  'connections',
  'dispatch',
  'executionState',
  'verificationPhase',
  'verification',
  'failureCode',
  'mode',
  'eventId',
  'issueId',
  'proposalId',
  'attemptId',
  'workflowRunId',
  'evidence',
] as const;

export type ActivityExportColumn = (typeof activityExportColumns)[number];

/** Headings, readable code names and the cut-off line, all in the reader's language. */
export interface ActivityExportLabels {
  headings: Partial<Record<ActivityExportColumn, string>>;
  /** Keyed `column:code`, such as `outcome:verified`. */
  values: Readonly<Record<string, string>>;
  truncated: string;
}

// Columns whose recorded codes the reader's names replace.
const named = new Set<ActivityExportColumn>([
  'action',
  'type',
  'outcome',
  'actorKind',
  'issueClass',
  'resourceKind',
  'system',
  'dispatch',
  'executionState',
  'verificationPhase',
  'verification',
  'failureCode',
  'mode',
]);

function value(event: ActivityEvent, column: ActivityExportColumn) {
  switch (column) {
    case 'actorKind':
      return event.actor.kind;
    case 'actor':
      return event.actor.name;
    case 'actorEmail':
      return event.actor.email;
    case 'workflow':
      return event.actor.workflow?.name ?? event.actor.workflow?.id ?? null;
    case 'eventId':
      return event.id;
    case 'issueId':
      return event.exceptionId;
    case 'mode':
      return event.mode === 'unrecorded' ? null : event.mode;
    case 'connections':
      return event.connections.map((connection) => connection.id).join('; ');
    case 'evidence':
      return event.evidenceRefs.join('; ');
    default:
      return event[column] ?? null;
  }
}

// Spreadsheets run cell text that starts with these characters as a formula.
const formulaStart = /^[=+\-@\t\r]/;

function cell(text: string | null) {
  if (!text) return '';
  const safe = formulaStart.test(text) ? `'${text}` : text;

  return /[",\r\n;]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/**
 * Writes events as CSV, one row per event, with the reader's headings and names for recorded
 * codes; codes without a name, and headings that weren't sent, are written as recorded. Text a
 * spreadsheet would run as a formula is prefixed with an apostrophe. A cut-off file ends with
 * the `truncated` line.
 */
export function activityCsv(
  events: readonly ActivityEvent[],
  labels: ActivityExportLabels,
  truncated: boolean,
) {
  const lines = [
    activityExportColumns
      .map((column) => cell(labels.headings[column] ?? column))
      .join(','),
    ...events.map((event) =>
      activityExportColumns
        .map((column) => {
          const code = value(event, column);

          return cell(
            code && named.has(column)
              ? (labels.values[`${column}:${code}`] ?? code)
              : code,
          );
        })
        .join(','),
    ),
    ...(truncated ? [cell(labels.truncated)] : []),
  ];

  return `${lines.join('\r\n')}\r\n`;
}
