import type { ActivateWorkflow, WorkflowDetail } from '@luma/api-contract';
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
          {detail.summary.name} · v{version}
        </strong>
        <p>
          <strong>Approval: </strong>
          {detail.summary.readiness.approval.summary}
        </p>
        <ul>
          {detail.summary.readiness.approval.details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
      <fieldset disabled={pending || request !== null}>
        <legend>Connection and order scope</legend>
        <label>
          Connection
          <Select
            aria-label="Connection"
            required
            value={connectionId}
            onValueChange={(value) => {
              setConnectionId(value ?? '');
              setTargetIds([]);
              setReviewedRevision(null);
            }}
            options={[
              { value: '', label: 'Select an eligible connection' },
              ...detail.connections.map((c) => ({
                value: c.id,
                label: `${c.label}${c.blockers.length ? ' — prerequisites missing' : ''}`,
                disabled: c.blockers.length > 0,
              })),
            ]}
          />
        </label>
        {connection ? (
          <fieldset className="workflow-targets">
            <legend>Orders permitted to change</legend>
            {!connection.targets.length ? (
              <p>
                No eligible orders on this connection. Choose another connection
                or sync orders before activating.
              </p>
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
            {targetIds.length} {targetIds.length === 1 ? 'order' : 'orders'}{' '}
            selected
          </strong>
          {targetIds.length ? (
            <p>
              {connection?.label} ·{' '}
              {connection?.targets
                .filter((target) => targetIds.includes(target.id))
                .map((target) => target.label)
                .join(', ')}
            </p>
          ) : null}
          <p>
            Select up to 100 orders. Other resources and future orders are not
            included.
          </p>
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
          I reviewed this version, order scope and approval requirements.
        </label>
      </fieldset>
      <Disclosure>
        <summary>Version and access details</summary>
        <p>
          Policy {detail.policyVersion} · Principal {detail.principalId}
        </p>
        <code>{selected.digest}</code>
      </Disclosure>
      {reviewedRevision && !reviewed && !request ? (
        <p role="status">
          The activation requirements changed. Review them again before
          activating.
        </p>
      ) : null}
      {error ? (
        <Alert tone="danger" role="alert">
          {error}
        </Alert>
      ) : null}
      {request && !pending ? (
        <p role="status">
          The request is retained. Retrying uses the same ID and scope.
        </p>
      ) : null}
      <div className="workflow-dialog-actions">
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={cancel}
        >
          Cancel
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
            ? 'Confirming activation…'
            : request
              ? 'Retry same activation'
              : 'Activate reviewed version'}
        </Button>
      </div>
    </form>
  );
}
