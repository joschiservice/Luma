import './replenishment.css';

import type {
  ReplenishmentSetup,
  WorkflowDetail,
  WorkflowRunView,
} from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { Card, CardTitle } from '@luma/ui/components/primitives/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { Empty } from '@luma/ui/components/primitives/empty';
import {
  type OperationalState,
  StatePill,
} from '@luma/ui/components/primitives/state';
import {
  WorkspaceDate,
  WorkspaceTimezone,
} from '@luma/ui/components/primitives/workspace-date';
import { workspaceDateValue } from '@luma/ui/lib/timezone';
import { quantityUnit } from '@luma/ui/lib/units';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from '@tanstack/react-router';
import { ArrowRight, PackageCheck, Plus, ShieldCheck } from 'lucide-react';
import { useContext, useEffect, useState } from 'react';

import { IdentityError } from '../identity/data';
import {
  decideReplenishment,
  replenishmentOptions,
  replenishmentReviewOptions,
  startReplenishment,
  workflowError,
  workflowsKey,
} from './data';
import { RepairLink } from './readiness';
import { ReplenishmentSetupFlow, setupLimit } from './replenishment-setup';

type Rule = ReplenishmentSetup['rules'][number];

function ruleStatus(rule: Rule): [string, OperationalState] {
  if (!rule.active) return [m.workflows_rule_revoked(), 'idle'];
  if (rule.status.state === 'blocked')
    return [m.workflows_rule_blocked(), 'error'];
  if (rule.waitingRunId) return [m.workflows_rule_waiting(), 'approval'];

  return [m.workflows_rule_watching(), 'running'];
}

/** Shows a quantity in the active language, or a dash when it wasn't recorded. */
function quantity(value: number | null | undefined) {
  return value === null || value === undefined
    ? m.common_empty_value()
    : formatNumber(value);
}

/**
 * Shows stock rules with their readiness, waiting decisions and latest result, and sets up new
 * rules for up to 25 positions at a time.
 */
