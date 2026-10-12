import type { ReturnDeadlinePolicyView } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import {
  returnCaseError,
  returnCaseKey,
  returnDeadlineCommands,
  returnDeadlineOptions,
  uncertainFailure,
} from './case-data';

/** Reads configuration independently of the returns list, including limited visibility and unavailable states. */
export function ReturnDeadlines({
  organizationId,
}: {
  organizationId: string;
}) {
  const query = useQuery(returnDeadlineOptions(organizationId));

  return (
    <details className="returns-deadlines">
      <summary>{m.returns_deadlines_title()}</summary>
      {query.isPending ? (
        <p role="status">{m.returns_case_loading()}</p>
      ) : query.isError ? (
        <Alert>{returnCaseError(query.error)}</Alert>
      ) : (
        <DeadlineForm
          key={query.data.policy?.revision ?? 0}
          organizationId={organizationId}
          data={query.data}
        />
      )}
    </details>
  );
}

function DeadlineForm({
  organizationId,
  data,
}: {
  organizationId: string;
  data: ReturnDeadlinePolicyView;
}) {
  const client = useQueryClient(),
    commands = returnDeadlineCommands(organizationId);
  const [hours, setHours] = useState({
    receiptHours: String(data.policy?.receiptHours ?? 48),
    inspectionHours: String(data.policy?.inspectionHours ?? 24),
    financialHours: String(data.policy?.financialHours ?? 48),
  });
  const [enabled, setEnabled] = useState(data.policy?.enabled ?? false);
  const [request, setRequest] = useState<
    Parameters<typeof commands.configure>[0] | null
  >(null);
  const mutation = useMutation({
    mutationFn: commands.configure,
    onSuccess: () =>
      client.invalidateQueries({ queryKey: returnCaseKey(organizationId) }),
    onError: (error) => {
      if (!uncertainFailure(error)) setRequest(null);
    },
  });
  const fields = [
    ['receiptHours', m.returns_deadlines_receipt],
    ['inspectionHours', m.returns_deadlines_inspection],
    ['financialHours', m.returns_deadlines_financial],
  ] as const;
  const valid = fields.every(
    ([key]) =>
      Number.isSafeInteger(Number(hours[key])) &&
      Number(hours[key]) >= 1 &&
      Number(hours[key]) <= 2160,
  );

  return (
    <form
      className="returns-cell"
      onSubmit={(event) => {
        event.preventDefault();
        const body = request ?? {
          commandId: crypto.randomUUID(),
          expectedRevision: data.policy?.revision ?? 0,
          enabled,
          receiptHours: Number(hours.receiptHours),
          inspectionHours: Number(hours.inspectionHours),
          financialHours: Number(hours.financialHours),
          sourceMaxAgeSeconds: 300,
        };
        setRequest(body);
        mutation.mutate(body);
      }}
    >
      <p>{m.returns_deadlines_description()}</p>
      <label>
        {m.returns_deadlines_enabled()}
        <Select
          aria-label={m.returns_deadlines_enabled()}
          value={enabled ? 'on' : 'off'}
          onValueChange={(v) => setEnabled(v === 'on')}
          disabled={!data.canManage || !!request}
          options={[
            { value: 'off', label: m.returns_deadlines_off() },
            { value: 'on', label: m.returns_deadlines_on() },
          ]}
        />
      </label>
      {fields.map(([key, label]) => (
        <label key={key}>
          {label()}
          <Input
            type="number"
            min={1}
            max={2160}
            step={1}
            required
            value={hours[key]}
            disabled={!data.canManage || !!request}
            onChange={(e) =>
              setHours((old) => ({ ...old, [key]: e.target.value }))
            }
          />
        </label>
      ))}
      {mutation.error ? <Alert>{returnCaseError(mutation.error)}</Alert> : null}
      {data.canManage ? (
        <Button type="submit" disabled={mutation.isPending || !valid}>
          {request ? m.returns_deadlines_retry() : m.returns_deadlines_save()}
        </Button>
      ) : null}
      <Link to="/app/$organizationId/workflows" params={{ organizationId }}>
        {m.returns_deadlines_workflows()}
      </Link>
    </form>
  );
}
