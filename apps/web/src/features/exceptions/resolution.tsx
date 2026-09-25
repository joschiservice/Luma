import type { CaseDecision, DecisionReceipt } from '@luma/api-contract';
import { Button } from '@luma/ui/button';
import {
  CaseLoading,
  CaseNotice,
} from '@luma/ui/components/case-investigation';
import { ResolutionReview } from '@luma/ui/components/resolution-review';
import { useEffect, useRef, useState } from 'react';

import { IdentityError } from '../identity/data';
import type { CaseObservation } from './observation';
import {
  decisionCommand,
  decisionError,
  recoverDecision,
  refreshResolution,
  sameResolution,
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
  const [checking, setChecking] = useState(false);
  const [checkFailure, setCheckFailure] = useState<{
    proposalId: string | undefined;
    message: string;
  }>();
  const checkError =
    checkFailure?.proposalId === query.data?.review.proposal?.id
      ? (checkFailure?.message ?? '')
      : '';

  function setCheckError(
    message: string,
    proposalId = query.data?.review.proposal?.id,
  ) {
    setCheckFailure(message ? { proposalId, message } : undefined);
  }

  const automaticCheck = useRef({ key: '', attempts: 0, retryAt: 0 });
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
      let review = query.data.review;
      if (kind === 'approve' && review.refreshable) {
        setChecking(true);
        setCheckError('');
        try {
          const current = await refreshResolution(organizationId, exceptionId);
          if (!sameResolution(review, current)) {
            setCheckError(
              'The proposed action changed. Review the updated details before approving.',
              current.proposal?.id,
            );

            return;
          }
          review = current;
        } catch (error) {
          setCheckError(
            error instanceof Error
              ? error.message
              : 'Current conditions could not be checked. Try again.',
          );

          return;
        } finally {
          setChecking(false);
        }
      }
      command = decisionCommand(review, kind, reason);
      try {
        setReceipt(await sendDecision(organizationId, exceptionId, command));
      } catch (error) {
        if (
          !(error instanceof IdentityError) ||
          error.status !== 409 ||
          !review.refreshable
        )
          throw error;
        // A rejected version check did not commit. Retry only the same visible action.
        command = undefined;
        const current = await refreshResolution(organizationId, exceptionId);
        if (!sameResolution(review, current)) {
          setCheckError(
            'The proposed action changed. Review the updated details before approving.',
            current.proposal?.id,
          );

          return;
        }
        command = decisionCommand(current, kind, reason);
        setReceipt(await sendDecision(organizationId, exceptionId, command));
      }
    } catch (error) {
      setMessage(
        !command && error instanceof Error
          ? error.message
          : decisionError(error),
      );
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
  const awaitingDecision =
    (!proposal?.approval || data?.review.refreshable) &&
    !data?.progress.execution &&
    !['resolved', 'escalated'].includes(data?.progress.state ?? '');
  const expired =
    awaitingDecision &&
    proposal &&
    Math.min(
      Date.parse(proposal.expiresAt),
      Date.parse(proposal.preconditions.validUntil),
    ) <= query.dataUpdatedAt;
  const needsCheck =
    awaitingDecision &&
    proposal &&
    Math.min(
      Date.parse(proposal.expiresAt),
      Date.parse(proposal.preconditions.validUntil),
    ) <=
      query.dataUpdatedAt + 60_000;

  async function checkCurrent() {
    if (lock.current || offline || !confirmed) return;
    lock.current = true;
    setChecking(true);
    setCheckError('');
    try {
      await refreshResolution(organizationId, exceptionId);
    } catch (error) {
      if (!(error instanceof IdentityError) || error.status !== 503)
        automaticCheck.current.attempts = 3;
      automaticCheck.current.retryAt = Date.now() + 15_000;
      setCheckError(
        error instanceof Error
          ? error.message
          : 'Current conditions could not be checked. Try again.',
      );
    } finally {
      await refresh();
      setChecking(false);
      lock.current = false;
    }
  }

  useEffect(() => {
    if (!needsCheck || !data?.review.refreshable || !confirmed || lock.current)
      return;
    const key = `${organizationId}:${exceptionId}:${proposal?.id}`;
    if (automaticCheck.current.key !== key)
      automaticCheck.current = { key, attempts: 0, retryAt: 0 };
    if (
      automaticCheck.current.attempts >= 3 ||
      Date.now() < automaticCheck.current.retryAt
    )
      return;
    automaticCheck.current.attempts++;
    void checkCurrent();
  });

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
            ? 'This acknowledges your decision. Execution and verification are tracked separately.'
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
      {checking ? (
        <CaseNotice title="Checking current conditions">
          We’re checking the latest facts before you continue.
        </CaseNotice>
      ) : null}
      {checkError ? (
        <>
          <CaseNotice error title="Review needs attention">
            {checkError}
          </CaseNotice>
          <div className="resolution-actions">
            <Button
              variant="outline"
              disabled={checking || pending || offline}
              onClick={() => void checkCurrent()}
            >
              Retry checks
            </Button>
          </div>
        </>
      ) : null}
      {expired && !data?.review.refreshable ? (
        <CaseNotice title="Approval window expired">
          The proposal or its supporting evidence has expired. Approval requires
          a new proposal based on fresh evidence. Refreshing this page does not
          extend the approval window.
        </CaseNotice>
      ) : null}
      {data ? (
        <ResolutionReview
          review={
            expired || checkError
              ? {
                  ...data.review,
                  permittedDecisions: data.review.permittedDecisions.filter(
                    (kind) =>
                      kind === 'escalate' || (!expired && kind === 'reject'),
                  ),
                }
              : data.review
          }
          progress={data.progress}
          connectionLabel={
            proposal ? connectionLabels[proposal.connectionId] : undefined
          }
          disabled={!confirmed || query.isError || Boolean(uncertain)}
          pending={pending || checking}
          checking={checking}
          refreshing={query.isFetching}
          onDecision={(kind, reason) => void decide(kind, reason)}
        />
      ) : null}
    </>
  );
}
