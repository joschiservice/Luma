import type {
  OperationalMetricDefinition,
  OperationalMetricRead,
} from '@luma/platform';

export interface CaseMetricItem {
  kind: 'case';
  id: string;
  subjectKind: string;
  subjectId: string;
  state: string;
  title: string;
  detectedAt: string | null;
  ageSeconds: number | null;
  reason: 'approval' | 'manual_intervention' | 'uncertainty' | null;
}

export const caseMetricDefinitions: OperationalMetricDefinition[] = [
  {
    id: 'cases.active',
    title: 'Unresolved issues',
    description:
      'Every unresolved issue, counted once, whatever record it affects.',
    unit: 'case',
  },
  {
    id: 'cases.attention',
    title: 'Issues needing attention',
    description:
      'Unresolved issues waiting for an approval, a manual fix, or a review of an unclear outcome. Each issue counts under one reason.',
    unit: 'case',
  },
  {
    id: 'cases.oldest_unresolved_age',
    title: 'Oldest unresolved issue',
    description:
      'Time since the oldest unresolved issue was first detected. A reopened issue keeps its first detection time. Missing or future detection times count as unknown.',
    unit: 'second',
  },
].map((d) => ({
  ...d,
  version: 2,
  family: 'cases',
  filters: [],
  permissions: 'workspace_member',
  timeSemantics:
    'Counts unresolved issues, and what they wait for, at the time shown.',
})) as OperationalMetricDefinition[];

/** Counts the inbox projection, preserving unknown ages and mutually exclusive attention reasons. */
export function summarizeCaseMetrics(
  items: CaseMetricItem[],
  asOf: string,
  boundary: string | null,
): OperationalMetricRead<CaseMetricItem>[] {
  const active = items
    .filter((item) => item.state !== 'resolved')
    .map((item) => {
      const age = item.detectedAt
        ? (Date.parse(asOf) - Date.parse(item.detectedAt)) / 1000
        : NaN;

      return {
        ...item,
        ageSeconds: Number.isFinite(age) && age >= 0 ? age : null,
      };
    });
  const unknown = active.filter((item) => item.ageSeconds === null).length;
  const oldest = active
    .filter((item) => item.ageSeconds !== null)
    .sort(
      (a, b) =>
        Date.parse(a.detectedAt!) - Date.parse(b.detectedAt!) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, 1);

  return caseMetricDefinitions.map((definition) => {
    const age = definition.unit === 'second';
    const attention = definition.id === 'cases.attention';
    const cohort = age
      ? oldest
      : attention
        ? active.filter((item) => item.reason !== null)
        : active;
    const value = age
      ? unknown
        ? null
        : (oldest[0]?.ageSeconds ?? null)
      : cohort.length;
    const periodic = active.length
      ? new Date(Date.parse(asOf) + 60_000).toISOString()
      : null;

    return {
      definition,
      value,
      total: value,
      observedCount: cohort.length,
      unknownCount: age ? unknown : 0,
      population: active.length,
      coverage: 'complete',
      coverageExplanation: 'All unresolved issues recorded in this workspace.',
      freshness: 'fresh',
      observedAt: null,
      dataThrough: null,
      nextRefreshAt:
        [boundary, periodic].filter((v): v is string => !!v).sort()[0] ?? null,
      breakdown: attention
        ? ['approval', 'manual_intervention', 'uncertainty'].map((reason) => ({
            reason,
            count: cohort.filter((item) => item.reason === reason).length,
          }))
        : [],
      items: cohort,
    };
  });
}
