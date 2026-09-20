import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CaseDecision, DecisionReceipt } from '@luma/api-contract';
import { ResolutionReview } from '@luma/ui/components/resolution-review';
import {
  CaseLoading,
  CaseNotice,
} from '@luma/ui/components/case-investigation';
import { Button } from '@luma/ui/button';
import { IdentityError } from '../identity/data';
import { casesKey } from './data';
import {
  decisionCommand,
  decisionError,
  recoverDecision,
  resolutionOptions,
  sendDecision,
} from './resolution-data';

export function CaseResolution({
  organizationId,
  exceptionId,
  connectionLabels,
  disabled = false,
}: {
  organizationId: string;
  exceptionId: string;
  connectionLabels: Record<string, string>;
  disabled?: boolean;
}) {
  const client = useQueryClient();
  const query = useQuery(resolutionOptions(organizationId, exceptionId));
  const revision = query.data?.progress.caseRevision;
  const state = query.data?.progress.state;
  useEffect(() => {
    if (revision === undefined) return;
    void client.invalidateQueries({
      queryKey: casesKey(organizationId),
      predicate: (entry) => entry.queryKey[4] !== 'resolution',
    });
  }, [client, organizationId, exceptionId, revision, state]);
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState<CaseDecision>();
  const [message, setMessage] = useState('');
  const [receipt, setReceipt] = useState<DecisionReceipt>();
  const refresh = () =>
    client.invalidateQueries({ queryKey: casesKey(organizationId) });
  async function decide(kind: CaseDecision['kind'], reason: string) {
    if (
      lock.current ||
      uncertain ||
      disabled ||
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
    if (!uncertain || lock.current) return;
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
  const denied =
    query.error instanceof IdentityError &&
    [401, 403, 404].includes(query.error.status);
  const data = denied ? undefined : query.data;
  const proposal = data?.review.proposal;
  const expired =
    proposal &&
    Math.min(
      Date.parse(proposal.expiresAt),
      Date.parse(proposal.preconditions.validUntil),
    ) <= query.dataUpdatedAt;
  const mismatched =
    data && data.review.caseRevision !== data.progress.caseRevision;
  return (
    <>
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
            disabled={pending}
            onClick={() => void recover()}
          >
            Check recorded decision
          </Button>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => void recover(true)}
          >
            Retry same decision
          </Button>
        </div>
      ) : null}
      {expired || mismatched ? (
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
          disabled={
            disabled ||
            query.isError ||
            query.isFetching ||
            Boolean(uncertain) ||
            Boolean(mismatched)
          }
          pending={pending}
          onDecision={(kind, reason) => void decide(kind, reason)}
        />
      ) : null}
    </>
  );
}
