import type {
  OperationalMetricDefinition,
  OperationalMetricRead,
} from '@luma/platform';

export type MeasurementEnvironment =
  'live' | 'pilot' | 'synthetic' | 'shadow' | 'unknown';

export type MeasurementFact =
  | {
      kind: 'environment';
      environment: MeasurementEnvironment;
      evidenceRefs: string[];
    }
  | {
      kind: 'eligibility';
      status: 'eligible' | 'ineligible' | 'unknown';
      ruleVersion: string;
      reasonCode: string;
      evidenceRefs: string[];
    }
  | {
      kind: 'attribution';
      involvement:
        | 'none'
        | 'approval'
        | 'manual_repair'
        | 'operator_correction'
        | 'unknown';
      complete: boolean;
      from: string;
      through: string;
      evidenceRefs: string[];
    }
  | {
      kind: 'incorrect_action';
      proposalId: string;
      reasonCode: string;
      evidenceRefs: string[];
    }
  | {
      kind: 'baseline';
      partnerReference: string;
      processVersion: string;
      sampleSize: number;
      measuredSeconds: number;
      from: string;
      through: string;
      evidenceRefs: string[];
    };

export interface MeasurementEvent {
  id: string;
  incidentId: string;
  revision: number;
  schemaVersion: 1;
  actorId: string;
  recordedAt: string;
  fact: MeasurementFact;
}

export interface MeasurementSource {
  id: string;
  title: string;
  state: string;
  detectedAt: string;
  previousIncidentId: string | null;
  resolution: {
    kind: string;
    at: string;
    outcome?: string;
    authoritative?: boolean;
    complete?: boolean;
    evidenceRefs: string[];
  } | null;
  events: MeasurementEvent[];
  humanEvidence: string[];
  synthetic: boolean;
}

export interface ResolutionMetricItem {
  kind: 'resolution';
  id: string;
  title: string;
  state: string;
  environment: MeasurementEnvironment;
  detectedAt: string;
  verifiedAt: string | null;
  eligibility: 'eligible' | 'ineligible' | 'unknown';
  involvement: 'none' | 'human' | 'unknown';
  outcome: 'verified' | 'pending' | 'human_disposition';
  timeToOutcomeSeconds: number | null;
  unresolvedAgeSeconds: number | null;
  previousIncidentId: string | null;
  incorrectActionIds: string[];
  evidenceRefs: string[];
  factIds: string[];
  revision: number;
}

export interface MeasurementScope {
  environment?: MeasurementEnvironment | undefined;
  window?: '24h' | '7d' | undefined;
}

const metricSpecs: readonly (readonly [
  string,
  string,
  string,
  'case' | 'second',
])[] = [
  [
    'unknown_eligibility',
    'Unknown eligibility',
    'Issues without a retained known eligibility assessment.',
    'case',
  ],
  [
    'eligible',
    'Eligible issues',
    'Issues explicitly assessed as eligible under a retained rule version.',
    'case',
  ],
  [
    'verified',
    'Verified outcomes',
    'Current authoritative, complete independent verification. Repeated problems create new linked incidents; earlier verified outcomes remain evidence.',
    'case',
  ],
  [
    'autonomous',
    'Verified without help',
    'Eligible, verified issues with complete attribution and no approval, repair or correction.',
    'case',
  ],
  [
    'human',
    'Human involvement',
    'Issues with a persisted approval, repair, correction or human disposition, across every attempt.',
    'case',
  ],
  [
    'unknown',
    'Unknown attribution',
    'Issues without complete attribution over the current outcome interval.',
    'case',
  ],
  [
    'pending',
    'Awaiting verified outcome',
    'Issues without a current independent verified outcome, including human dispositions.',
    'case',
  ],
  [
    'recurrent',
    'Recurring issues',
    'New incidents linked to a previous incident. Each recurrence is a separate counting unit.',
    'case',
  ],
  [
    'incorrect_actions',
    'Issues with incorrect actions',
    'Distinct issues with evidence-backed incorrect action assessments; failures alone do not establish incorrectness.',
    'case',
  ],
  [
    'time_to_outcome',
    'Median time to outcome',
    'Median seconds from first detection to current independent verification, including all attempts.',
    'second',
  ],
  [
    'unresolved_age',
    'Oldest pending outcome',
    'Maximum seconds since first detection among issues awaiting independent verification.',
    'second',
  ],
];

