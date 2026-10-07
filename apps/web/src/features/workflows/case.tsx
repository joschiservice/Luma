import type {
  ActivateCaseWorkflow,
  WorkflowActivationView,
  WorkflowDetail,
  WorkflowRunView,
} from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Card, CardTitle } from '@luma/ui/components/primitives/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { IdentityError } from '../identity/data';
import {
  activateCaseWorkflow,
  revokeWorkflow,
  workflowError,
  workflowsKey,
} from './data';

const issueLabel = (detail: WorkflowDetail) => {
  const trigger = detail.versions[0]?.applicability.trigger;

  return trigger?.kind === 'exception'
    ? trigger.issueType.replaceAll('_', ' ')
    : 'matching';
};

/**
 * Reviews a case workflow's version and approval behavior, then turns it on for the workspace as
 * the signed-in person. Retrying after an uncertain response reuses the same request.
 */
export function CaseActivationForm({
  organizationId,
  detail,
  done,
  cancel,
}: {
  organizationId: string;
  detail: WorkflowDetail;
  done: () => Promise<void>;
  cancel: () => void;
}) {
  const version = detail.versions[0]!;
  const client = useQueryClient();
  const [reviewed, setReviewed] = useState(false);
  const [request, setRequest] = useState<ActivateCaseWorkflow | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const approval = detail.summary.readiness.approval;
  const submit = async () => {
    if (pending || (!request && !reviewed)) return;
    const body = request ?? {
      id: crypto.randomUUID(),
      version: version.version,
      reviewedDigest: version.digest,
      policyVersion: detail.policyVersion,
      scopeReviewed: true as const,
    };
    setRequest(body);
    setPending(true);
    setError('');
    try {
      await activateCaseWorkflow(organizationId, detail.summary.id, body);
      await client.invalidateQueries({
        queryKey: workflowsKey(organizationId),
      });
      await done();
    } catch (failure) {
      setError(workflowError(failure));
      if (
        failure instanceof IdentityError &&
        [400, 403, 404, 409].includes(failure.status)
      )
        setRequest(null);
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      className="workflow-activation"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="workflow-activation-summary">
        <strong>
          {detail.summary.name} · v{version.version}
        </strong>
        <p>
          Luma starts a run for each new {issueLabel(detail)} case that
          detection confirms. Runs act as you.
        </p>
        <p>
          <strong>Approval: </strong>
          {approval.summary}
        </p>
        <ul>
          {approval.details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
      <label className="workflow-review">
        <input
          type="checkbox"
          disabled={pending || request !== null}
          checked={reviewed || request !== null}
          onChange={(event) => setReviewed(event.target.checked)}
        />{' '}
        I reviewed this version and who approves its changes.
      </label>
      <Disclosure>
        <summary>Version details</summary>
        <p>
          Policy {detail.policyVersion} · Runs as {detail.principalId}
        </p>
        <code>{version.digest}</code>
      </Disclosure>
      {error ? (
        <Alert tone="danger" role="alert">
          {error}
        </Alert>
      ) : null}
      {request && !pending ? (
        <p role="status">
          The request is kept. Retrying sends the same request.
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
          disabled={pending || (!request && !reviewed) || !version.compatible}
        >
          {pending ? 'Turning on…' : request ? 'Retry' : 'Turn on'}
        </Button>
      </div>
    </form>
  );
}

/** Shows whether a case workflow is on, as whom, and lets owners and admins turn it on or off. */
export function CaseWorkflowPanel({
  organizationId,
  detail,
}: {
  organizationId: string;
  detail: WorkflowDetail;
}) {
  const client = useQueryClient();
  const [activating, setActivating] = useState(false);
  const [revoking, setRevoking] = useState<WorkflowActivationView | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const active = detail.activations.find((item) => item.active);
  const blocked = detail.summary.readiness.state === 'blocked';
  const refresh = () =>
    client.invalidateQueries({ queryKey: workflowsKey(organizationId) });
  const revoke = async () => {
    if (!revoking || pending) return;
    setPending(true);
    setError('');
    try {
      await revokeWorkflow(
        organizationId,
        detail.summary.id,
        revoking.id,
        revoking.artifactDigest,
      );
      setRevoking(null);
      setMessage(
        'Turned off. No new runs start; runs already waiting send no new change.',
      );
      await refresh();
    } catch (failure) {
      setError(workflowError(failure));
    } finally {
      setPending(false);
    }
  };

  return (
    <Card
      as="section"
      className="workflow-section"
      aria-labelledby="case-title"
    >
      <CardTitle id="case-title">When it runs</CardTitle>
      <p>
        {detail.summary.readiness.coverage.explanation} Every change waits for
        approval by a different owner or admin.
      </p>
      {message ? (
        <Alert tone="success" role="status">
          {message}
        </Alert>
      ) : null}
      <div className="workflow-case-status" role="status">
        {active ? (
          <>
            <StatePill state="running">On</StatePill>
            <span>
              Runs as{' '}
              {active.reviewedBy === detail.principalId
                ? 'you'
                : 'the owner or admin who turned it on'}
              {active.reviewedAt ? (
                <>
                  {' '}
                  since <WorkspaceDate value={active.reviewedAt} />
                </>
              ) : null}
            </span>
          </>
        ) : (
          <>
            <StatePill state="idle">Off</StatePill>
            <span>No new case starts this workflow.</span>
          </>
        )}
      </div>
      {!detail.canManage ? (
        <p>
          Only workspace owners and admins can turn this workflow on or off.
        </p>
      ) : active ? (
        <Button
          variant="outline"
          onClick={() => {
            setRevoking(active);
            setError('');
          }}
        >
          Turn off
        </Button>
      ) : (
        <>
          {blocked ? (
            <Alert tone="warning" id="case-activation-reason">
              Fix the issues in Overview before turning this workflow on.
            </Alert>
          ) : null}
          <Button
            disabled={blocked}
            aria-describedby={blocked ? 'case-activation-reason' : undefined}
            onClick={() => setActivating(true)}
          >
            Turn on
          </Button>
        </>
      )}
      <Dialog
        open={activating && detail.canManage}
        onOpenChange={(open) => {
          if (!open) setActivating(false);
        }}
      >
        <DialogContent className="workflow-dialog">
          <DialogTitle>Turn on “{detail.summary.name}”?</DialogTitle>
          <DialogDescription>
            Review what starts a run and who approves its changes.
          </DialogDescription>
          <CaseActivationForm
            organizationId={organizationId}
            detail={detail}
            cancel={() => setActivating(false)}
            done={async () => {
              setActivating(false);
              setMessage('Turned on. New cases now start a run.');
            }}
          />
        </DialogContent>
      </Dialog>
      <Dialog
        open={revoking !== null && detail.canManage}
        onOpenChange={(open) => {
          if (!open && !pending) setRevoking(null);
        }}
      >
        <DialogContent className="workflow-dialog">
          <DialogTitle>Turn off this workflow?</DialogTitle>
          <DialogDescription>
            New cases won’t start a run. Runs already waiting can finish
            checking earlier changes but send no new change. Nothing already
            changed is undone.
          </DialogDescription>
          {error ? <p role="alert">{error}</p> : null}
          <div className="workflow-dialog-actions">
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setRevoking(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => void revoke()}
            >
              {pending ? 'Turning off…' : 'Turn off'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** Links a case run to its issue and, while it waits for approval, to Needs you. */
export function CaseRunContext({
  organizationId,
  run,
}: {
  organizationId: string;
  run: WorkflowRunView;
}) {
  const caseId = run.triggerEvidence?.sourceId;

  return (
    <p className="workflow-case-links">
      {caseId ? (
        <Link
          to="/app/$organizationId/exceptions/$exceptionId"
          params={{ organizationId, exceptionId: caseId }}
        >
          Open issue
        </Link>
      ) : null}
      {run.processState === 'awaiting_decision' ? (
        <Link to="/app/$organizationId/needs-you" params={{ organizationId }}>
          Review in Needs you
        </Link>
      ) : null}
    </p>
  );
}
