import type {
  OperationalMetricRequest,
  OperationalMetricResponse,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Select } from '@luma/ui/components/primitives/select';
import { CheckCheck, Fingerprint, Timer } from 'lucide-react';

import type { LiveMetricView } from './metrics-live';
import { type MetricGroup, OperationalMetrics } from './operational-metrics';

const groups: (MetricGroup & {
  metrics: OperationalMetricRequest['metrics'];
})[] = [
  {
    id: 'outcomes',
    title: m.overview_outcomes_group_verified_title,
    subtitle: m.overview_outcomes_group_verified_subtitle,
    icon: CheckCheck,
    metrics: [
      'resolution.eligible',
      'resolution.verified',
      'resolution.autonomous',
      'resolution.pending',
    ],
  },
  {
    id: 'involvement',
    title: m.overview_outcomes_group_human_title,
    subtitle: m.overview_outcomes_group_human_subtitle,
    icon: Fingerprint,
    metrics: [
      'resolution.human',
      'resolution.unknown',
      'resolution.unknown_eligibility',
      'resolution.incorrect_actions',
    ],
  },
  {
    id: 'duration',
    title: m.overview_outcomes_group_time_title,
    subtitle: m.overview_outcomes_group_time_subtitle,
    icon: Timer,
    metrics: [
      'resolution.time_to_outcome',
      'resolution.unresolved_age',
      'resolution.recurrent',
    ],
  },
];

export type OutcomeEnvironment = NonNullable<
  NonNullable<OperationalMetricRequest['scope']>['environment']
>;

export type OutcomeWindow = '24h' | '7d';

/** The resolution view a page requests in its metric summary for the chosen cohort. */
export function resolutionMetricRequest(
  environment: OutcomeEnvironment,
  window: OutcomeWindow,
): OperationalMetricRequest {
  return {
    definitionVersion: 2,
    metrics: groups.flatMap((g) => g.metrics),
    scope: { environment, window },
  };
}

const environments = {
  live: m.overview_outcomes_env_live,
  observe_only: m.issues_observe_only_title,
  pilot: m.overview_outcomes_env_pilot,
  synthetic: m.overview_outcomes_env_synthetic,
  shadow: m.overview_outcomes_env_shadow,
  unknown: m.overview_outcomes_env_unknown,
} satisfies Record<OutcomeEnvironment, () => string>;
const windows = {
  '24h': m.overview_outcomes_window_24h,
  '7d': m.overview_outcomes_window_7d,
} satisfies Record<OutcomeWindow, () => string>;
const environmentOrder: OutcomeEnvironment[] = [
  'live',
  'pilot',
  'synthetic',
  'shadow',
  'unknown',
];
const windowOrder: OutcomeWindow[] = ['24h', '7d'];

/**
 * Chooses the verified-outcome cohort: the environment its incidents ran in and how recently
 * they were first detected. Anything but live operations is marked as excluded from live results.
 */
export function OutcomeFilters({
  environment,
  window,
  onEnvironmentChange,
  onWindowChange,
}: {
  environment: OutcomeEnvironment;
  window: OutcomeWindow;
  onEnvironmentChange: (environment: OutcomeEnvironment) => void;
  onWindowChange: (window: OutcomeWindow) => void;
}) {
  return (
    <>
      <Select
        className="outcome-environment-select"
        aria-label={m.overview_outcomes_env_label()}
        options={environmentOrder.map((value) => ({
          value,
          label: environments[value](),
        }))}
        value={environment}
        onValueChange={(value) => {
          if (value) onEnvironmentChange(value);
        }}
      />
      <Select
        className="outcome-window-select"
        aria-label={m.overview_outcomes_window_label()}
        options={windowOrder.map((value) => ({
          value,
          label: windows[value](),
        }))}
        value={window}
        onValueChange={(value) => {
          if (value) onWindowChange(value);
        }}
      />
      {environment !== 'live' ? (
        <Badge tone="warning">{m.overview_outcomes_excluded()}</Badge>
      ) : null}
    </>
  );
}

/**
 * Shows verified outcomes and human help for the cohort the page's filters choose, with
 * authorized evidence drilldowns. The page owns the cohort so its metric summary reads the
 * matching request, and it shows the live status and refresh.
 */
export function ResolutionOutcomes({
  organizationId,
  live,
  environment,
  window,
}: {
  organizationId: string;
  live: LiveMetricView<OperationalMetricResponse>;
  environment: OutcomeEnvironment;
  window: OutcomeWindow;
}) {
  return (
    <div className="outcome-measurement">
      <OperationalMetrics
        key={`${organizationId}:${environment}:${window}`}
        organizationId={organizationId}
        live={live}
        initialRequest={resolutionMetricRequest(environment, window)}
        metricGroups={groups}
        heading={m.overview_outcomes_title()}
        description={m.overview_outcomes_description()}
        embedded
      />
    </div>
  );
}
