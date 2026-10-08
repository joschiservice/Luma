import type { ActivateWorkflow, WorkflowDetail } from '@luma/api-contract';
import { formatList } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { Select } from '@luma/ui/components/primitives/select';
import { useState } from 'react';

import { IdentityError } from '../identity/data';
import { activateWorkflow, workflowError } from './data';

/** Reviews one immutable version and explicit order grants before submitting a retry-safe activation. */
export function ActivationForm({
  organizationId,
  detail,
  version,
  done,
  accessLost,
  cancel,
}: {
  organizationId: string;
  detail: WorkflowDetail;
  version: string;
  done: () => Promise<void>;
  accessLost: () => Promise<void>;
  cancel: () => void;
}) {
  const selected = detail.versions.find((v) => v.version === version)!;
  const [connectionId, setConnectionId] = useState('');
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [reviewedRevision, setReviewedRevision] = useState<string | null>(null);
  const [request, setRequest] = useState<ActivateWorkflow | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const connection = detail.connections.find((c) => c.id === connectionId);
  const revision = JSON.stringify([
    selected.digest,
    detail.policyVersion,
    detail.principalId,
    connectionId,
    connection?.version,
    [...targetIds].sort(),
  ]);
  const reviewed = reviewedRevision === revision;
  const submit = async () => {
    if (!connection || pending || (!request && !reviewed)) return;
    const body = request ?? {
      id: crypto.randomUUID(),
      version,
      reviewedDigest: selected.digest,
      policyVersion: detail.policyVersion,
      connectionId,
      connectionVersion: connection.version,
      targetIds,
      scopeReviewed: true as const,
    };
    setRequest(body);
    setPending(true);
    setError('');
    try {
      await activateWorkflow(organizationId, detail.summary.id, body);
      await done();
    } catch (error) {
      setError(workflowError(error));
      if (
        error instanceof IdentityError &&
        [400, 403, 404, 409].includes(error.status)
      )
        setRequest(null);
      if (error instanceof IdentityError && [401, 403].includes(error.status))
        await accessLost();
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      className="workflow-activation"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="workflow-activation-summary">
        <strong>
          {m.workflows_name_version({ name: detail.summary.name, version })}
        </strong>
        <p>
          <strong>{m.workflows_approval_label()} </strong>
          {detail.summary.readiness.approval.summary}
        </p>
        <ul>
          {detail.summary.readiness.approval.details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
      <fieldset disabled={pending || request !== null}>
        <legend>{m.workflows_activation_scope_legend()}</legend>
        <label>
          {m.workflows_activation_connection()}
          <Select
            aria-label={m.workflows_activation_connection()}
            required
            value={connectionId}
            onValueChange={(value) => {
              setConnectionId(value ?? '');
              setTargetIds([]);
              setReviewedRevision(null);
            }}
            options={[
              {
                value: '',
                label: m.workflows_activation_connection_placeholder(),
              },
              ...detail.connections.map((c) => ({
                value: c.id,
                label: c.blockers.length
                  ? m.workflows_activation_connection_blocked({
                      connection: c.label,
                    })
                  : c.label,
                disabled: c.blockers.length > 0,
              })),
            ]}
          />
        </label>
        {connection ? (
          <fieldset className="workflow-targets">
            <legend>{m.workflows_activation_orders_legend()}</legend>
            {!connection.targets.length ? (
              <p>{m.workflows_activation_no_orders()}</p>
            ) : null}
            {connection.targets.map((target) => (
              <label key={target.id}>
                <input
                  type="checkbox"
                  checked={targetIds.includes(target.id)}
                  disabled={
                    targetIds.length >= 100 && !targetIds.includes(target.id)
                  }
                  onChange={(e) => {
                    setTargetIds((ids) =>
                      e.target.checked
                        ? [...ids, target.id]
                        : ids.filter((id) => id !== target.id),
                    );
                    setReviewedRevision(null);
                  }}
                />{' '}
                <span>
                  {target.label}
                  <small>{target.id}</small>
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}
        <div className="workflow-scope-summary" aria-live="polite">
          <strong>
            {targetIds.length
              ? m.workflows_activation_selected({ count: targetIds.length })
              : m.workflows_activation_selected_none()}
          </strong>
          {targetIds.length && connection ? (
            <p>
              {m.workflows_activation_selected_detail({
                connection: connection.label,
                orders: formatList(
                  connection.targets
                    .filter((target) => targetIds.includes(target.id))
                    .map((target) => target.label),
                ),
              })}
            </p>
          ) : null}
          <p>{m.workflows_activation_limit()}</p>
        </div>
        <label className="workflow-review">
          <input
            type="checkbox"
            required
            disabled={!connection || !targetIds.length}
            checked={reviewed}
            onChange={(e) =>
              setReviewedRevision(e.target.checked ? revision : null)
            }
          />{' '}
          {m.workflows_activation_confirm()}
        </label>
      </fieldset>
      <Disclosure>
        <summary>{m.workflows_activation_details()}</summary>
        <p>
          {m.workflows_activation_details_line({
            policy: detail.policyVersion,
            principal: detail.principalId,
          })}
        </p>
        <code>{selected.digest}</code>
      </Disclosure>
      {reviewedRevision && !reviewed && !request ? (
        <p role="status">{m.workflows_activation_changed()}</p>
      ) : null}
      {error ? (
        <Alert tone="danger" role="alert">
          {error}
        </Alert>
      ) : null}
      {request && !pending ? (
        <p role="status">{m.workflows_activation_kept()}</p>
      ) : null}
      <div className="workflow-dialog-actions">
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={cancel}
        >
          {m.common_cancel()}
        </Button>
        <Button
          type="submit"
          disabled={
            pending ||
            !connection ||
            !targetIds.length ||
            (!request && !reviewed) ||
            !selected.compatible
          }
        >
          {pending
            ? m.workflows_activation_pending()
            : request
              ? m.workflows_activation_retry()
              : m.workflows_activation_submit()}
        </Button>
      </div>
    </form>
  );
}
