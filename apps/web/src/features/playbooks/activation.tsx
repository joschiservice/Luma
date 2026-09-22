import type { ActivatePlaybook, PlaybookDetail } from '@luma/api-contract';
import { Button } from '@luma/ui/button';
import { useState } from 'react';

import { IdentityError } from '../identity/data';
import { activatePlaybook, playbookError } from './data';

/** Reviews one immutable version and explicit order grants before submitting a retry-safe activation. */
export function ActivationForm({
  organizationId,
  detail,
  version,
  done,
  accessLost,
}: {
  organizationId: string;
  detail: PlaybookDetail;
  version: string;
  done: () => Promise<void>;
  accessLost: () => Promise<void>;
}) {
  const selected = detail.versions.find((v) => v.version === version)!;
  const [connectionId, setConnectionId] = useState('');
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [reviewedRevision, setReviewedRevision] = useState<string | null>(null);
  const [request, setRequest] = useState<ActivatePlaybook | null>(null);
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
      await activatePlaybook(organizationId, detail.summary.id, body);
      await done();
    } catch (error) {
      setError(playbookError(error));
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
      className="playbook-activation"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p>
        Version <strong>{version}</strong> · Policy {detail.policyVersion}
      </p>
      <p>{selected.approval}</p>
      <p>
        This grants your principal ({detail.principalId}) permission to request
        changes only for the selected orders.
      </p>
      <fieldset disabled={pending || request !== null}>
        <legend>Connection and order scope</legend>
        <label>
          Connection
          <select
            aria-label="Connection"
            required
            value={connectionId}
            onChange={(e) => {
              setConnectionId(e.target.value);
              setTargetIds([]);
              setReviewedRevision(null);
            }}
          >
            <option value="">Select an eligible connection</option>
            {detail.connections.map((c) => (
              <option key={c.id} value={c.id} disabled={c.blockers.length > 0}>
                {c.label}
                {c.blockers.length ? ' — prerequisites missing' : ''}
              </option>
            ))}
          </select>
        </label>
        {connection ? (
          <fieldset className="playbook-targets">
            <legend>Orders permitted to change</legend>
            {connection.targets.map((target) => (
              <label key={target.id}>
                <input
                  type="checkbox"
                  checked={targetIds.includes(target.id)}
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
        <p>
          {targetIds.length} orders selected. No other resources or future
          orders are granted.
        </p>
        <label className="playbook-review">
          <input
            type="checkbox"
            required
            checked={reviewed}
            onChange={(e) =>
              setReviewedRevision(e.target.checked ? revision : null)
            }
          />{' '}
          I reviewed this version, order scope and approval requirements.
        </label>
      </fieldset>
      <details>
        <summary>Exact reviewed version</summary>
        <code>{selected.digest}</code>
      </details>
      {reviewedRevision && !reviewed && !request ? (
        <p role="status">
          The activation requirements changed. Review them again before
          activating.
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {request && !pending ? (
        <p role="status">
          The request is retained. Retrying uses the same ID and scope.
        </p>
      ) : null}
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
    </form>
  );
}
