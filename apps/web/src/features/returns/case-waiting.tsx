import type { ReturnCaseDetail, ReturnWaitingView } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import { StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
  returnCaseError,
  returnCaseKey,
  returnDeadlineCommands,
} from './case-data';

type Episode = ReturnWaitingView['episodes'][number];

/** Human labels shared by the case header and durable waiting panel. */
export const returnWaitReasons: Record<Episode['reason'], () => string> = {
  missing_units: m.returns_waiting_receipt,
  inspection: m.returns_waiting_inspection,
  proposal: m.returns_waiting_proposal,
  not_requested: m.returns_waiting_not_requested,
  pending_money: m.returns_waiting_pending_money,
  failed_money: m.returns_waiting_failed_money,
  partial_money: m.returns_waiting_partial_money,
  missing_evidence: m.returns_waiting_missing_evidence,
  stale_evidence: m.returns_waiting_stale_evidence,
  unavailable_evidence: m.returns_waiting_unavailable_evidence,
};
const states: Record<Episode['state'], () => string> = {
  waiting: m.returns_waiting_waiting,
  escalated: m.returns_waiting_escalated,
  verified: m.returns_waiting_verified,
  superseded: m.returns_waiting_superseded,
  paused: m.returns_waiting_paused,
};

/** Shows durable owner waits separately from physical decisions and independently read payment. */
export function ReturnWaiting({
  organizationId,
  detail,
  data,
  loading = false,
  error,
}: {
  organizationId: string;
  detail: ReturnCaseDetail;
  data?: ReturnWaitingView | undefined;
  loading?: boolean;
  error?: unknown;
}) {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: () =>
      returnDeadlineCommands(organizationId).check(detail.case.id),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: returnCaseKey(organizationId) }),
  });
  const owner = detail.case.assignee ?? detail.case.openedBy;

  return (
    <Card as="section" aria-label={m.returns_waiting_title()}>
      <CardHeader>
        <CardTitle>{m.returns_waiting_title()}</CardTitle>
        <CardDescription>{m.returns_waiting_description()}</CardDescription>
      </CardHeader>
      <CardContent className="returns-cell">
        <p>{m.returns_waiting_owner({ name: owner.name ?? owner.id })}</p>
        {loading ? (
          <p role="status">{m.returns_case_loading()}</p>
        ) : error ? (
          <Alert>{returnCaseError(error)}</Alert>
        ) : (data?.episodes ?? []).length === 0 ? (
          <p>{m.returns_waiting_none()}</p>
        ) : (
          (data?.episodes ?? []).map((e) => (
            <div key={e.id} className="returns-cell">
              <strong>{returnWaitReasons[e.reason]()}</strong>
              <StatePill
                state={
                  e.state === 'escalated'
                    ? 'attention'
                    : e.state === 'verified'
                      ? 'verified'
                      : 'waiting'
                }
              >
                {states[e.state]()}
              </StatePill>
              <span>
                {m.returns_waiting_due()}: <WorkspaceDate value={e.dueAt} />
              </span>
              {e.observedAt ? (
                <span>
                  {m.returns_waiting_observed()}:{' '}
                  <WorkspaceDate value={e.observedAt} />
                </span>
              ) : null}
            </div>
          ))
        )}
        {mutation.error ? (
          <Alert>{returnCaseError(mutation.error)}</Alert>
        ) : null}
        {detail.canManage ? (
          <Button
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {m.returns_waiting_check()}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
