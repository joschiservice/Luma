import type { RunDetail } from '@luma/simulator-contract';
import { Badge } from '@luma/ui/components/primitives/badge';
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import {
  DataTable,
  type DataTableColumn,
} from '@luma/ui/components/primitives/data-table';
import { Select } from '@luma/ui/components/primitives/select';

import { errorMessage } from '../../api';
import {
  formatCount,
  formatLatency,
  formatPercent,
  providerLabel,
} from '../../lib/format';
import type { meanLatency, requestHealth } from '../../lib/metrics';
import { useControl } from '../../queries';

type Instance = RunDetail['instances'][number];

type Health = Instance['health'];

/** Labels and tones of the service health a person can force on an instance. */
const healthOptions: Record<
  Health,
  { label: string; tone: 'success' | 'warning' | 'danger' }
> = {
  healthy: { label: 'Healthy', tone: 'success' },
  'rate-limited': { label: 'Rate limited (HTTP 429)', tone: 'warning' },
  unavailable: { label: 'Unavailable (HTTP 503)', tone: 'danger' },
  unauthorized: { label: 'Unauthorized (HTTP 401)', tone: 'danger' },
};

const healthSelectOptions = (Object.keys(healthOptions) as Health[]).map(
  (value) => ({ value, label: healthOptions[value].label }),
);

/**
 * Provider instances with their forced service health, request outcomes and latency. Changing
 * health applies to every request to the instance until it is changed or the run resets.
 */
export function InstancesCard({
  run,
  health,
  latency,
}: {
  run: RunDetail;
  health: ReturnType<typeof requestHealth>;
  latency: ReturnType<typeof meanLatency>;
}) {
  const control = useControl(run.id);
  const columns: DataTableColumn<Instance>[] = [
    {
      key: 'instance',
      header: 'Instance',
      cell: (instance) => (
        <span className="sim-cell-stack">
          <strong>{instance.label}</strong>
          <code className="sim-muted">{instance.name}</code>
        </span>
      ),
    },
    {
      key: 'kind',
      header: 'Provider',
      hideOnNarrow: true,
      cell: (instance) => providerLabel(instance.kind),
    },
    {
      key: 'status',
      header: 'Health',
      cell: (instance) => (
        <Badge tone={healthOptions[instance.health].tone}>
          {healthOptions[instance.health].label}
        </Badge>
      ),
    },
    {
      key: 'requests',
      header: 'Requests',
      numeric: true,
      hideOnNarrow: true,
      cell: (instance) => {
        const entry = health.find((h) => h.instance === instance.name);

        return entry ? formatCount(entry.requests) : '—';
      },
    },
    {
      key: 'errors',
      header: 'Error rate',
      numeric: true,
      cell: (instance) => {
        const rate = health.find(
          (h) => h.instance === instance.name,
        )?.errorRate;

        return rate === undefined || rate === null
          ? '—'
          : formatPercent(rate, 2);
      },
    },
    {
      key: 'latency',
      header: 'Mean latency',
      numeric: true,
      hideOnNarrow: true,
      cell: (instance) => {
        const mean = latency.find((l) => l.instance === instance.name)?.meanMs;

        return mean === undefined || mean === null ? '—' : formatLatency(mean);
      },
    },
    {
      key: 'control',
      header: 'Service health',
      cell: (instance) => (
        <Select
          aria-label={`Service health of ${instance.label}`}
          className="sim-health-select"
          value={instance.health}
          options={healthSelectOptions}
          disabled={control.isPending}
          onValueChange={(status) => {
            if (status)
              control.mutate({
                action: 'service-health',
                instance: instance.name,
                status,
              });
          }}
        />
      ),
    },
  ];

  return (
    <Card as="section" aria-labelledby="instances-title">
      <CardHeader>
        <div>
          <CardTitle id="instances-title">Provider instances</CardTitle>
          <CardDescription>
            Forced health overrides chaos for every request to the instance
            until changed or reset. Request numbers cover the selected window.
          </CardDescription>
        </div>
      </CardHeader>
      {control.isError ? (
        <p className="sim-error-text" role="alert">
          Service health was not changed: {errorMessage(control.error)}
        </p>
      ) : null}
      <DataTable
        caption="Provider instances"
        columns={columns}
        rows={run.instances}
        rowKey={(instance) => instance.name}
        density="compact"
        variant="plain"
      />
    </Card>
  );
}