export function ReplenishmentPanel({
  organizationId,
  detail,
  setup: initial,
}: {
  organizationId: string;
  detail: WorkflowDetail;
  /** A stock position to preselect in setup, from a record link. */
  setup?: string | undefined;
}) {
  const query = useQuery({
    ...replenishmentOptions(organizationId),
    refetchInterval: 30000,
  });
  const client = useQueryClient();
  // A record link that preselects a position opens setup until that position is dismissed,
  // even when the page is already open.
  const [manual, setManual] = useState(false);
  const [dismissed, setDismissed] = useState<string | undefined>();
  const open = manual || (!!initial && dismissed !== initial);
  const setOpen = (value: boolean) => {
    setManual(value);
    if (!value) setDismissed(initial);
  };
  const [locked, setLocked] = useState(false);
  const [notice, setNotice] = useState('');
  const refresh = () =>
    client.invalidateQueries({ queryKey: workflowsKey(organizationId) });
  const start = useMutation({
    mutationFn: (body: { id: string; activationId: string }) =>
      startReplenishment(organizationId, body),
    onSuccess: async () => {
      setNotice(m.workflows_stock_checked_notice());
      await refresh();
    },
  });
  const uncertain =
    start.isError &&
    (!(start.error instanceof IdentityError) || start.error.status >= 500);
  const data = query.data;
  const hash = useLocation({ select: (location) => location.hash });
  const linkedRuleId = data?.rules.find(
    (rule) => hash === `rule-${rule.id}`,
  )?.id;
  useEffect(() => {
    if (!linkedRuleId) return;
    const target = document.getElementById(`rule-${linkedRuleId}`);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'center' });
  }, [linkedRuleId]);
  const active = data?.rules.filter((rule) => rule.active) ?? [];
  const revoked = data?.rules.filter((rule) => !rule.active) ?? [];
  const blocked = active.filter((rule) => rule.status.state === 'blocked');
  const waiting = active.filter((rule) => rule.waitingRunId);
  const canSetUp = !!data?.canManage && data.available;
  const card = (rule: Rule) => (
    <RuleCard
      key={rule.id}
      organizationId={organizationId}
      definitionId={detail.summary.id}
      rule={rule}
      stock={rule.stock ?? undefined}
      canStart={
        rule.active &&
        rule.principalId === detail.principalId &&
        !!data?.canManage
      }
      starting={start.isPending && start.variables?.activationId === rule.id}
      startDisabled={!data?.available || start.isPending || uncertain}
      start={() =>
        start.mutate({ id: crypto.randomUUID(), activationId: rule.id })
      }
    />
  );

  return (
    <Card as="section" className="workflow-section replenishment-panel">
      <div className="workflows-heading">
        <div>
          <p className="workflow-eyebrow">{m.workflows_rules_eyebrow()}</p>
          <CardTitle as="h2">{m.workflows_rules_title()}</CardTitle>
        </div>
        <Button
          disabled={!canSetUp}
          aria-describedby={
            data && !canSetUp ? 'replenishment-setup-reason' : undefined
          }
          onClick={() => setOpen(true)}
        >
          <Plus size={15} aria-hidden="true" /> {m.workflows_rules_add()}
        </Button>
      </div>
      <p>{m.workflows_rules_description()}</p>
      {data && !canSetUp ? (
        <p id="replenishment-setup-reason" className="workflow-caption">
          {!data.available
            ? m.workflows_rules_unavailable_reason()
            : m.workflows_rules_cannot_manage()}
        </p>
      ) : null}
      {query.isPending ? (
        <p role="status">{m.workflows_rules_loading()}</p>
      ) : query.error ? (
        <Alert tone="danger" role="alert">
          {workflowError(query.error)}{' '}
          <Button variant="ghost" onClick={() => void query.refetch()}>
            {m.common_retry()}
          </Button>
        </Alert>
      ) : null}
      {data && !data.available ? (
        <Alert tone="warning">{m.workflows_rules_worker_offline()}</Alert>
      ) : null}
      {notice ? (
        <Alert tone="success" role="status">
          {notice}
        </Alert>
      ) : null}
      {start.error ? (
        <Alert tone="danger" role="alert">
          {workflowError(start.error)}
          {uncertain ? (
            <Button
              variant="outline"
              onClick={() => start.mutate(start.variables!)}
            >
              {m.workflows_rules_retry_check()}
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {data && active.length ? (
        <p className="replenishment-summary" aria-live="polite">
          <strong>
            {m.workflows_rules_active_count({ count: active.length })}
          </strong>
          {blocked.length ? (
            <span data-tone="error">
              {m.workflows_rules_blocked_count({ count: blocked.length })}
            </span>
          ) : null}
          {waiting.length ? (
            <span data-tone="approval">
              {m.workflows_rules_waiting_count({ count: waiting.length })}
            </span>
          ) : null}
        </p>
      ) : null}
      {data && !active.length ? (
        <Empty className="workflow-section-empty">
          <PackageCheck size={26} aria-hidden="true" />
          <h3>
            {revoked.length
              ? m.workflows_rules_empty_revoked()
              : m.workflows_rules_empty()}
          </h3>
          <p>{m.workflows_rules_empty_body({ limit: setupLimit })}</p>
          {!data.suppliers.length ? (
            <Link
              to="/app/$organizationId/procurement"
              params={{ organizationId }}
              search={{ view: 'suppliers', q: '', status: '' }}
            >
              {m.workflows_rules_add_supplier()} <ArrowRight size={14} />
            </Link>
          ) : !data.positions.length ? (
            <Link to="/app/$organizationId/apps" params={{ organizationId }}>
              {m.workflows_rules_connect_source()} <ArrowRight size={14} />
            </Link>
          ) : null}
        </Empty>
      ) : null}
      <div className="replenishment-rules">{active.map(card)}</div>
      {revoked.length ? (
        <Disclosure>
          <summary>
            {m.workflows_rules_revoked_summary({ count: revoked.length })}
          </summary>
          <div className="replenishment-rules">{revoked.map(card)}</div>
        </Disclosure>
      ) : null}
      <div className="workflow-approval-note">
        <ShieldCheck size={17} aria-hidden="true" />
        <p>
          {m.workflows_rules_approval_note({
            summary: detail.summary.readiness.approval.summary,
          })}
        </p>
      </div>
      <Dialog
        open={open && canSetUp}
        onOpenChange={(value) => {
          if (!locked) setOpen(value);
        }}
      >
        <DialogContent
          className="workflow-dialog replenishment-setup-dialog"
          showCloseButton={!locked}
        >
          <DialogTitle>{m.workflows_rules_add()}</DialogTitle>
          <DialogDescription>
            {m.workflows_rules_dialog_description({ limit: setupLimit })}
          </DialogDescription>
          {data ? (
            <ReplenishmentSetupFlow
              key={`${open}:${initial ?? ''}`}
              organizationId={organizationId}
              detail={detail}
              setup={data}
              initial={initial}
              onLock={setLocked}
              done={(changed) => {
                setOpen(false);
                if (changed) {
                  setNotice(m.workflows_rules_saved());
                  void refresh();
                }
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function RuleCard({
  organizationId,
  definitionId,
  rule,
  stock,
  canStart,
  starting,
  startDisabled,
  start,
}: {
  organizationId: string;
  definitionId: string;
  rule: Rule;
  stock: ReplenishmentSetup['positions'][number] | undefined;
  canStart: boolean;
  starting: boolean;
  startDisabled: boolean;
  start(): void;
}) {
  const [label, state] = ruleStatus(rule);
  const here = useLocation({ select: (location) => location.href });

  return (
    <article
      id={`rule-${rule.id}`}
      tabIndex={-1}
      className="replenishment-rule"
      data-state={rule.status.state}
    >
      <div className="workflows-heading">
        <div>
          <h3>{rule.sku}</h3>
          <p>{rule.supplier}</p>
        </div>
        <StatePill state={state}>{label}</StatePill>
      </div>
      <dl className="replenishment-metrics">
        <div>
          <dt>{m.workflows_rule_available()}</dt>
          <dd>
            {quantity(stock?.available)}{' '}
            <small>
              {stock?.unit
                ? quantityUnit(stock.unit, stock.available ?? '')
                : null}
            </small>
          </dd>
        </div>
        <div>
          <dt>{m.workflows_rule_minimum()}</dt>
          <dd>{quantity(rule.minimum)}</dd>
        </div>
        <div>
          <dt>{m.workflows_rule_target()}</dt>
          <dd>{quantity(rule.target)}</dd>
        </div>
        <div>
          <dt>{m.workflows_rule_high_risk()}</dt>
          <dd>{quantity(rule.approvalQuantity)}</dd>
        </div>
      </dl>
      {rule.active && rule.status.state === 'blocked' ? (
        <p className="replenishment-rule-issue">{rule.status.message}</p>
      ) : null}
      {rule.latestRun ? (
        <p className="replenishment-rule-latest">
          <Badge
            tone={
              rule.latestRun.state === 'verified'
                ? 'success'
                : [
                      'failed_verification',
                      'inconclusive_verification',
                      'escalated',
                      'denied',
                    ].includes(rule.latestRun.state ?? '')
                  ? 'warning'
                  : 'neutral'
            }
          >
            {m.workflows_rule_latest_run()}
          </Badge>{' '}
          {rule.latestRun.summary} <WorkspaceDate value={rule.latestRun.at} />
        </p>
      ) : null}
      <div className="replenishment-rule-footer">
        <span>
          {stock
            ? rich(m.workflows_rule_stock_read, {
                date: <WorkspaceDate value={stock.observedAt} />,
              })
            : m.workflows_rule_no_stock()}
        </span>
        <div className="replenishment-rule-actions">
          <Link
            className="workflow-repair-link"
            to="/app/$organizationId/inventory/$positionId"
            params={{ organizationId, positionId: rule.positionId }}
            search={{ from: here }}
          >
            {m.workflows_rule_stock_record()}{' '}
            <ArrowRight size={13} aria-hidden="true" />
          </Link>
          {rule.waitingRunId ? (
            <RepairLink
              organizationId={organizationId}
              definitionId={definitionId}
              repair={{
                label: m.workflows_rule_review_decision(),
                destination: 'needs_you',
                recordId: `replenishment:${rule.waitingRunId}`,
              }}
            />
          ) : null}
          {rule.latestRun?.purchaseOrderId ? (
            <RepairLink
              organizationId={organizationId}
              definitionId={definitionId}
              repair={{
                label: m.workflows_rule_purchase_order(),
                destination: 'purchase_order',
                recordId: rule.latestRun.purchaseOrderId,
              }}
            />
          ) : null}
          {canStart ? (
            <Button
              variant="outline"
              size="sm"
              disabled={startDisabled || rule.status.state !== 'ready'}
              title={
                rule.status.state !== 'ready' ? rule.status.message : undefined
              }
              onClick={start}
            >
              {starting
                ? m.workflows_rule_checking()
                : m.workflows_rule_check_now()}
            </Button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

/** Labels a recorded decision; outcomes Luma doesn't know stay as recorded. */
function decisionLabel(outcome: string) {
  if (outcome === 'approved') return m.workflows_review_decision_approved();
  if (outcome === 'rejected') return m.workflows_review_decision_rejected();

  return outcome.replaceAll('_', ' ');
}

/** Keeps the human decision next to its quantity and exposes only independently verified orders as success. */
export function ReplenishmentRunReview({
  organizationId,
  run,
}: {
  organizationId: string;
  run: WorkflowRunView;
}) {
  const query = useQuery({
    ...replenishmentReviewOptions(organizationId, run.id),
    refetchInterval: 5000,
  });
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: (body: {
      decisionId: string;
      outcome: 'approved' | 'rejected';
    }) => decideReplenishment(organizationId, run.id, body),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: workflowsKey(organizationId) }),
  });
  const accessLost =
    query.error instanceof IdentityError &&
    [401, 403, 404].includes(query.error.status);
  const review = accessLost ? undefined : query.data;
  const orderId = review?.purchaseOrder?.id;
  const timeZone = useContext(WorkspaceTimezone);
  const lastRecordedAt = Math.max(
    Date.parse(run.createdAt),
    ...(run.processSteps ?? []).map((step) => Date.parse(step.recordedAt)),
    review?.verification.recordedAt
      ? Date.parse(review.verification.recordedAt)
      : 0,
  );

  const committed = run.processSteps?.find((step) => step.stepId === 'proposal')
    ?.values.committed;

  return (
    <div
      className="replenishment-review"
      aria-label={m.workflows_review_label()}
    >
      {query.isPending ? (
        <p role="status">{m.workflows_review_loading()}</p>
      ) : null}
      {review ? (
        <>
          <div className="workflows-heading">
            <div>
              <span className="workflow-eyebrow">
                {m.workflows_review_eyebrow()}
              </span>
              <h3>
                {review.quantity === null
                  ? review.sku
                  : m.workflows_review_quantity_sku({
                      quantity: quantity(review.quantity),
                      sku: review.sku,
                    })}
              </h3>
            </div>
            <Badge
              tone={
                review.verification.state === 'verified' ? 'success' : 'neutral'
              }
            >
              {review.verification.state === 'verified'
                ? m.workflows_review_draft_verified()
                : m.workflows_review_not_verified()}
            </Badge>
          </div>
          <dl
            className="replenishment-metrics"
            aria-label={m.workflows_review_stock_label()}
          >
            <div>
              <dt>{m.workflows_review_stock_at_check()}</dt>
              <dd>
                {quantity(review.stock.available)}{' '}
                <small>
                  {review.stock.unit
                    ? quantityUnit(
                        review.stock.unit,
                        review.stock.available ?? '',
                      )
                    : null}
                </small>
              </dd>
            </div>
            <div>
              <dt>{m.workflows_rule_minimum()}</dt>
              <dd>{quantity(review.stock.minimum)}</dd>
            </div>
            <div>
              <dt>{m.workflows_rule_target()}</dt>
              <dd>{quantity(review.stock.target)}</dd>
            </div>
            <div>
              <dt>{m.workflows_review_proposed()}</dt>
              <dd>{quantity(review.quantity)}</dd>
            </div>
          </dl>
          {review.stock.checkedAt ? (
            <p>
              {rich(m.workflows_review_stock_checked, {
                date: <WorkspaceDate value={review.stock.checkedAt} />,
              })}
            </p>
          ) : (
            <p>{m.workflows_review_no_stock_check()}</p>
          )}
          <dl className="procurement-run-objects">
            <div>
              <dt>{m.workflows_review_supplier()}</dt>
              <dd>
                <Link
                  to="/app/$organizationId/procurement"
                  params={{ organizationId }}
                  search={{ view: 'suppliers', q: review.supplier, status: '' }}
                >
                  {review.supplier}
                </Link>
              </dd>
            </div>
            <div>
              <dt>{m.workflows_review_decision()}</dt>
              <dd>
                {review.decision
                  ? decisionLabel(review.decision.outcome)
                  : m.workflows_review_no_decision()}
              </dd>
            </div>
            <div>
              <dt>{m.workflows_review_purchase_order()}</dt>
              <dd>
                {review.purchaseOrder
                  ? m.workflows_review_order_status({
                      reference: review.purchaseOrder.reference,
                      status: review.purchaseOrder.status,
                    })
                  : m.workflows_review_no_order()}
              </dd>
            </div>
          </dl>
          <Alert
            tone={
              review.verification.state === 'verified'
                ? 'success'
                : ['failed', 'inconclusive'].includes(review.verification.state)
                  ? 'warning'
                  : 'neutral'
            }
          >
            {review.verification.state === 'verified'
              ? m.workflows_review_verified()
              : review.verification.state === 'failed'
                ? m.workflows_review_failed()
                : review.verification.state === 'inconclusive'
                  ? m.workflows_review_inconclusive()
                  : review.purchaseOrder
                    ? m.workflows_review_pending()
                    : m.workflows_review_none()}
            {review.verification.recordedAt ? (
              <span>
                {' '}
                {rich(m.workflows_review_checked_at, {
                  date: (
                    <WorkspaceDate value={review.verification.recordedAt} />
                  ),
                })}
              </span>
            ) : null}
          </Alert>
        </>
      ) : null}
      {run.processState === 'ended' && committed ? (
        <Alert tone="neutral">{m.workflows_review_covered()}</Alert>
      ) : null}
      {query.error ? (
        <Alert tone="danger">
          {workflowError(query.error)}{' '}
          <Button variant="ghost" onClick={() => void query.refetch()}>
            {m.workflows_review_refresh()}
          </Button>
        </Alert>
      ) : null}
      {review?.state === 'approval_required' ? (
        <>
          <p>
            {review.canRespond
              ? m.workflows_review_can_respond()
              : m.workflows_review_waiting_other()}
          </p>
          {review.canRespond && review.decisionId ? (
            <div className="workflow-dialog-actions">
              <Button
                variant="outline"
                disabled={mutation.isPending || mutation.isSuccess}
                onClick={() =>
                  mutation.mutate({
                    decisionId: review.decisionId!,
                    outcome: 'rejected',
                  })
                }
              >
                {m.workflows_review_reject()}
              </Button>
              <Button
                disabled={mutation.isPending || mutation.isSuccess}
                onClick={() =>
                  mutation.mutate({
                    decisionId: review.decisionId!,
                    outcome: 'approved',
                  })
                }
              >
                {review.quantity === null
                  ? m.workflows_review_approve()
                  : m.workflows_review_approve_units({
                      quantity: review.quantity,
                    })}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
      {mutation.isSuccess && review?.verification.state === 'not_verified' ? (
        <Alert tone="success" role="status">
          {m.workflows_review_decision_recorded()}
        </Alert>
      ) : null}
      {mutation.error ? (
        <Alert tone="danger" role="alert">
          {workflowError(mutation.error)}{' '}
          <Button variant="ghost" onClick={() => void query.refetch()}>
            {m.workflows_review_refresh()}
          </Button>
        </Alert>
      ) : null}
      <Link
        to="/app/$organizationId/activity"
        params={{ organizationId }}
        search={{
          q: run.id,
          from: workspaceDateValue(new Date(run.createdAt), timeZone),
          to: workspaceDateValue(new Date(lastRecordedAt), timeZone),
        }}
      >
        {m.workflows_review_activity()}{' '}
        <ArrowRight size={14} aria-hidden="true" />
      </Link>
      {typeof orderId === 'string' ? (
        <Link
          to="/app/$organizationId/procurement/$purchaseOrderId"
          params={{ organizationId, purchaseOrderId: orderId }}
        >
          {m.workflows_review_open_order()}{' '}
          <ArrowRight size={14} aria-hidden="true" />
        </Link>
      ) : null}
    </div>
  );
}
