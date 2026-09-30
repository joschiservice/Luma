import type { OperationalMetricRequest } from '@luma/api-contract';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Select } from '@luma/ui/components/primitives/select';
import { CheckCheck, Fingerprint, Timer } from 'lucide-react';
import { useMemo, useState } from 'react';

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

type Environment = NonNullable<
  OperationalMetricRequest['scope']
>['environment'];

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

/** Shows verified outcomes and attribution with explicit environment/window controls and authorized evidence drilldowns. */
export function ResolutionOutcomes({
  organizationId,
  initialWindow = '7d',
}: {
  organizationId: string;
  initialWindow?: '24h' | '7d';
}) {
  const [environment, setEnvironment] = useState<Environment>('live');
  const [window, setWindow] = useState<'24h' | '7d'>(initialWindow);
  const request = useMemo<OperationalMetricRequest>(
    () => ({
      definitionVersion: 2,
      metrics: groups.flatMap((g) => g.metrics),
      scope: { environment, window },
    }),
    [environment, window],
  );

  return (
    <div className="outcome-measurement">
      <div className="outcome-measurement-controls">
        <Select
          className="outcome-environment-select"
          aria-label="Outcome environment"
          options={environments}
          value={environment}
          onValueChange={(value) => {
            if (value) setEnvironment(value);
          }}
        />
        <Select
          className="outcome-window-select"
          aria-label="Outcome detection window"
          options={windows}
          value={window}
          onValueChange={(value) => {
            if (value) setWindow(value);
          }}
        />
        {environment !== 'live' ? (
          <Badge tone="warning">Excluded from live results</Badge>
        ) : null}
      </div>
      <OperationalMetrics
        key={`${organizationId}:${environment}:${window}`}
        organizationId={organizationId}
        initialRequest={request}
        metricGroups={groups}
        heading="Verified outcomes & human work"
        description="See what finished correctly, where people helped, and what the evidence cannot yet establish."
      />
    </div>
  );
}
