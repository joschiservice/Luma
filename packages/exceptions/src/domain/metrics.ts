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
    description: 'Distinct unresolved issues across all subject kinds.',
    unit: 'case',
  },
  {
    id: 'cases.attention',
    title: 'Issues needing attention',
    description:
      'Unresolved issues requesting approval, manual intervention or uncertainty review. Each issue has one inbox reason.',
    unit: 'case',
  },
  {
    id: 'cases.oldest_unresolved_age',
    title: 'Oldest unresolved issue',
    description:
      'Age since first detection of the oldest unresolved issue. Reopening retains first detection. Missing or future detection times are unknown.',
    unit: 'second',
  },
].map((d) => ({
  ...d,
  version: 2,
  family: 'cases',
  filters: [],
  permissions: 'workspace_member',
  timeSemantics:
    'Current unresolved state and inbox attention evaluated at asOf.',
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
