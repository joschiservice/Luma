import type { IncidentView, RunDetail } from '@luma/simulator-contract';
import {
  type IncidentKindName,
  incidentKindNames,
  incidentKinds,
  type WorkflowScenarioName,
  workflowScenarioNames,
  workflowScenarios,
} from '@luma/simulator-core';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
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
import {
  Field,
  FieldDescription,
  FieldLabel,
} from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import {
  type OperationalState,
  StatePill,
} from '@luma/ui/components/primitives/state';
import { type FormEvent, useId, useRef, useState } from 'react';

import { errorMessage } from '../../api';
import { SelectField } from '../../components/fields';
import { LoadError, Loading } from '../../components/query-state';
import { formatDateTime, formatDuration } from '../../lib/format';
import { randomId } from '../../lib/id';
import {
  exceptionClassLabel,
  incidentStatusText,
  surfaceLabels,
} from '../../lib/labels';
import {
  useIncidents,
  useInjectIncident,
  useRecoverIncident,
  useRunScenario,
} from '../../queries';
import { InventoryCheck } from './inventory-check';

type Detection = NonNullable<IncidentView['detection']>;

const detectionState: Record<Detection['state'], OperationalState> = {
  detected: 'verified',
  missed: 'error',
  pending: 'waiting',
  'not-covered': 'idle',
};

/** Describes Luma's detection of an incident in words, with the time it took. */
export function detectionText(incident: IncidentView) {
  const detection = incident.detection;
  if (!detection) return 'Not evaluated';
  switch (detection.state) {
    case 'detected':
      return detection.detectedAt === null
        ? 'Detected'
        : `Detected in ${formatDuration(Math.max(0, detection.detectedAt - incident.startedAt))}`;
    case 'missed':
      return 'Missed';
    case 'pending':
      return 'Pending';
    case 'not-covered':
      return 'Not covered by a rule';
  }
}

/** Describes a workflow run's state as people read it in Luma. */
function workflowStateText(state: string) {
  switch (state) {
    case 'awaiting_decision':
      return 'waiting for approval';
    case 'verified':
      return 'change verified';
    case 'ended':
      return 'finished without a change';
    case 'escalated':
      return 'handed to a person';
    case 'denied':
      return 'not allowed';
    case 'failed_verification':
    case 'inconclusive_verification':
      return 'result not confirmed';
    case 'waiting':
      return 'waiting to check again';
    default:
      return 'in progress';
  }
}

const statusState: Record<IncidentView['status'], OperationalState> = {
  planned: 'waiting',
  active: 'attention',
  recovered: 'idle',
};

const filters = [
  { value: 'open', label: 'Planned and active' },
  { value: 'all', label: 'All incidents' },
  { value: 'recovered', label: 'Recovered' },
] as const;

type Filter = (typeof filters)[number]['value'];

/** Rendering stops here; the newest incidents come first. */
const shownLimit = 200;

/**
 * Ground-truth incidents and Luma's detection of each. Injected incidents can be recovered,
 * which removes their cause in the provider systems; Luma closes its case only after its own
 * verification.
 */
export function IncidentsView({ run }: { run: RunDetail }) {
  return (
    <div className="sim-stack">
      <WorkflowScenarios run={run} />
      <InjectIncident run={run} />
      <IncidentList run={run} />
      <InventoryCheck run={run} />
    </div>
  );
}

/**
 * Starts reproducible situations for Luma's case workflows, each with what Luma should do. A
 * scenario keeps its request ID until it succeeds, so retrying never starts it twice.
 */
function WorkflowScenarios({ run }: { run: RunDetail }) {
  const start = useRunScenario(run.id);
  const id = useId();
  const pending = useRef<{ scenario: WorkflowScenarioName; id: string } | null>(
    null,
  );
  const [started, setStarted] = useState<WorkflowScenarioName | null>(null);

  function begin(scenario: WorkflowScenarioName) {
    if (pending.current?.scenario !== scenario)
      pending.current = { scenario, id: randomId() };
    start.mutate(
      { id: pending.current.id, scenario },
      {
        onSuccess: () => {
          pending.current = null;
          setStarted(scenario);
        },
      },
    );
  }

  return (
    <Card as="section" aria-labelledby={`${id}-title`}>
      <CardHeader>
        <div>
          <CardTitle id={`${id}-title`}>Workflow scenarios</CardTitle>
          <CardDescription>
            Each one causes a situation that a workflow handles in Luma. Sign in
            as the admin to approve its changes in Needs you.
          </CardDescription>
        </div>
      </CardHeader>
      <ul className="sim-scenarios">
        {workflowScenarioNames.map((name) => {
          const scenario = workflowScenarios[name];

          return (
            <li key={name}>
              <div className="sim-cell-stack">
                <strong>{scenario.label}</strong>
                <span>{scenario.description}</span>
                <span className="sim-muted">Expected: {scenario.expected}</span>
              </div>
              <Button
                variant="outline"
                disabled={start.isPending}
                onClick={() => begin(name)}
              >
                Start
              </Button>
            </li>
          );
        })}
      </ul>
      <div aria-live="polite">
        {start.isError ? (
          <p className="sim-error-text" role="alert">
            Not started: {errorMessage(start.error)} Retrying sends the same
            request ID, so it cannot start twice.
          </p>
        ) : started ? (
          <p>
            {workflowScenarios[started].label} started. Follow it in the
            incident list below and in Luma.
          </p>
        ) : null}
      </div>
    </Card>
  );
}