export const resolutionMetricDefinitions: OperationalMetricDefinition[] =
  metricSpecs.map(([id, title, description, unit]) => ({
    id: `resolution.${id}`,
    title,
    description,
    unit,
    version: 2,
    family: 'resolution',
    filters: ['environment', 'window'],
    permissions: 'workspace_member',
    timeSemantics:
      'One incident ID, first detected in [asOf minus window, asOf). Current outcome at asOf. Default: live, seven days. Retries never add units.',
  }));

/** Classifies persisted incident facts without treating missing attribution or action acceptance as autonomy. */
export function classifyResolution(
  source: MeasurementSource,
  asOf: string,
): ResolutionMetricItem {
  const events = [...source.events].sort((a, b) => a.revision - b.revision);
  const facts = events.map((e) => e.fact);
  const environment = facts.find((f) => f.kind === 'environment');
  const eligibility = [...facts]
    .reverse()
    .find((f) => f.kind === 'eligibility');
  const attribution = [...facts]
    .reverse()
    .find((f) => f.kind === 'attribution');
  const resolution = source.resolution;
  const verified =
    source.state === 'resolved' &&
    resolution?.kind === 'verification' &&
    resolution.outcome === 'passed' &&
    resolution.authoritative === true &&
    resolution.complete === true &&
    resolution.evidenceRefs.length > 0 &&
    Date.parse(resolution.at) <= Date.parse(asOf) &&
    Date.parse(resolution.at) >= Date.parse(source.detectedAt);
  const human =
    source.humanEvidence.length > 0 ||
    resolution?.kind === 'human_disposition' ||
    facts.some(
      (f) =>
        f.kind === 'attribution' &&
        f.involvement !== 'none' &&
        f.involvement !== 'unknown',
    );
  const through = verified ? resolution!.at : asOf;
  const complete =
    attribution?.kind === 'attribution' &&
    attribution.complete &&
    attribution.involvement === 'none' &&
    Date.parse(attribution.from) <= Date.parse(source.detectedAt) &&
    Date.parse(attribution.through) >= Date.parse(through);
  const age = (Date.parse(asOf) - Date.parse(source.detectedAt)) / 1000;

  return {
    kind: 'resolution',
    id: source.id,
    title: source.title,
    state: source.state,
    detectedAt: source.detectedAt,
    environment: source.synthetic
      ? 'synthetic'
      : environment?.kind === 'environment'
        ? environment.environment
        : 'unknown',
    eligibility:
      eligibility?.kind === 'eligibility' ? eligibility.status : 'unknown',
    involvement: human ? 'human' : complete ? 'none' : 'unknown',
    outcome: verified
      ? 'verified'
      : resolution?.kind === 'human_disposition'
        ? 'human_disposition'
        : 'pending',
    verifiedAt: verified ? resolution!.at : null,
    timeToOutcomeSeconds: verified
      ? (Date.parse(resolution!.at) - Date.parse(source.detectedAt)) / 1000
      : null,
    unresolvedAgeSeconds: verified ? null : Math.max(0, age),
    previousIncidentId: source.previousIncidentId,
    incorrectActionIds: [
      ...new Set(
        facts.flatMap((f) =>
          f.kind === 'incorrect_action' ? [f.proposalId] : [],
        ),
      ),
    ],
    evidenceRefs: [
      ...new Set([
        ...facts.flatMap((f) => f.evidenceRefs),
        ...source.humanEvidence,
        ...(resolution?.evidenceRefs ?? []),
      ]),
    ].sort(),
    factIds: events.map((e) => e.id),
    revision: events.at(-1)?.revision ?? 0,
  };
}

