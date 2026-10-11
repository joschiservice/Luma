import type { ActivityOutcome } from './activity.js';

export type ActivityOutcomeField =
  'verification' | 'resolution' | 'state' | 'outcome' | 'action' | 'dispatch';

// First match wins. A pending effect remains uncertain even after a negative read.
// The read adapter compiles these rules into SQL so filtering and display agree.
export const activityOutcomeRules: readonly {
  field: ActivityOutcomeField;
  values: readonly string[];
  outcome: ActivityOutcome;
}[] = [
  { field: 'action', values: ['execution.prepared'], outcome: 'attempted' },
  { field: 'state', values: ['unknown', 'prepared'], outcome: 'uncertain' },
  { field: 'verification', values: ['passed'], outcome: 'verified' },
  { field: 'resolution', values: ['verification'], outcome: 'verified' },
  {
    field: 'resolution',
    values: ['human_disposition'],
    outcome: 'manually_disposed',
  },
  { field: 'verification', values: ['failed'], outcome: 'failed' },
  { field: 'state', values: ['failed'], outcome: 'failed' },
  { field: 'outcome', values: ['approved', 'approve'], outcome: 'approved' },
  { field: 'outcome', values: ['rejected', 'reject'], outcome: 'rejected' },
  { field: 'outcome', values: ['escalate'], outcome: 'escalated' },
  { field: 'outcome', values: ['close'], outcome: 'manually_disposed' },
  {
    field: 'action',
    values: ['exception.escalated', 'case.escalated'],
    outcome: 'escalated',
  },
  { field: 'verification', values: ['inconclusive'], outcome: 'uncertain' },
  {
    field: 'dispatch',
    values: ['accepted', 'dispatched'],
    outcome: 'provider_accepted',
  },
];

/** Classifies recorded evidence without treating approval or dispatch as verified resolution. */
export function activityOutcome(
  fields: Partial<Record<ActivityOutcomeField, string>>,
): ActivityOutcome {
  return (
    activityOutcomeRules.find((rule) =>
      rule.values.includes(fields[rule.field] ?? ''),
    )?.outcome ?? 'recorded'
  );
}
