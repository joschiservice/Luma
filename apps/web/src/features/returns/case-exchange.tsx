import type { ReturnCaseDetail, ReturnExchangesView } from '@luma/api-contract';
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
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { useNow } from '../../kit/live/now';
import { formatMoney } from '../../shared/orders/presentation';
import {
  exchangeCommands,
  returnCaseError,
  returnCaseKey,
  returnExchangeOptions,
} from './case-data';
import { retryableReturnRequestId } from './case-requests';

type ExchangeCommand = ReturnType<typeof exchangeCommands>;

type ExchangeResult = Awaited<
  ReturnType<ExchangeCommand[keyof ExchangeCommand]>
>;

const consistencyLabels = {
  receipt: () => m.returns_exchange_check_receipt(),
  inspection: () => m.returns_exchange_check_inspection(),
  stock: () => m.returns_exchange_check_stock(),
  replacement: () => m.returns_exchange_check_replacement(),
  reservation: () => m.returns_exchange_check_reservation(),
  payment: () => m.returns_exchange_check_payment(),
  fulfillment: () => m.returns_exchange_check_fulfillment(),
};
const consistencyReasons: Record<string, () => string> = {
  source_unavailable: m.returns_exchange_reason_source_unavailable,
  missing_receipt: m.returns_exchange_reason_missing_receipt,
  source_receipt_unverified:
    m.returns_exchange_reason_source_receipt_unverified,
  uninspected: m.returns_exchange_reason_uninspected,
  stock_unverified: m.returns_exchange_reason_stock_unverified,
  writeoff_unverified: m.returns_exchange_reason_writeoff_unverified,
  duplicate_replacement: m.returns_exchange_reason_duplicate_replacement,
  replacement_missing: m.returns_exchange_reason_replacement_missing,
  reservation_missing: m.returns_exchange_reason_reservation_missing,
  price_mismatch: m.returns_exchange_reason_price_mismatch,
  money_unsettled: m.returns_exchange_reason_money_unsettled,
  fulfillment_not_ready: m.returns_exchange_reason_fulfillment_not_ready,
};
const stepLabels = {
  request: () => m.returns_exchange_step_request(),
  process: () => m.returns_exchange_step_process(),
  cancel: () => m.returns_exchange_step_cancel(),
  release: () => m.returns_exchange_step_release(),
};
const stateLabels = {
  approval_required: () => m.returns_case_creation_state_approval_required(),
  approved: () => m.returns_case_creation_state_approved(),
  rejected: () => m.returns_case_creation_state_rejected(),
  expired: () => m.returns_case_creation_state_expired(),
  sending: () => m.returns_case_creation_state_sending(),
  uncertain: () => m.returns_settlement_uncertain(),
  verified: () => m.returns_settlement_verified(),
  failed: () => m.returns_settlement_failed(),
  not_executed: () => m.returns_case_creation_state_not_executed(),
};
const paymentLabels = {
  not_required: () => m.returns_exchange_even(),
  partial: () => m.returns_exchange_payment_partial(),
  pending: () => m.returns_exchange_payment_pending(),
  failed: () => m.returns_exchange_payment_failed(),
  paid: () => m.returns_exchange_payment_paid(),
  unknown: () => m.returns_exchange_payment_unknown(),
};

