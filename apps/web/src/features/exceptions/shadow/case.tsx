import '../../workflows/shadow/shadow.css';

import { m } from '@luma/i18n/messages';
import { CaseNotice } from '@luma/ui/components/issues/case-investigation';
import { Button } from '@luma/ui/components/primitives/button';
import { Card, CardTitle } from '@luma/ui/components/primitives/card';
import { Field, FieldLabel } from '@luma/ui/components/primitives/field';
import { RefreshButton } from '@luma/ui/components/primitives/refresh-button';
import { Select } from '@luma/ui/components/primitives/select';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useRef, useState } from 'react';

import { ApiError, contextOptions } from '../../../kit/identity/data';
import { useCan } from '../../../kit/identity/permissions';
import { resolutionWorkflowsOptions } from '../../workflows/data';
import {
  evaluateShadow,
  shadowAccessDenied,
  shadowError,
  shadowKey,
  shadowLatestOptions,
} from '../../workflows/shadow/data';
import { ShadowResult } from '../../workflows/shadow/result';
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
      aria-label={m.shadow_case_title()}
    >
      <CardTitle as="h3">{m.shadow_case_title()}</CardTitle>
      <p>{m.shadow_case_description()}</p>
      {context.isPending ? (
        <p role="status">{m.shadow_case_checking_access()}</p>
      ) : !canManage ? (
        <p>
          {context.error ? shadowError(context.error) : m.shadow_error_role()}
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
      if (error instanceof ApiError && error.status < 500)
        setRequest(undefined);
    } finally {
      lock.current = false;
      setPending(false);
    }
  }

  if (denied)
    return (
      <CaseNotice error title={m.shadow_case_denied_title()}>
        {shadowError(denied)}
      </CaseNotice>
    );
  if (books.isPending)
    return <p role="status">{m.shadow_case_workflows_loading()}</p>;
  if (books.error)
    return (
      <CaseNotice error title={m.shadow_case_workflows_failed()}>
        <Button variant="outline" onClick={() => void books.refetch()}>
          {m.common_retry()}
        </Button>
      </CaseNotice>
    );
  if (!books.data?.length) return <p>{m.shadow_case_workflows_empty()}</p>;

  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${id}-workflow`}>
          {m.shadow_case_workflow_label()}
        </FieldLabel>
        <Select
          id={`${id}-workflow`}
          aria-label={m.shadow_case_workflow_label()}
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
      <p className="shadow-meta">{m.shadow_case_inputs_hint()}</p>
      <div className="shadow-actions">
        <Button
          disabled={pending || disabled || latest.isPending || latest.isError}
          onClick={() => void evaluate()}
        >
          {pending
            ? m.shadow_case_running()
            : request
              ? m.shadow_case_retry()
              : m.shadow_case_run()}
        </Button>
        <RefreshButton
          label={m.shadow_case_refresh()}
          refreshing={latest.isFetching}
          disabled={pending}
          onClick={() => void refresh()}
        />
        <Link
          to="/app/$organizationId/workflows/$definitionId"
          params={{ organizationId, definitionId: workflow }}
          hash="shadow-report"
        >
          {m.shadow_case_compare_link()}
        </Link>
      </div>
      {error ? <p role="alert">{shadowError(error)}</p> : null}
      {latest.error ? (
        <CaseNotice error title={m.shadow_case_results_failed()}>
          {shadowError(latest.error)}
        </CaseNotice>
      ) : latest.isPending ? (
        <p role="status">{m.shadow_case_results_loading()}</p>
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
        <p>{m.shadow_case_results_empty()}</p>
      )}
    </>
  );
}
