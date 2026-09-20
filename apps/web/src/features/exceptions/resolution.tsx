import type { CaseDecision, DecisionReceipt } from '@luma/api-contract';
import { Button } from '@luma/ui/button';
import {
  CaseLoading,
  CaseNotice,
} from '@luma/ui/components/case-investigation';
import { ResolutionReview } from '@luma/ui/components/resolution-review';
import { useRef, useState } from 'react';

import { IdentityError } from '../identity/data';
import type { CaseObservation } from './observation';
import {
  decisionCommand,
  decisionError,
  recoverDecision,
  sendDecision,
} from './resolution-data';

/**
 * Presents permitted case decisions and recovers uncertain submissions through their
 * recorded receipts.
 */
export function CaseResolution({
  organizationId,
  exceptionId,
  connectionLabels,
  observation,
}: {
  organizationId: string;
  exceptionId: string;
  connectionLabels: Record<string, string>;
  observation: CaseObservation;
}) {
  const { snapshot: query, confirmed, offline, denied } = observation;
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState<CaseDecision>();
  const [message, setMessage] = useState('');
  const [receipt, setReceipt] = useState<DecisionReceipt>();
  const refresh = () =>
    observation.refresh().catch(() => {
      /* Query state presents refresh failures. */
    });

  async function decide(kind: CaseDecision['kind'], reason: string) {
    if (
      lock.current ||
      uncertain ||
      !confirmed ||
      query.isError ||
      query.isFetching ||
      !query.data
    )
      return;
    lock.current = true;
    setPending(true);
    setMessage('');
    setReceipt(undefined);
    let command: CaseDecision | undefined;
    try {
      command = decisionCommand(query.data.review, kind, reason);
      setReceipt(await sendDecision(organizationId, exceptionId, command));
    } catch (error) {
      setMessage(decisionError(error));
      // A transport or server failure may occur after the transaction commits.
      if (
        command &&
        !(
          error instanceof IdentityError &&
          [400, 401, 403, 404, 409].includes(error.status)
        )
      ) {
        setUncertain(command);
        try {
          setReceipt(
            await recoverDecision(
              organizationId,
              exceptionId,
              command.commandId,
            ),
          );
          setUncertain(undefined);
          setMessage('');
        } catch {
          /* Keep decisions blocked until the receipt can be recovered. */
        }
      }
    } finally {
      await refresh();
      setPending(false);
      lock.current = false;
    }
  }

  async function recover(retry = false) {
    if (!uncertain || lock.current || offline) return;
    lock.current = true;
    setPending(true);
    try {
      setReceipt(
        retry
          ? await sendDecision(organizationId, exceptionId, uncertain)
          : await recoverDecision(
              organizationId,
              exceptionId,
              uncertain.commandId,
            ),
      );
      setUncertain(undefined);
      setMessage('');
    } catch (error) {
      if (
        retry &&
        error instanceof IdentityError &&
        [400, 401, 403, 404, 409].includes(error.status)
      )
        setUncertain(undefined);
      setMessage(
        !retry && error instanceof IdentityError && error.status === 404
          ? 'No receipt is available yet. The request may still be processing. Check again before taking another action.'
          : decisionError(error),
      );
    } finally {
      await refresh();
      setPending(false);
      lock.current = false;
    }
  }

  const data = denied ? undefined : query.data;
  const proposal = data?.review.proposal;
  const expired =
    proposal &&
    Math.min(
      Date.parse(proposal.expiresAt),
      Date.parse(proposal.preconditions.validUntil),
    ) <= query.dataUpdatedAt;

  return (
    <>
      {offline ? (
        <CaseNotice title="You’re offline">
          Decisions are paused until the current case can be confirmed.
        </CaseNotice>
      ) : null}
      {query.isPending ? <CaseLoading /> : null}
      {query.isError ? (
        <CaseNotice error title="Resolution review unavailable">
          {denied
            ? decisionError(query.error)
            : 'Current policy and progress could not be confirmed. Refresh before making a decision.'}
        </CaseNotice>
      ) : null}
      {message ? (
        <CaseNotice error title="Decision needs attention">
          {message}
        </CaseNotice>
      ) : null}
      {receipt ? (
        <CaseNotice
          title={
            receipt.kind === 'approve'
              ? 'Approval recorded'
              : receipt.kind === 'reject'
                ? 'Rejection recorded'
                : 'Escalation recorded'
          }
        >
          {receipt.kind === 'approve'
            ? 'This acknowledges your decision. Execution and verification are tracked separately below.'
            : receipt.kind === 'reject'
              ? 'The proposal was rejected. The case remains open for follow-up.'
              : 'The case was escalated for further review.'}
        </CaseNotice>
      ) : null}
      {uncertain ? (
        <div className="resolution-actions">
          <Button
            variant="outline"
            disabled={pending || offline}
            onClick={() => void recover()}
          >
            Check recorded decision
          </Button>
          <Button
            variant="outline"
            disabled={pending || offline}
            onClick={() => void recover(true)}
          >
            Retry same decision
          </Button>
        </div>
      ) : null}
      {expired ? (
        <CaseNotice title="Review needs refreshing">
          The proposal expired or the case changed. Refresh to load current
          decisions.
        </CaseNotice>
      ) : null}
      {data ? (
        <ResolutionReview
          review={
            expired
              ? {
                  ...data.review,
                  permittedDecisions: data.review.permittedDecisions.filter(
                    (kind) => kind === 'escalate',
                  ),
                }
              : data.review
          }
          progress={data.progress}
          connectionLabel={
            proposal ? connectionLabels[proposal.connectionId] : undefined
          }
          disabled={!confirmed || query.isError || Boolean(uncertain)}
          pending={pending}
          refreshing={query.isFetching}
          onDecision={(kind, reason) => void decide(kind, reason)}
        />
      ) : null}
    </>
  );
}
