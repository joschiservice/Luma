import './shadow.css';

import { CaseNotice } from '@luma/ui/components/issues/case-investigation';
import { Button } from '@luma/ui/components/primitives/button';
import { Card, CardTitle } from '@luma/ui/components/primitives/card';
import { Field, FieldLabel } from '@luma/ui/components/primitives/field';
import { Select } from '@luma/ui/components/primitives/select';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useRef, useState } from 'react';

import { contextOptions, IdentityError } from '../identity/data';
import { useCan } from '../identity/permissions';
import { resolutionWorkflowsOptions } from '../workflows/data';
import {
  evaluateShadow,
  shadowAccessDenied,
  shadowError,
  shadowKey,
  shadowLatestOptions,
} from './data';
import { ShadowResult } from './result';
import { ShadowReviewForm } from './review';

/** Adds Shadow evaluation to a case for authorized operators, with isolated per-case state. */
export function CaseShadow({
  organizationId,
  exceptionId,
  initialWorkflow,
  disabled,
  embedded = false,
}: {
  organizationId: string;
  exceptionId: string;
  initialWorkflow?: string | undefined;
  disabled?: boolean | undefined;
  embedded?: boolean;
}) {
  const context = useQuery(contextOptions(organizationId));
  const canManage = useCan(organizationId, 'playbooks.activate');

  return (
    <Card
      as="section"
      className="shadow-panel"
      variant={embedded ? 'plain' : 'default'}
      id="shadow"
      aria-label="Shadow evaluation"
    >
      <CardTitle as="h3">Shadow evaluation</CardTitle>
      <p>
        Preview a Workflow against the retained case evidence. No action is
        executed.
      </p>
      {context.isPending ? (
        <p role="status">Checking access…</p>
      ) : !canManage ? (
        <p>
          {context.error
            ? shadowError(context.error)
            : 'Your role doesn’t include Activate playbooks, so you can’t evaluate or review Shadow predictions.'}
        </p>
      ) : (
        <ShadowCaseControls
          key={`${organizationId}:${exceptionId}:${context.data?.actor.id}`}
          organizationId={organizationId}
          exceptionId={exceptionId}
          initialWorkflow={initialWorkflow}
          disabled={disabled}
        />
      )}
    </Card>
  );
}

function ShadowCaseControls({
  organizationId,
  exceptionId,
  initialWorkflow,
  disabled,
}: {
  organizationId: string;
  exceptionId: string;
  initialWorkflow?: string | undefined;
  disabled?: boolean | undefined;
}) {
  const id = useId();
  const books = useQuery(resolutionWorkflowsOptions(organizationId));
  const [selected, setSelected] = useState(initialWorkflow ?? '');
  const workflow = books.data?.some((item) => item.id === selected)
    ? selected
    : (books.data?.[0]?.id ?? '');
  const latest = useQuery(
    shadowLatestOptions(organizationId, exceptionId, workflow),
  );
  const client = useQueryClient();
  const [request, setRequest] = useState<{ id: string; workflow: string }>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const lock = useRef(false);
  const denied = [books.error, latest.error, error].find(shadowAccessDenied);
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: shadowKey(organizationId) });
  };

  async function evaluate() {
    if (lock.current || !workflow || disabled) return;
    lock.current = true;
    setPending(true);
    setError(undefined);
    const command = request ?? { id: crypto.randomUUID(), workflow };
    setRequest(command);
    try {
      await evaluateShadow(organizationId, exceptionId, command);
      setRequest(undefined);
      await refresh();
    } catch (error) {
      setError(error);
      if (error instanceof IdentityError && error.status < 500)
        setRequest(undefined);
    } finally {
      lock.current = false;
      setPending(false);
    }
  }

  if (denied)
    return (
      <CaseNotice error title="Shadow access unavailable">
        {shadowError(denied)}
      </CaseNotice>
    );
  if (books.isPending) return <p role="status">Loading Workflows…</p>;
  if (books.error)
    return (
      <CaseNotice error title="Workflows unavailable">
        <Button variant="outline" onClick={() => void books.refetch()}>
          Retry Workflows
        </Button>
      </CaseNotice>
    );
  if (!books.data?.length)
    return <p>Publish a Workflow before evaluating this case.</p>;

  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${id}-workflow`}>Workflow to evaluate</FieldLabel>
        <Select
          id={`${id}-workflow`}
          aria-label="Workflow to evaluate"
          value={workflow}
          disabled={pending || !!request}
          onValueChange={(value) => {
            setSelected(value ?? '');
            setError(undefined);
          }}
          options={books.data.map((book) => ({
            value: book.id,
            label: book.name,
          }))}
        />
      </Field>
      <p className="shadow-meta">
        Uses the current diagnosis and bound candidate. Missing or stale
        candidates are recorded without a passing prediction.
      </p>
      <div className="shadow-actions">
        <Button
          disabled={pending || disabled || latest.isPending || latest.isError}
          onClick={() => void evaluate()}
        >
          {pending
            ? 'Evaluating…'
            : request
              ? 'Retry evaluation'
              : 'Run Shadow evaluation'}
        </Button>
        <Button
          variant="outline"
          disabled={pending || latest.isFetching}
          onClick={() => void refresh()}
        >
          Refresh results
        </Button>
        <Link
          to="/app/$organizationId/workflows/$definitionId"
          params={{ organizationId, definitionId: workflow }}
          hash="shadow-report"
        >
          Compare cases
        </Link>
      </div>
      {error ? <p role="alert">{shadowError(error)}</p> : null}
      {latest.error ? (
        <CaseNotice error title="Shadow results unavailable">
          {shadowError(latest.error)}
        </CaseNotice>
      ) : latest.isPending ? (
        <p role="status">Loading the latest evaluation…</p>
      ) : latest.data ? (
        <>
          <ShadowResult item={latest.data} />
          {!latest.data.review && !disabled ? (
            <ShadowReviewForm
              key={latest.data.evaluation.id}
              organizationId={organizationId}
              evaluation={latest.data.evaluation}
              saved={refresh}
              accessLost={setError}
            />
          ) : null}
        </>
      ) : (
        <p>
          No Shadow evaluation has been recorded for this case and Workflow.
        </p>
      )}
    </>
  );
}
