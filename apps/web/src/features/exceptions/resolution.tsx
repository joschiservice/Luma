import type { CaseDecision, DecisionReceipt } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import {
  CaseLoading,
  CaseNotice,
} from '@luma/ui/components/issues/case-investigation';
import { ResolutionReview } from '@luma/ui/components/issues/resolution-review';
import { Button } from '@luma/ui/components/primitives/button';
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
    if (lock.current || uncertain || !confirmed || query.isError || !query.data)
      return;
    lock.current = true;
    setPending(true);
    setMessage('');
    setReceipt(undefined);
    let command: CaseDecision | undefined;
    try {
      let review = query.data.review;
      // A refresh in flight may carry a re-evaluated decision. Decide on its result, and approve
      // or reject only if it still shows the change the person reviewed.
      if (query.isFetching) {
        const fresh = (await query.refetch({ cancelRefetch: false })).data;
        if (!fresh) {
          setCheckError(m.exceptions_resolution_check_failed());

          return;
        }
        if (kind !== 'escalate' && !sameResolution(review, fresh.review)) {
          setCheckError(
            m.exceptions_resolution_changed(),
            fresh.review.proposal?.id,
          );

          return;
        }
        review = fresh.review;
      }
      if (kind === 'approve' && review.refreshable) {
        setChecking(true);
        setCheckError('');
        try {
          const current = await refreshResolution(organizationId, exceptionId);
          if (!sameResolution(review, current)) {
            setCheckError(
              m.exceptions_resolution_changed(),
              current.proposal?.id,
            );

            return;
          }
          review = current;
        } catch (error) {
          setCheckError(
            error instanceof Error
              ? error.message
              : m.exceptions_resolution_check_failed(),
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
            m.exceptions_resolution_changed(),
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
          ? m.exceptions_resolution_no_receipt()
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
          : m.exceptions_resolution_check_failed(),
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
        <CaseNotice title={m.exceptions_resolution_offline_title()}>
          {m.exceptions_resolution_offline_text()}
        </CaseNotice>
      ) : null}
      {query.isPending ? <CaseLoading /> : null}
      {query.isError ? (
        <CaseNotice error title={m.exceptions_resolution_unavailable_title()}>
          {denied
            ? decisionError(query.error)
            : m.exceptions_resolution_unavailable_text()}
        </CaseNotice>
      ) : null}
      {message ? (
        <CaseNotice error title={m.exceptions_resolution_message_title()}>
          {message}
        </CaseNotice>
      ) : null}
      {receipt ? (
        <CaseNotice
          title={
            receipt.kind === 'approve'
              ? m.exceptions_receipt_approve_title()
              : receipt.kind === 'reject'
                ? m.exceptions_receipt_reject_title()
                : m.exceptions_receipt_escalate_title()
          }
        >
          {receipt.kind === 'approve'
            ? m.exceptions_receipt_approve_text()
            : receipt.kind === 'reject'
              ? m.exceptions_receipt_reject_text()
              : m.exceptions_receipt_escalate_text()}
        </CaseNotice>
      ) : null}
      {uncertain ? (
        <div className="resolution-actions">
          <Button
            variant="outline"
            disabled={pending || offline}
            onClick={() => void recover()}
          >
            {m.exceptions_resolution_recover()}
          </Button>
          <Button
            variant="outline"
            disabled={pending || offline}
            onClick={() => void recover(true)}
          >
            {m.exceptions_resolution_resend()}
          </Button>
        </div>
      ) : null}
      {checking ? (
        <CaseNotice title={m.exceptions_resolution_checking_title()}>
          {m.exceptions_resolution_checking_text()}
        </CaseNotice>
      ) : null}
      {checkError ? (
        <>
          <CaseNotice error title={m.exceptions_resolution_check_error_title()}>
            {checkError}
          </CaseNotice>
          <div className="resolution-actions">
            <Button
              variant="outline"
              disabled={checking || pending || offline}
              onClick={() => void checkCurrent()}
            >
              {m.exceptions_resolution_check_again()}
            </Button>
          </div>
        </>
      ) : null}
      {expired && !data?.review.refreshable ? (
        <CaseNotice title={m.exceptions_resolution_expired_title()}>
          {m.exceptions_resolution_expired_text()}
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
          onDecision={(kind, reason) => void decide(kind, reason)}
        />
      ) : null}
    </>
  );
}
