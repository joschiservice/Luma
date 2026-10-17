import type { PurchasingTimelineEntry } from './purchasing-timeline.js';

/** The admitted workflow run behind an automated execution or submission entry. */
export interface TimelineAutomation {
  /** Workflow run id. */
  id: string;
  /** Name of the workflow version that ran, when the version is still recorded. */
  name: string | null;
  /** Principal the run acted as. */
  principalId: string;
}

/** A workspace person, including people whose membership has ended. */
export interface TimelinePerson {
  id: string;
  name: string | null;
  email: string | null;
  member: boolean;
}

/**
 * The execution and submission ids whose admitting workflow run can explain an entry. Execution
 * entries are `execution:<id>`; submission entries are `submission:<id>[:<stage>]`.
 */
export function timelineAutomationSources(entries: PurchasingTimelineEntry[]) {
  return {
    executionIds: entries
      .filter((entry) => entry.id.startsWith('execution:'))
      .map((entry) => entry.id.slice('execution:'.length)),
    submissionIds: entries
      .filter((entry) => entry.id.startsWith('submission:'))
      .map((entry) => entry.id.split(':')[1]!),
  };
}

/** The key an automated run is recorded under for an entry: `execution:<id>` or `submission:<id>`. */
function automationKey(entry: PurchasingTimelineEntry) {
  return entry.id.startsWith('submission:')
    ? entry.id.split(':').slice(0, 2).join(':')
    : entry.id;
}

/** Every person to look up: recorded actors and the principals automated runs acted as. */
export function timelineActorIds(
  entries: PurchasingTimelineEntry[],
  automated: ReadonlyMap<string, TimelineAutomation>,
) {
  return [
    ...new Set([
      ...entries.flatMap((entry) => (entry.actorId ? [entry.actorId] : [])),
      ...[...automated.values()].map((run) => run.principalId),
    ]),
  ];
}

/**
 * Classifies who acted. A current member is `member`; any other recorded id is
 * `former_member`, including people no longer listed; no id is `unrecorded`.
 */
export function timelineActorKind(
  actorId: string | null,
  person: TimelinePerson | undefined,
): 'member' | 'former_member' | 'unrecorded' {
  if (person?.member) return 'member';

  return actorId ? 'former_member' : 'unrecorded';
}

/**
 * Attributes each entry to a person and, where explicit, the workflow that acted. Approval and
 * rejection entries are human decisions and never take the automated run's principal. The
 * order's drafting workflow is named only on its `created` entry.
 */
export function attributeTimelineActors(
  entries: PurchasingTimelineEntry[],
  facts: {
    automated: ReadonlyMap<string, TimelineAutomation>;
    people: ReadonlyMap<string, TimelinePerson>;
    workflow?: { id: string; name: string | null } | undefined;
  },
): PurchasingTimelineEntry[] {
  return entries.map((entry) => {
    const provenance = ['approved', 'rejected'].includes(entry.stage)
      ? undefined
      : facts.automated.get(automationKey(entry));
    const actorId = entry.actorId ?? provenance?.principalId ?? null;
    const person = actorId ? facts.people.get(actorId) : undefined;

    return {
      ...entry,
      actor: {
        kind: timelineActorKind(actorId, person),
        id: actorId,
        name: person?.name ?? null,
        email: person?.email ?? null,
        workflow: provenance
          ? { id: provenance.id, name: provenance.name }
          : entry.detail === 'created' && facts.workflow
            ? facts.workflow
            : null,
      },
    };
  });
}
