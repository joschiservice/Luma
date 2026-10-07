import type {
  OperationalMetricRequest,
  OperationalMetricResponse,
} from '@luma/api-contract';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Select } from '@luma/ui/components/primitives/select';
import { CheckCheck, Fingerprint, Timer } from 'lucide-react';

import type { LiveMetricView } from './metrics-live';
import { OperationalMetrics } from './operational-metrics';

const groups: {
  id: string;
  title: string;
  subtitle: string;
  icon: typeof CheckCheck;
  metrics: OperationalMetricRequest['metrics'];
}[] = [
  {
    id: 'outcomes',
    title: 'Verified outcomes',
    subtitle: 'One incident, across every attempt',
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
    title: 'Human involvement',
    subtitle: 'Retained approvals, repairs & corrections',
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
    title: 'Time & recurrence',
    subtitle: 'Measured from first detection',
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

const environments = [
  { value: 'live', label: 'Live operations' },
  { value: 'pilot', label: 'Partner pilot' },
  { value: 'synthetic', label: 'Synthetic' },
  { value: 'shadow', label: 'Shadow' },
  { value: 'unknown', label: 'Unknown environment' },
] as const;
const windows = [
  { value: '24h', label: 'Detected in last 24 hours' },
  { value: '7d', label: 'Detected in last 7 days' },
] as const;

/**
 * Shows verified outcomes and attribution with explicit environment/window controls and authorized
 * evidence drilldowns. The page owns the cohort so its metric summary reads the matching request.
 */
export function ResolutionOutcomes({
  organizationId,
  live,
  environment,
  window,
  onEnvironmentChange,
  onWindowChange,
}: {
  organizationId: string;
  live: LiveMetricView<OperationalMetricResponse>;
  environment: OutcomeEnvironment;
  window: OutcomeWindow;
  onEnvironmentChange: (environment: OutcomeEnvironment) => void;
  onWindowChange: (window: OutcomeWindow) => void;
}) {
  return (
    <div className="outcome-measurement">
      <div className="outcome-measurement-controls">
        <Select
          className="outcome-environment-select"
          aria-label="Outcome environment"
          options={environments}
          value={environment}
          onValueChange={(value) => {
            if (value) onEnvironmentChange(value);
          }}
        />
        <Select
          className="outcome-window-select"
          aria-label="Outcome detection window"
          options={windows}
          value={window}
          onValueChange={(value) => {
            if (value) onWindowChange(value);
          }}
        />
        {environment !== 'live' ? (
          <Badge tone="warning">Excluded from live results</Badge>
        ) : null}
      </div>
      <OperationalMetrics
        key={`${organizationId}:${environment}:${window}`}
        organizationId={organizationId}
        live={live}
        initialRequest={resolutionMetricRequest(environment, window)}
        metricGroups={groups}
        heading="Verified outcomes & human work"
        description="See what finished correctly, where people helped, and what the evidence cannot yet establish."
      />
    </div>
  );
}
