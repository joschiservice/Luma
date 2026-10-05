import { faultRuleSchema, type RunDetail } from '@luma/simulator-contract';
import { type FaultKind, faultKinds } from '@luma/simulator-core';
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
import { Field, FieldLabel } from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { type FormEvent, useId, useState } from 'react';

import { errorMessage } from '../../api';
import { NumberField, SelectField } from '../../components/fields';
import { faultLabels } from '../../lib/labels';
import { useControl } from '../../queries';
import { OperationSuggestions } from './targeted';

type Fault = RunDetail['faults'][number];

const statusTone: Record<string, 'info' | 'neutral' | 'success'> = {
  armed: 'info',
  triggered: 'success',
};

const statusLabel = (status: string) =>
  status.charAt(0).toUpperCase() + status.slice(1);

/**
 * Arms precise faults for reproducing one failure: the nth matching request to an operation,
 * optionally for one resource, fails a set number of times. Lifetimes use simulation time.
 */
export function FaultRules({ run }: { run: RunDetail }) {
  const control = useControl(run.id);
  const disable = useControl(run.id);
  const id = useId();
  const [instance, setInstance] = useState(run.instances[0]?.name ?? '');
  const [operation, setOperation] = useState('*');
  const [resource, setResource] = useState('');
  const [kind, setKind] = useState<FaultKind>('unavailable');
  const [occurrence, setOccurrence] = useState<number | undefined>(1);
  const [remaining, setRemaining] = useState<number | undefined>(1);
  const [lifetime, setLifetime] = useState<number | undefined>(300);
  const [problem, setProblem] = useState<string | null>(null);

  function arm(event: FormEvent) {
    event.preventDefault();
    const parsed = faultRuleSchema.safeParse({
      instance,
      operation: operation.trim(),
      kind,
      occurrence,
      remaining,
      ...(resource.trim() ? { resource: resource.trim() } : {}),
      ...(lifetime === undefined ? {} : { lifetimeMs: lifetime * 1_000 }),
    });
    if (!parsed.success) {
      setProblem(
        parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join(' '),
      );

      return;
    }
    if (kind === 'response-loss' && operation.trim() === '*') {
      setProblem(
        'Response loss applies to one write operation; name the operation.',
      );

      return;
    }
    setProblem(null);
    control.mutate({ action: 'fault', rule: parsed.data });
  }

  const columns: DataTableColumn<Fault>[] = [
    { key: 'id', header: 'Rule', cell: (fault) => <code>{fault.id}</code> },
    { key: 'instance', header: 'Instance', cell: (fault) => fault.instance },
    {
      key: 'target',
      header: 'Operation and resource',
      cell: (fault) => (
        <span className="sim-cell-stack">
          <code>
            {fault.operation === '*' ? 'All operations' : fault.operation}
          </code>
          <span className="sim-muted">{fault.resource ?? 'All resources'}</span>
        </span>
      ),
    },
    {
      key: 'kind',
      header: 'Fault',
      cell: (fault) => faultLabels[fault.kind as FaultKind] ?? fault.kind,
    },
    {
      key: 'remaining',
      header: 'Remaining',
      numeric: true,
      cell: (fault) => fault.remaining,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (fault) => (
        <Badge tone={statusTone[fault.status] ?? 'neutral'}>
          {statusLabel(fault.status)}
        </Badge>
      ),
    },
    {
      key: 'action',
      header: <span className="sr-only">Actions</span>,
      cell: (fault) => (
        <Button
          variant="outline"
          size="sm"
          disabled={fault.status !== 'armed' || disable.isPending}
          aria-label={`Disable rule ${fault.id}`}
          onClick={() => disable.mutate({ action: 'disable', id: fault.id })}
        >
          Disable
        </Button>
      ),
    },
  ];

  return (
    <Card as="section" aria-labelledby={`${id}-title`}>
      <CardHeader>
        <div>
          <CardTitle id={`${id}-title`}>Manual fault rules</CardTitle>
          <CardDescription>
            Reproduce one failure precisely, independent of the chaos profile.
          </CardDescription>
        </div>
      </CardHeader>
      <OperationSuggestions />
      <form className="sim-form" onSubmit={arm} noValidate>
        <div className="sim-field-grid">
          <SelectField
            label="Instance"
            value={instance}
            options={run.instances.map((i) => ({
              value: i.name,
              label: i.label,
            }))}
            onChange={setInstance}
          />
          <Field>
            <FieldLabel htmlFor={`${id}-operation`}>Operation</FieldLabel>
            <Input
              id={`${id}-operation`}
              list="sim-operations"
              value={operation}
              onChange={(event) => setOperation(event.currentTarget.value)}
              aria-describedby={`${id}-operation-hint`}
            />
            <span id={`${id}-operation-hint`} className="sim-note">
              Use * for every operation.
            </span>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-resource`}>
              Resource (optional)
            </FieldLabel>
            <Input
              id={`${id}-resource`}
              value={resource}
              placeholder="Record ID or Shopify global ID"
              onChange={(event) => setResource(event.currentTarget.value)}
            />
          </Field>
          <SelectField<FaultKind>
            label="Fault"
            value={kind}
            options={faultKinds.map((value) => ({
              value,
              label: faultLabels[value],
            }))}
            onChange={setKind}
          />
          <NumberField
            label="Occurrence"
            value={occurrence}
            min={1}
            max={10_000}
            description="The first matching request that fails; earlier ones pass."
            onChange={setOccurrence}
          />
          <NumberField
            label="Count"
            value={remaining}
            min={1}
            max={10_000}
            description="How many matching requests fail."
            onChange={setRemaining}
          />
          <NumberField
            label="Lifetime"
            unit="s"
            optional
            value={lifetime}
            min={1}
            max={86_400}
            description="Empty keeps the rule until it triggers or is disabled."
            onChange={setLifetime}
          />
        </div>
        {problem || control.isError ? (
          <p className="sim-error-text" role="alert">
            {problem ??
              `The rule was not armed: ${errorMessage(control.error)}`}
          </p>
        ) : null}
        {disable.isError ? (
          <p className="sim-error-text" role="alert">
            The rule was not disabled: {errorMessage(disable.error)}
          </p>
        ) : null}
        <div className="sim-actions">
          <Button type="submit" disabled={control.isPending}>
            {control.isPending ? 'Arming…' : 'Arm fault'}
          </Button>
        </div>
      </form>
      <DataTable
        caption="Manual fault rules"
        columns={columns}
        rows={[...run.faults].reverse()}
        rowKey={(fault) => fault.id}
        density="compact"
        variant="plain"
        empty={<p className="sim-muted">No manual fault rules.</p>}
      />
    </Card>
  );
}
