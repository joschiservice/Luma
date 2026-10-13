import type {
  ReturnActionList,
  ReturnActionView,
  ReturnCaseDetail,
} from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { ActionDiff } from '@luma/ui/components/issues/action-diff';
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
import { useState } from 'react';

import { useNow } from '../../kit/live/now';
import { formatMoney } from '../../shared/orders/presentation';
import {
  returnCaseError,
  returnCaseKey,
  returnSettlementOptions,
  settlementCommands,
} from './case-data';
import { retryableReturnRequestId } from './case-requests';

const labels: Record<ReturnActionView['state'], () => string> = {
  approval_required: () => m.returns_case_creation_state_approval_required(),
  approved: () => m.returns_case_creation_state_approved(),
  rejected: () => m.returns_case_creation_state_rejected(),
  expired: () => m.returns_case_creation_state_expired(),
  sending: () => m.returns_case_creation_state_sending(),
  uncertain: () => m.returns_settlement_uncertain(),
  pending: () => m.returns_stage_refund_pending(),
  verified: () => m.returns_settlement_verified(),
  failed: () => m.returns_settlement_failed(),
  not_executed: () => m.returns_case_creation_state_not_executed(),
};

/** Presents approval and source proof separately; received goods and proposals never imply money or stock changed. */
export function ReturnSettlement({
  organizationId,
  detail,
  data,
  loading,
  unavailable,
  retry,
}: {
  organizationId: string;
  detail: ReturnCaseDetail;
  data: ReturnActionList | undefined;
  loading: boolean;
  unavailable: boolean;
  retry: () => void;
}) {
  const client = useQueryClient(),
    clock = useNow();
  const now = Math.max(clock, Date.parse(data?.asOf ?? '') || 0);
  const [requests, setRequests] = useState<Record<string, string>>({});
  const command = settlementCommands(organizationId, detail.case.id);
  const mutation = useMutation({
    mutationFn: (fn: () => Promise<ReturnActionView>) => fn(),
    onSuccess: (action) => {
      // The command response already includes the owner's independently read result.
      // Show it without waiting for unrelated case panels; no status is inferred locally.
      client.setQueryData<ReturnActionList>(
        returnSettlementOptions(organizationId, detail.case.id).queryKey,
        (current) =>
          current
            ? {
                ...current,
                items: current.items.some((item) => item.id === action.id)
                  ? current.items.map((item) =>
                      item.id === action.id ? action : item,
                    )
                  : [...current.items, action],
              }
            : current,
      );
    },
    onSettled: () =>
      client.invalidateQueries({ queryKey: returnCaseKey(organizationId) }),
  });
  const run = (fn: () => Promise<ReturnActionView>) => mutation.mutate(fn);

  function request(kind: 'refund' | 'restock', targetId?: string) {
    const key = targetId ?? kind,
      id =
        retryableReturnRequestId(
          requests[key],
          data?.items.find((a) => a.id === requests[key]),
          now,
        ) ?? crypto.randomUUID();
    setRequests((current) => ({ ...current, [key]: id }));
    run(() => command.request({ id, kind, ...(targetId ? { targetId } : {}) }));
  }

  const enabled =
    !!data?.available &&
    detail.canManage &&
    detail.case.state === 'open' &&
    !!detail.proposal;
  const held = (kind: 'refund' | 'restock', orderLineId: string | null) =>
    data?.items.some(
      (a) =>
        a.kind === kind &&
        a.orderLineId === orderLineId &&
        (a.sent ||
          (['approval_required', 'approved'].includes(a.state) &&
            Date.parse(a.expiresAt) > now)),
    );

  return (
    <Card as="section" aria-label={m.returns_settlement_title()}>
      <CardHeader>
        <div>
          <CardTitle as="h2">{m.returns_settlement_title()}</CardTitle>
          <CardDescription>
            {m.returns_settlement_description()}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p role="status">{m.returns_settlement_loading()}</p>
        ) : unavailable ? (
          <Alert tone="danger" role="alert">
            {m.returns_settlement_unavailable()}{' '}
            <Button variant="ghost" onClick={retry}>
              {m.common_retry()}
            </Button>
          </Alert>
        ) : !data?.available ? (
          <p>{m.returns_settlement_unsupported()}</p>
        ) : null}
        {mutation.error ? (
          <Alert tone="danger" role="alert">
            {returnCaseError(mutation.error)}
          </Alert>
        ) : null}
        {data?.items.length ? (
          <ul className="returns-case-decisions">
            {data.items.map((action) => {
              const fresh =
                action.proof &&
                Date.parse(action.proof.observedAt) <= now &&
                now - Date.parse(action.proof.observedAt) <= 300_000;

              return (
                <li key={action.id}>
                  <div className="returns-cell">
                    <strong>
                      {action.kind === 'refund'
                        ? m.returns_settlement_refund()
                        : m.returns_settlement_restock()}
                    </strong>
                    <span>
                      {action.plan.kind === 'refund'
                        ? formatMoney({
                            amount: action.plan.amount,
                            currency: action.plan.currency,
                          })
                        : m.returns_settlement_units({
                            units: formatNumber(action.plan.quantity),
                            warehouse: action.plan.warehouse.externalId,
                          })}
                    </span>
                    <StatePill
                      state={
                        action.state === 'verified' && fresh
                          ? 'verified'
                          : ['failed', 'uncertain'].includes(action.state)
                            ? 'attention'
                            : 'waiting'
                      }
                    >
                      {action.state === 'verified' && !fresh
                        ? m.returns_service_stale()
                        : labels[action.state]()}
                    </StatePill>
                    {action.diff ? <ActionDiff diff={action.diff} /> : null}
                    <span>
                      {m.returns_settlement_requested()}{' '}
                      <WorkspaceDate value={action.requestedAt} />
                    </span>
                    {action.proof?.payment === 'partial' ? (
                      <Alert>{m.returns_settlement_partial()}</Alert>
                    ) : null}
                    {action.proof ? (
                      <span>
                        {m.returns_settlement_checked()}{' '}
                        <WorkspaceDate value={action.proof.observedAt} /> ·{' '}
                        {fresh
                          ? m.returns_settlement_fresh()
                          : m.returns_service_stale()}
                      </span>
                    ) : (
                      <span>{m.returns_settlement_no_proof()}</span>
                    )}
                    {action.observeOnly ? (
                      <span>{m.returns_settlement_observe_only()}</span>
                    ) : null}
                    <div className="returns-case-actions">
                      {action.canApprove && action.decisionId ? (
                        <>
                          <Button
                            disabled={mutation.isPending}
                            onClick={() =>
                              run(() =>
                                command.decide(action.id, {
                                  decisionId: action.decisionId!,
                                  outcome: 'approved',
                                }),
                              )
                            }
                          >
                            {m.returns_settlement_approve()}
                          </Button>
                          <Button
                            variant="outline"
                            disabled={mutation.isPending}
                            onClick={() =>
                              run(() =>
                                command.decide(action.id, {
                                  decisionId: action.decisionId!,
                                  outcome: 'rejected',
                                }),
                              )
                            }
                          >
                            {m.returns_case_creation_reject()}
                          </Button>
                        </>
                      ) : null}
                      {action.canSend ? (
                        <Button
                          disabled={mutation.isPending}
                          onClick={() => run(() => command.send(action.id))}
                        >
                          {m.returns_settlement_send()}
                        </Button>
                      ) : null}
                      {action.canCheck ? (
                        <Button
                          variant="outline"
                          disabled={mutation.isPending}
                          onClick={() => run(() => command.check(action.id))}
                        >
                          {m.returns_settlement_check()}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : !loading && !unavailable && data?.available ? (
          <p>{m.returns_settlement_empty()}</p>
        ) : null}
        {enabled ? (
          <div className="returns-case-actions">
            {detail.proposal?.kind === 'refund' && !held('refund', null) ? (
              <Button
                disabled={mutation.isPending}
                onClick={() => request('refund')}
              >
                {m.returns_settlement_request_refund()}
              </Button>
            ) : null}
            {data?.targets
              .filter(
                (target) =>
                  (detail.lines.find(
                    (l) => l.orderLineId === target.orderLineId,
                  )?.restock ?? 0) > 0 && !held('restock', target.orderLineId),
              )
              .map((target) => (
                <Button
                  key={target.id}
                  className="returns-settlement-request"
                  variant="outline"
                  disabled={mutation.isPending}
                  onClick={() => request('restock', target.id)}
                >
                  <span className="returns-settlement-target">
                    {m.returns_settlement_request_restock({
                      item:
                        detail.lines.find(
                          (l) => l.orderLineId === target.orderLineId,
                        )?.title ?? target.orderLineId,
                      warehouse: target.label,
                    })}
                  </span>
                </Button>
              ))}
            {detail.lines.some((l) => (l.restock ?? 0) > 0) &&
            !data?.targets.length ? (
              <p>
                {data?.targetStatus === 'unavailable'
                  ? m.returns_settlement_targets_unavailable()
                  : m.returns_settlement_no_warehouse()}
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