/** Produces reconcilable cohorts from current persisted facts; source coverage remains separate from recorded-incident completeness. */
export function summarizeResolutionMetrics(
  sources: MeasurementSource[],
  asOf: string,
  scope: MeasurementScope = {},
): OperationalMetricRead<ResolutionMetricItem>[] {
  const start = Date.parse(asOf) - (scope.window === '24h' ? 1 : 7) * 86400000;
  const classified = sources
    .filter(
      (s) =>
        Date.parse(s.detectedAt) >= start &&
        Date.parse(s.detectedAt) < Date.parse(asOf),
    )
    .map((s) => classifyResolution(s, asOf));
  const items = classified
    .filter((s) => s.environment === (scope.environment ?? 'live'))
    .sort(
      (a, b) =>
        a.detectedAt.localeCompare(b.detectedAt) || a.id.localeCompare(b.id),
    );
  const excludedUnknown =
    scope.environment === 'unknown'
      ? 0
      : classified.filter((s) => s.environment === 'unknown').length;
  const unknownEligibility = items.filter(
    (s) => s.eligibility === 'unknown',
  ).length;
  const unknownAttribution = items.filter(
    (s) => s.involvement === 'unknown',
  ).length;
  const eligible = items.filter((s) => s.eligibility === 'eligible');
  const predicates: Record<string, (s: ResolutionMetricItem) => boolean> = {
    unknown_eligibility: (s) => s.eligibility === 'unknown',
    eligible: (s) => s.eligibility === 'eligible',
    verified: (s) => s.outcome === 'verified',
    autonomous: (s) =>
      s.eligibility === 'eligible' &&
      s.outcome === 'verified' &&
      s.involvement === 'none' &&
      !s.incorrectActionIds.length,
    human: (s) => s.involvement === 'human',
    unknown: (s) => s.involvement === 'unknown',
    pending: (s) => s.outcome !== 'verified',
    recurrent: (s) => s.previousIncidentId !== null,
    incorrect_actions: (s) => s.incorrectActionIds.length > 0,
    time_to_outcome: (s) => s.outcome === 'verified',
    unresolved_age: (s) => s.outcome !== 'verified',
  };

  return resolutionMetricDefinitions.map((definition) => {
    const key = definition.id.slice('resolution.'.length);
    const cohort = items.filter(predicates[key]!);
    const unknown =
      key === 'eligible'
        ? unknownEligibility
        : key === 'autonomous'
          ? items.filter(
              (s) =>
                s.eligibility === 'unknown' ||
                (s.eligibility === 'eligible' && s.involvement === 'unknown'),
            ).length
          : 0;
    const durations = cohort
      .map((s) =>
        key === 'time_to_outcome'
          ? s.timeToOutcomeSeconds!
          : s.unresolvedAgeSeconds!,
      )
      .sort((a, b) => a - b);
    const middle = Math.floor(durations.length / 2);
    const value =
      definition.unit === 'case'
        ? cohort.length
        : !durations.length
          ? null
          : key === 'unresolved_age'
            ? durations.at(-1)!
            : durations.length % 2
              ? durations[middle]!
              : (durations[middle - 1]! + durations[middle]!) / 2;
    const partial = unknown > 0 || excludedUnknown > 0;

    return {
      definition,
      value,
      total: partial ? null : value,
      observedCount: cohort.length,
      unknownCount: unknown,
      population: items.length,
      coverage: items.length
        ? partial
          ? 'partial'
          : 'complete'
        : 'unavailable',
      coverageExplanation: `${items.length} recorded ${scope.environment ?? 'live'} incidents in this detection cohort. ${excludedUnknown} incidents have unknown environment and are excluded. This does not establish complete provider coverage.`,
      freshness: 'fresh',
      observedAt: asOf,
      dataThrough: null,
      nextRefreshAt: items.length
        ? new Date(
            Math.min(
              Date.parse(asOf) + 60000,
              ...items.map(
                (s) =>
                  Date.parse(s.detectedAt) +
                  (scope.window === '24h' ? 1 : 7) * 86400000 +
                  1,
              ),
            ),
          ).toISOString()
        : null,
      breakdown: [
        { reason: 'eligible', count: eligible.length },
        { reason: 'unknown_eligibility', count: unknownEligibility },
        { reason: 'unknown_attribution', count: unknownAttribution },
        { reason: 'unknown_environment', count: excludedUnknown },
      ],
      items: cohort,
    };
  });
}