function InjectIncident({ run }: { run: RunDetail }) {
  const inject = useInjectIncident(run.id);
  const id = useId();
  const [kind, setKind] = useState<IncidentKindName>('inventory-drift');
  const [instance, setInstance] = useState('any');
  const [target, setTarget] = useState('');
  // One request keeps its ID across retries, so an uncertain response never injects twice.
  const pending = useRef<{ signature: string; id: string } | null>(null);
  const [created, setCreated] = useState<IncidentView | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    const body = {
      kind,
      ...(instance === 'any' ? {} : { instance }),
      ...(target.trim() ? { target: target.trim() } : {}),
    };
    const signature = JSON.stringify(body);
    if (pending.current?.signature !== signature)
      pending.current = { signature, id: randomId() };
    const request = { id: pending.current.id, ...body };
    inject.mutate(request, {
      onSuccess: (incident) => {
        pending.current = null;
        setCreated(incident);
      },
    });
  }

  return (
    <Card as="section" aria-labelledby={`${id}-title`}>
      <CardHeader>
        <div>
          <CardTitle id={`${id}-title`}>Inject an incident</CardTitle>
          <CardDescription>
            Causes one operational problem now, or on the next order that
            reaches the affected step.
          </CardDescription>
        </div>
      </CardHeader>
      <form className="sim-form" onSubmit={submit}>
        <div className="sim-field-grid">
          <SelectField<IncidentKindName>
            label="Kind"
            value={kind}
            options={incidentKindNames.map((name) => ({
              value: name,
              label: incidentKinds[name].label,
            }))}
            description={incidentKinds[kind].description}
            onChange={setKind}
          />
          <SelectField
            label="Instance (optional)"
            value={instance}
            options={[
              { value: 'any', label: 'Chosen by the simulator' },
              ...run.instances.map((i) => ({ value: i.name, label: i.label })),
            ]}
            onChange={setInstance}
          />
          <Field>
            <FieldLabel htmlFor={`${id}-target`}>Target (optional)</FieldLabel>
            <Input
              id={`${id}-target`}
              value={target}
              maxLength={120}
              onChange={(event) => setTarget(event.currentTarget.value)}
              aria-describedby={`${id}-target-hint`}
            />
            <FieldDescription id={`${id}-target-hint`}>
              SKU, order name or record ID, depending on the kind.
            </FieldDescription>
          </Field>
        </div>
        <div className="sim-actions">
          <Button type="submit" disabled={inject.isPending}>
            {inject.isPending ? 'Injecting…' : 'Inject incident'}
          </Button>
        </div>
        <div aria-live="polite">
          {inject.isError ? (
            <p className="sim-error-text" role="alert">
              Not injected: {errorMessage(inject.error)} Retrying sends the same
              request ID, so it cannot inject twice.
            </p>
          ) : created ? (
            <p>
              {created.label}: {incidentStatusText(created).toLowerCase()}.{' '}
              {created.summary}
            </p>
          ) : null}
        </div>
      </form>
    </Card>
  );
}

