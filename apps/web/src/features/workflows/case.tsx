import type {
  ActivateCaseWorkflow,
  WorkflowActivationView,
  WorkflowDetail,
  WorkflowRunView,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
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
import { personLabel } from '@luma/ui/lib/actor';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Power } from 'lucide-react';
import { useState } from 'react';

import { IdentityError } from '../../kit/identity/data';
import {
  activateCaseWorkflow,
  revokeWorkflow,
  workflowError,
  workflowsKey,
} from './data';

/** Says which new cases start a run; the issue type is the server's code with spaces. */
const startsDescription = (detail: WorkflowDetail) => {
  const trigger = detail.versions[0]?.applicability.trigger;

  return trigger?.kind === 'exception'
    ? m.workflows_case_starts_issue({
        issue: trigger.issueType.replaceAll('_', ' '),
      })
    : m.workflows_case_starts_matching();
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
          {m.workflows_name_version({
            name: detail.summary.name,
            version: version.version,
          })}
        </strong>
        <p>{startsDescription(detail)}</p>
        <p>
          <strong>{m.workflows_approval_label()} </strong>
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
        {m.workflows_case_confirm()}
      </label>
      <Disclosure>
        <summary>{m.workflows_case_details()}</summary>
        <p>
          {m.workflows_case_details_line({
            policy: detail.policyVersion,
            principal: personLabel(detail.people, detail.principalId),
          })}
        </p>
        <code>{version.digest}</code>
      </Disclosure>
      {error ? (
        <Alert tone="danger" role="alert">
          {error}
        </Alert>
      ) : null}
      {request && !pending ? (
        <p role="status">{m.workflows_case_kept()}</p>
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
          disabled={pending || (!request && !reviewed) || !version.compatible}
        >
          {pending
            ? m.workflows_case_turning_on()
            : request
              ? m.common_retry()
              : m.workflows_case_turn_on()}
        </Button>
      </div>
    </form>
  );
}

/**
 * Turns a case workflow on or off for people with permission to enable workflows, after they
 * review its version and approval behavior. Reports the result through `notify`.
 */
export function CaseWorkflowAction({
  organizationId,
  detail,
  notify,
}: {
  organizationId: string;
  detail: WorkflowDetail;
  notify: (message: string) => void;
}) {
  const client = useQueryClient();
  const [activating, setActivating] = useState(false);
  const [revoking, setRevoking] = useState<WorkflowActivationView | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const active = detail.activations.find((item) => item.active);
  const blocked = detail.summary.readiness.state === 'blocked';
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
      notify(m.workflows_case_turned_off());
      await client.invalidateQueries({
        queryKey: workflowsKey(organizationId),
      });
    } catch (failure) {
      setError(workflowError(failure));
    } finally {
      setPending(false);
    }
  };
  if (!detail.canManage) return null;

  return (
    <>
      {active ? (
        <Button
          variant="outline"
          onClick={() => {
            setRevoking(active);
            setError('');
          }}
        >
          <Power aria-hidden="true" />
          {m.workflows_case_turn_off()}
        </Button>
      ) : (
        <Button
          disabled={blocked}
          title={blocked ? m.workflows_case_blocked() : undefined}
          onClick={() => setActivating(true)}
        >
          <Power aria-hidden="true" />
          {m.workflows_case_turn_on()}
        </Button>
      )}
      <Dialog
        open={activating}
        onOpenChange={(open) => {
          if (!open) setActivating(false);
        }}
      >
        <DialogContent className="workflow-dialog">
          <DialogTitle>
            {m.workflows_case_dialog_title({ name: detail.summary.name })}
          </DialogTitle>
          <DialogDescription>
            {m.workflows_case_dialog_description()}
          </DialogDescription>
          <CaseActivationForm
            organizationId={organizationId}
            detail={detail}
            cancel={() => setActivating(false)}
            done={async () => {
              setActivating(false);
              notify(m.workflows_case_turned_on());
            }}
          />
        </DialogContent>
      </Dialog>
      <Dialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setRevoking(null);
        }}
      >
        <DialogContent className="workflow-dialog">
          <DialogTitle>{m.workflows_case_off_title()}</DialogTitle>
          <DialogDescription>
            {m.workflows_case_off_description()}
          </DialogDescription>
          {error ? <p role="alert">{error}</p> : null}
          <div className="workflow-dialog-actions">
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setRevoking(null)}
            >
              {m.common_cancel()}
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => void revoke()}
            >
              {pending
                ? m.workflows_case_turning_off()
                : m.workflows_case_turn_off()}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Shows whether a case workflow is on and as whom, which cases start it, and why it can't be
 * turned on yet. The page header holds the control that turns it on or off.
 */
export function CaseWorkflowPanel({ detail }: { detail: WorkflowDetail }) {
  const active = detail.activations.find((item) => item.active);
  const blocked = detail.summary.readiness.state === 'blocked';

  return (
    <Card
      as="section"
      className="workflow-section"
      aria-labelledby="case-title"
    >
      <CardTitle id="case-title">{m.workflows_case_title()}</CardTitle>
      <p>{detail.summary.readiness.coverage.explanation}</p>
      <p>{detail.summary.readiness.approval.summary}</p>
      <div className="workflow-case-status" role="status">
        {active ? (
          <>
            <StatePill state="running">{m.workflows_case_on()}</StatePill>
            <span>
              {active.reviewedBy === detail.principalId
                ? active.reviewedAt
                  ? rich(m.workflows_case_mine_since, {
                      date: <WorkspaceDate value={active.reviewedAt} />,
                    })
                  : m.workflows_case_mine()
                : !active.reviewedBy
                  ? m.workflows_case_other()
                  : active.reviewedAt
                    ? rich(m.workflows_case_other_named_since, {
                        person: personLabel(detail.people, active.reviewedBy),
                        date: <WorkspaceDate value={active.reviewedAt} />,
                      })
                    : m.workflows_case_other_named({
                        person: personLabel(detail.people, active.reviewedBy),
                      })}
            </span>
          </>
        ) : (
          <>
            <StatePill state="idle">{m.workflows_case_off()}</StatePill>
            <span>{m.workflows_case_off_help()}</span>
          </>
        )}
      </div>
      {!detail.canManage ? (
        <p>{m.workflows_case_cannot_manage()}</p>
      ) : !active && blocked ? (
        <Alert tone="warning">{m.workflows_case_blocked()}</Alert>
      ) : null}
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
          {m.workflows_case_open_issue()}
        </Link>
      ) : null}
      {run.processState === 'awaiting_decision' ? (
        <Link to="/app/$organizationId/needs-you" params={{ organizationId }}>
          {m.workflows_case_review_needs_you()}
        </Link>
      ) : null}
    </p>
  );
}