/** Presents one operation with separate native fulfillment, financial proof and owner choices. */
export function ReturnExchange({
  organizationId,
  detail,
  data,
  loading,
  unavailable,
  retry,
}: {
  organizationId: string;
  detail: ReturnCaseDetail;
  data: ReturnExchangesView | undefined;
  loading: boolean;
  unavailable: boolean;
  retry: () => void;
}) {
  const client = useQueryClient(),
    clock = useNow(),
    now = Math.max(clock, Date.parse(data?.asOf ?? '') || 0);
  const [operationId] = useState(() => crypto.randomUUID()),
    [replacement, setReplacement] = useState(''),
    [quantity, setQuantity] = useState('1'),
    [requests, setRequests] = useState<Record<string, string>>({});
  const command = exchangeCommands(organizationId, detail.case.id),
    mutation = useMutation({
      mutationFn: (fn: () => Promise<ExchangeResult>) => fn(),
      onSuccess: (result) => {
        // Only owner-returned steps and fresh consistency checks change their matching panel.
        client.setQueryData<ReturnExchangesView>(
          returnExchangeOptions(organizationId, detail.case.id).queryKey,
          (current) => {
            if (!current) return current;
            if ('plan' in result)
              return {
                ...current,
                steps: current.steps.some((step) => step.id === result.id)
                  ? current.steps.map((step) =>
                      step.id === result.id ? result : step,
                    )
                  : [...current.steps, result],
              };
            if ('checks' in result)
              return {
                ...current,
                operation: current.operation
                  ? { ...current.operation, completion: result }
                  : null,
              };
            if ('currentAttemptId' in result)
              return { ...current, operation: result };

            return current;
          },
        );
      },
      onSettled: () =>
        client.invalidateQueries({ queryKey: returnCaseKey(organizationId) }),
    });
  const run = (fn: () => Promise<ExchangeResult>) => mutation.mutate(fn),
    root = data?.operation;
  const requested = data?.steps.find((s) => s.id === root?.currentAttemptId),
    processed = data?.steps.find((s) => s.plan.kind === 'process' && s.sent),
    cancelled = data?.steps.find(
      (s) =>
        s.plan.kind === 'cancel' &&
        s.state === 'verified' &&
        s.proof &&
        root?.request.kind === 'request' &&
        s.plan.marker === root.request.marker,
    );
  const fresh = (at: string) =>
    Number.isFinite(Date.parse(at)) &&
    Date.parse(at) <= now &&
    now - Date.parse(at) <= 300_000;
  const held = (kind: 'request' | 'process' | 'cancel' | 'release') =>
    data?.steps.some(
      (s) =>
        s.plan.kind === kind &&
        ('marker' in s.plan
          ? root?.request.kind === 'request' &&
            s.plan.marker === root.request.marker
          : true) &&
        (s.sent ||
          (['approval_required', 'approved', 'sending'].includes(s.state) &&
            Date.parse(s.expiresAt) > now)),
    );
  const enabled =
    !!data?.available &&
    detail.canManage &&
    detail.case.state === 'open' &&
    detail.proposal?.kind === 'exchange';

  function request(kind: 'request' | 'process' | 'cancel' | 'release') {
    const key = `${kind}:${root?.currentAttemptId ?? 'initial'}:${kind === 'request' ? `${replacement}:${quantity}` : ''}`,
      id =
        retryableReturnRequestId(
          requests[key],
          data?.steps.find((s) => s.id === requests[key]),
          now,
        ) ?? crypto.randomUUID();
    setRequests((values) => ({ ...values, [key]: id }));
    run(() =>
      command.request({
        id,
        operationId: root?.id ?? operationId,
        kind,
        ...(kind === 'request'
          ? { replacementId: replacement, quantity: Number(quantity) }
          : {}),
      }),
    );
  }

  if (detail.proposal?.kind !== 'exchange' && !root) return null;

  return (
    <Card as="section" aria-label={m.returns_exchange_title()}>
      <CardHeader>
        <div>
          <CardTitle as="h2">{m.returns_exchange_title()}</CardTitle>
          <CardDescription>{m.returns_exchange_description()}</CardDescription>
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
        ) : (
          <>
            {root ? (
              <p>
                <strong>{root.replacementName}</strong> ·{' '}
                {formatNumber(
                  root.request.kind === 'request'
                    ? root.request.replacement.quantity
                    : 0,
                )}
              </p>
            ) : null}
            {root?.availability &&
            (root.availability.available !== true ||
              !fresh(root.availability.observedAt)) ? (
              <Alert>
                {fresh(root.availability.observedAt) &&
                root.availability.available === false
                  ? m.returns_exchange_stock_unavailable()
                  : m.returns_exchange_stock_unknown()}
              </Alert>
            ) : null}
            {root ? (
              <p className="returns-note">
                {m.returns_case_assignee()}:{' '}
                {detail.case.assignee?.name ?? detail.case.openedBy.name} ·{' '}
                <WorkspaceDate value={root.startedAt} />
              </p>
            ) : null}
            {root && detail.proposal?.kind === 'exchange' ? (
              <section
                aria-label={m.returns_exchange_consistency_title()}
                className="returns-cell"
              >
                <h3>{m.returns_exchange_consistency_title()}</h3>
                <p className="returns-note">
                  {m.returns_exchange_consistency_description()}
                </p>
                <Input
                  aria-label={m.returns_exchange_reference()}
                  readOnly
                  value={`luma-ex:${root.id}`}
                  onFocus={(e) => e.currentTarget.select()}
                />
                {root.completion ? (
                  <>
                    <StatePill
                      state={
                        root.completion.state === 'verified'
                          ? 'verified'
                          : 'attention'
                      }
                    >
                      {root.completion.state === 'verified'
                        ? m.returns_exchange_complete_verified()
                        : m.returns_exchange_complete_unresolved()}
                    </StatePill>
                    <p>
                      <WorkspaceDate value={root.completion.checkedAt} />
                    </p>
                    {!fresh(root.completion.checkedAt) ? (
                      <Alert>{m.returns_service_source_stale()}</Alert>
                    ) : null}
                    {root.completion.replacementTotal ? (
                      <p>
                        {m.returns_exchange_expected_total()}:{' '}
                        {formatMoney(root.completion.replacementTotal)}
                      </p>
                    ) : null}
                    <ul className="returns-case-lines">
                      {root.completion.checks.map((check) => (
                        <li key={check.id} className="returns-cell">
                          <StatePill
                            state={check.verified ? 'verified' : 'attention'}
                          >
                            {consistencyLabels[check.id]()}
                          </StatePill>
                          {!check.verified ? (
                            <p className="returns-note">
                              {(
                                consistencyReasons[check.reason] ??
                                m.returns_exchange_reason_source_unavailable
                              )()}
                            </p>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {detail.canManage && detail.case.state !== 'cancelled' ? (
                  <Button
                    disabled={mutation.isPending}
                    onClick={() => run(() => command.complete())}
                  >
                    {m.returns_exchange_check_both()}
                  </Button>
                ) : null}
              </section>
            ) : null}
            {data.steps.length ? (
              <ul className="returns-case-lines">
                {data.steps.map((step) => {
                  const proofFresh =
                      !!step.proof && fresh(step.proof.observedAt),
                    financial =
                      step.plan.kind === 'process'
                        ? step.plan.financial
                        : step.proof?.financial;

                  return (
                    <li key={step.id}>
                      <div className="returns-cell">
                        <strong>{stepLabels[step.plan.kind]()}</strong>
                        <StatePill
                          state={
                            step.state === 'verified' && proofFresh
                              ? 'verified'
                              : step.state === 'failed'
                                ? 'error'
                                : 'attention'
                          }
                        >
                          {step.state === 'verified' && !proofFresh
                            ? m.returns_service_stale()
                            : stateLabels[step.state]()}
                        </StatePill>
                        {step.diff ? <ActionDiff diff={step.diff} /> : null}
                        {financial ? (
                          <span>
                            {financial.kind === 'even'
                              ? m.returns_exchange_even()
                              : `${financial.kind === 'charge' ? m.returns_exchange_charge() : m.returns_exchange_net_refund()} · ${formatMoney(financial)}`}
                          </span>
                        ) : null}
                        {step.proof ? (
                          <>
                            <small>
                              {m.returns_settlement_checked()}{' '}
                              <WorkspaceDate value={step.proof.observedAt} /> ·{' '}
                              {proofFresh
                                ? m.returns_settlement_fresh()
                                : m.returns_service_stale()}
                            </small>
                            {step.plan.kind === 'process' ||
                            step.plan.kind === 'release' ? (
                              <>
                                <strong>
                                  {proofFresh
                                    ? paymentLabels[step.proof.payment]()
                                    : m.returns_exchange_payment_unknown()}
                                </strong>
                                <span>
                                  {proofFresh && step.proof.fulfillmentReady
                                    ? m.returns_exchange_fulfillment_ready()
                                    : m.returns_exchange_fulfillment_waiting()}
                                </span>
                              </>
                            ) : null}
                          </>
                        ) : (
                          <small>{m.returns_settlement_no_proof()}</small>
                        )}
                        {step.observeOnly ? (
                          <small>{m.returns_settlement_observe_only()}</small>
                        ) : null}
                        <div className="returns-case-actions">
                          {step.canApprove && step.decisionId ? (
                            <>
                              <Button
                                disabled={mutation.isPending}
                                onClick={() =>
                                  run(() =>
                                    command.decide(step.id, {
                                      decisionId: step.decisionId!,
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
                                    command.decide(step.id, {
                                      decisionId: step.decisionId!,
                                      outcome: 'rejected',
                                    }),
                                  )
                                }
                              >
                                {m.returns_case_creation_reject()}
                              </Button>
                            </>
                          ) : null}
                          {step.canSend ? (
                            <Button
                              disabled={mutation.isPending}
                              onClick={() => run(() => command.send(step.id))}
                            >
                              {m.returns_settlement_send()}
                            </Button>
                          ) : null}
                          {step.canCheck ? (
                            <Button
                              variant="outline"
                              disabled={mutation.isPending}
                              onClick={() => run(() => command.check(step.id))}
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
            ) : null}
            {processed &&
            !(
              root?.completion?.state === 'verified' &&
              fresh(root.completion.checkedAt)
            ) ? (
              <Alert>{m.returns_exchange_wawi_handoff()}</Alert>
            ) : null}
            {enabled ? (
              <div className="returns-case-actions">
                {(!root ||
                  (requested &&
                    !requested.sent &&
                    (['rejected', 'failed', 'expired', 'not_executed'].includes(
                      requested.state,
                    ) ||
                      Date.parse(requested.expiresAt) <= now)) ||
                  (root.choice?.kind === 'different_item' && cancelled)) &&
                !root?.processingStarted ? (
                  <div className="returns-cell">
                    <label>
                      {m.returns_exchange_replacement()}
                      <Select
                        aria-label={m.returns_exchange_replacement()}
                        value={replacement}
                        onValueChange={(v) => setReplacement(v ?? '')}
                        options={data.choices.map((c) => ({
                          value: c.id,
                          label: `${c.label} · ${c.available === null ? '?' : formatNumber(c.available)}`,
                        }))}
                      />
                    </label>
                    <label>
                      {m.returns_exchange_quantity()}
                      <Input
                        type="number"
                        min={1}
                        step={1}
                        value={quantity}
                        onChange={(e) => setQuantity(e.target.value)}
                      />
                    </label>
                    <p className="returns-note">
                      {m.returns_exchange_availability()}
                    </p>
                    {!data.choices.length ? (
                      <Alert>{m.returns_exchange_no_choices()}</Alert>
                    ) : null}
                    <Button
                      className="returns-settlement-request"
                      disabled={
                        mutation.isPending ||
                        !replacement ||
                        !Number.isSafeInteger(Number(quantity)) ||
                        Number(quantity) < 1
                      }
                      onClick={() => request('request')}
                    >
                      <span className="returns-settlement-target">
                        {m.returns_exchange_request()}
                      </span>
                    </Button>
                  </div>
                ) : null}
                {requested?.state === 'verified' &&
                !root?.processingStarted &&
                !held('process') &&
                (!root?.choice || root.choice.kind === 'wait') ? (
                  <Button
                    className="returns-settlement-request"
                    disabled={mutation.isPending}
                    onClick={() => request('process')}
                  >
                    <span className="returns-settlement-target">
                      {m.returns_exchange_process()}
                    </span>
                  </Button>
                ) : null}
                {root && !root.processingStarted ? (
                  <div className="returns-cell">
                    <p>{m.returns_exchange_waiting()}</p>
                    <div className="returns-case-actions">
                      {(['wait', 'different_item', 'refund'] as const).map(
                        (kind) => (
                          <Button
                            key={kind}
                            variant="outline"
                            disabled={mutation.isPending}
                            onClick={() =>
                              run(() =>
                                command.choose({
                                  revision: root.revision,
                                  kind,
                                }),
                              )
                            }
                          >
                            {kind === 'wait'
                              ? m.returns_exchange_wait()
                              : kind === 'different_item'
                                ? m.returns_exchange_different()
                                : m.returns_exchange_refund()}
                          </Button>
                        ),
                      )}
                    </div>
                    {root.choice ? (
                      <StatePill state="attention">
                        {root.choice.kind === 'wait'
                          ? m.returns_exchange_wait()
                          : root.choice.kind === 'different_item'
                            ? m.returns_exchange_different()
                            : m.returns_exchange_refund()}
                      </StatePill>
                    ) : null}
                    {root.choice &&
                    root.choice.kind !== 'wait' &&
                    !held('cancel') ? (
                      <Button
                        className="returns-settlement-request"
                        disabled={mutation.isPending}
                        onClick={() => request('cancel')}
                      >
                        <span className="returns-settlement-target">
                          {m.returns_exchange_cancel()}
                        </span>
                      </Button>
                    ) : null}
                    {root.choice?.kind === 'refund' &&
                    cancelled?.proof &&
                    fresh(cancelled.proof.observedAt) ? (
                      <Button
                        disabled={mutation.isPending}
                        onClick={() => run(() => command.refund(root.revision))}
                      >
                        {m.returns_exchange_handoff()}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {processed?.proof?.paymentHoldId &&
                ['paid', 'not_required'].includes(processed.proof.payment) &&
                fresh(processed.proof.observedAt) &&
                !held('release') ? (
                  <Button
                    className="returns-settlement-request"
                    disabled={mutation.isPending}
                    onClick={() => request('release')}
                  >
                    <span className="returns-settlement-target">
                      {m.returns_exchange_release()}
                    </span>
                  </Button>
                ) : null}
              </div>
            ) : null}
          </>
        )}
        {mutation.error ? (
          <Alert tone="danger" role="alert">
            {returnCaseError(mutation.error)}
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