function IncidentList({ run }: { run: RunDetail }) {
  const incidents = useIncidents(run.id);
  const recover = useRecoverIncident(run.id);
  const [filter, setFilter] = useState<Filter>('open');
  const all = incidents.data ?? [];
  const matching = all
    .filter((incident) =>
      filter === 'all'
        ? true
        : filter === 'recovered'
          ? incident.status === 'recovered'
          : incident.status !== 'recovered',
    )
    .sort((a, b) => b.startedAt - a.startedAt);
  const shown = matching.slice(0, shownLimit);
  const active = all.filter((incident) => incident.status === 'active').length;
  const planned = all.filter(
    (incident) => incident.status === 'planned',
  ).length;

  const columns: DataTableColumn<IncidentView>[] = [
    {
      key: 'incident',
      header: 'Incident',
      cell: (incident) => (
        <span className="sim-cell-stack">
          <strong>{incident.label}</strong>
          <span className="sim-muted">{incident.summary}</span>
          {incident.resources.length ? (
            <span className="sim-muted">
              {incident.resources
                .map((r) => `${r.instance} ${r.kind} ${r.label}`)
                .join(' · ')}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (incident) => (
        <span className="sim-cell-stack">
          <StatePill state={statusState[incident.status]}>
            {incidentStatusText(incident)}
          </StatePill>
          <Badge tone={incident.origin === 'injected' ? 'accent' : 'neutral'}>
            {incident.origin === 'injected' ? 'Injected' : 'Emerged'}
          </Badge>
        </span>
      ),
    },
    {
      key: 'started',
      header: 'Started',
      hideOnNarrow: true,
      cell: (incident) => (
        <span className="sim-cell-stack lu-numeric">
          {incident.status === 'planned' ? (
            <span className="sim-muted">Not started</span>
          ) : (
            formatDateTime(incident.startedAt)
          )}
          {incident.endedAt !== null ? (
            <span className="sim-muted">
              Recovered {formatDateTime(incident.endedAt)}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'expected',
      header: 'Expected in Luma',
      hideOnNarrow: true,
      cell: (incident) => (
        <span className="sim-cell-stack">
          {surfaceLabels[incident.expected.surface] ??
            incident.expected.surface}
          <span className="sim-muted">
            {exceptionClassLabel(incident.expected.exceptionClass)}
          </span>
        </span>
      ),
    },
    {
      key: 'detection',
      header: 'Detection',
      cell: (incident) => (
        <span className="sim-cell-stack">
          <StatePill
            state={
              incident.detection
                ? detectionState[incident.detection.state]
                : 'idle'
            }
          >
            {detectionText(incident)}
          </StatePill>
          {incident.detection?.resolved ? (
            <Badge tone={incident.detection.verified ? 'success' : 'warning'}>
              {incident.detection.verified
                ? 'Case resolved, verified'
                : 'Case closed without verification'}
            </Badge>
          ) : null}
          {incident.detection?.caseUrl ? (
            <a
              href={incident.detection.caseUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open case in Luma<span className="sr-only"> (new tab)</span>
            </a>
          ) : null}
          {incident.detection?.workflow ? (
            <a
              href={incident.detection.workflow.url}
              target="_blank"
              rel="noreferrer"
            >
              {incident.detection.workflow.name}:{' '}
              {workflowStateText(incident.detection.workflow.state)}
              <span className="sr-only"> (new tab)</span>
            </a>
          ) : null}
        </span>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      cell: (incident) =>
        incident.origin === 'injected' && incident.status !== 'recovered' ? (
          <Button
            variant="outline"
            size="sm"
            disabled={recover.isPending}
            aria-label={`Recover ${incident.label} incident`}
            onClick={() => recover.mutate(incident.id)}
          >
            Recover
          </Button>
        ) : null,
    },
  ];

  return (
    <Card as="section" aria-labelledby="incident-list-title">
      <CardHeader>
        <div>
          <CardTitle id="incident-list-title">Incidents</CardTitle>
          <CardDescription>
            {incidents.data
              ? `${active} active · ${planned} planned · ${all.length} in total. Recovering removes the cause; Luma resolves its case only after verifying.`
              : 'Ground truth the scorecard compares with Luma’s cases.'}
          </CardDescription>
        </div>
        <Select
          aria-label="Show incidents"
          className="sim-filter-select"
          value={filter}
          options={filters}
          onValueChange={(value) => {
            if (value) setFilter(value);
          }}
        />
      </CardHeader>
      {recover.isError ? (
        <p className="sim-error-text" role="alert">
          Not recovered: {errorMessage(recover.error)}
        </p>
      ) : null}
      {incidents.isPending ? (
        <Loading label="Loading incidents" />
      ) : incidents.isError ? (
        <LoadError
          title="Incidents unavailable"
          error={incidents.error}
          onRetry={() => void incidents.refetch()}
        />
      ) : (
        <>
          <DataTable
            caption="Incidents"
            columns={columns}
            rows={shown}
            rowKey={(incident) => incident.id}
            density="compact"
            variant="plain"
            empty={
              <p className="sim-muted">
                {all.length === 0
                  ? 'No incidents yet. Inject one, or wait for the chaos profile to produce them.'
                  : 'No incidents match this filter.'}
              </p>
            }
          />
          {matching.length > shown.length ? (
            <p className="sim-note">
              Showing the newest {shownLimit} of {matching.length} incidents.
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}
