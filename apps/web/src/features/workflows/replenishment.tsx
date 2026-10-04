import './replenishment.css';

import type {
  ReplenishmentSetup,
  WorkflowDetail,
  WorkflowRunView,
} from '@luma/api-contract';
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
  if (!rule.active) return ['Revoked', 'idle'];
  if (rule.status.state === 'blocked') return ['Stock not usable', 'error'];
  if (rule.waitingRunId) return ['Waiting for approval', 'approval'];

  return ['Watching', 'running'];
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
      setNotice('Stock checked. Follow the proposal and outcome in Activity.');
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
      stock={data?.positions.find(
        (p) =>
          p.positionId === rule.positionId &&
          p.connectionId === rule.connectionId,
      )}
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
          <p className="workflow-eyebrow">Stock → purchase order</p>
          <CardTitle as="h2">Stock rules</CardTitle>
        </div>
        <Button
          disabled={!canSetUp}
          aria-describedby={
            data && !canSetUp ? 'replenishment-setup-reason' : undefined
          }
          onClick={() => setOpen(true)}
        >
          <Plus size={15} aria-hidden="true" /> Add stock rules
        </Button>
      </div>
      <p>
        Each rule watches one stock position. When available stock falls below
        its minimum, Luma proposes a purchase-order draft that reaches the
        target, waits for approval and verifies the draft. Draft and open orders
        for the same SKU prevent duplicates.
      </p>
      {data && !canSetUp ? (
        <p id="replenishment-setup-reason" className="workflow-caption">
          {!data.available
            ? 'Setup is unavailable while the workflow worker is disconnected.'
            : 'Only owners and admins can add or revoke stock rules.'}
        </p>
      ) : null}
      {query.isPending ? (
        <p role="status">Loading stock and suppliers…</p>
      ) : query.error ? (
        <Alert tone="danger" role="alert">
          {workflowError(query.error)}{' '}
          <Button variant="ghost" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </Alert>
      ) : null}
      {data && !data.available ? (
        <Alert tone="warning">
          The workflow worker isn’t connected, so Luma can’t check stock or
          create orders. Whoever runs this Luma server needs to start it.
        </Alert>
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
              Retry stock check
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {data && active.length ? (
        <p className="replenishment-summary" aria-live="polite">
          <strong>
            {active.length} active {active.length === 1 ? 'rule' : 'rules'}
          </strong>
          {blocked.length ? (
            <span data-tone="error">{blocked.length} with unusable stock</span>
          ) : null}
          {waiting.length ? (
            <span data-tone="approval">
              {waiting.length} waiting for approval
            </span>
          ) : null}
        </p>
      ) : null}
      {data && !active.length ? (
        <Empty className="workflow-section-empty">
          <PackageCheck size={26} aria-hidden="true" />
          <h3>{revoked.length ? 'No active rules' : 'No stock rules yet'}</h3>
          <p>
            Choose up to {setupLimit} stock positions, a supplier, a minimum and
            a target. Each proposal keeps its evidence and approval history.
          </p>
          {!data.suppliers.length ? (
            <Link
              to="/app/$organizationId/procurement"
              params={{ organizationId }}
              search={{ view: 'suppliers', q: '', status: '' }}
            >
              Add a supplier in Procurement <ArrowRight size={14} />
            </Link>
          ) : !data.positions.length ? (
            <Link to="/app/$organizationId/apps" params={{ organizationId }}>
              Connect an inventory source <ArrowRight size={14} />
            </Link>
          ) : null}
        </Empty>
      ) : null}
      <div className="replenishment-rules">{active.map(card)}</div>
      {revoked.length ? (
        <Disclosure>
          <summary>
            Revoked rules ({revoked.length}). Kept for history; they never run.
          </summary>
          <div className="replenishment-rules">{revoked.map(card)}</div>
        </Disclosure>
      ) : null}
      <div className="workflow-approval-note">
        <ShieldCheck size={17} aria-hidden="true" />
        <p>
          {detail.summary.readiness.approval.summary} Approval never bypasses
          fresh stock, active rules or duplicate-order checks.
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
          <DialogTitle>Add stock rules</DialogTitle>
          <DialogDescription>
            Choose up to {setupLimit} stock positions and review exactly what
            each rule would do before Luma starts watching them.
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
                  setNotice(
                    'Stock rules saved. Luma now watches the activated positions.',
                  );
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
          <dt>Available</dt>
          <dd>
            {stock?.available ?? '—'} <small>{stock?.unit}</small>
          </dd>
        </div>
        <div>
          <dt>Below minimum</dt>
          <dd>{rule.minimum}</dd>
        </div>
        <div>
          <dt>Replenish to</dt>
          <dd>{rule.target}</dd>
        </div>
        <div>
          <dt>High risk above</dt>
          <dd>{rule.approvalQuantity}</dd>
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
            Latest run
          </Badge>{' '}
          {rule.latestRun.summary} <WorkspaceDate value={rule.latestRun.at} />
        </p>
      ) : null}
      <div className="replenishment-rule-footer">
        <span>
          {stock ? (
            <>
              Stock read <WorkspaceDate value={stock.observedAt} />
            </>
          ) : (
            'No stock read from the source'
          )}
        </span>
        <div className="replenishment-rule-actions">
          <Link
            className="workflow-repair-link"
            to="/app/$organizationId/inventory/$positionId"
            params={{ organizationId, positionId: rule.positionId }}
            search={{ from: here }}
          >
            Stock record <ArrowRight size={13} aria-hidden="true" />
          </Link>
          {rule.waitingRunId ? (
            <RepairLink
              organizationId={organizationId}
              definitionId={definitionId}
              repair={{
                label: 'Review decision',
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
                label: 'Purchase order',
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
              {starting ? 'Checking stock…' : 'Check stock now'}
            </Button>
          ) : null}
        </div>
      </div>
    </article>
  );
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
    <div className="replenishment-review" aria-label="Procurement run context">
      {query.isPending ? (
        <p role="status">Loading procurement context…</p>
      ) : null}
      {review ? (
        <>
          <div className="workflows-heading">
            <div>
              <span className="workflow-eyebrow">REPLENISHMENT CONTEXT</span>
              <h3>
                {review.quantity === null
                  ? review.sku
                  : `${review.quantity} × ${review.sku}`}
              </h3>
            </div>
            <Badge
              tone={
                review.verification.state === 'verified' ? 'success' : 'neutral'
              }
            >
              {review.verification.state === 'verified'
                ? 'Draft verified'
                : 'Not verified'}
            </Badge>
          </div>
          <dl
            className="replenishment-metrics"
            aria-label="Recorded stock context"
          >
            <div>
              <dt>Stock at check</dt>
              <dd>
                {review.stock.available ?? '—'}{' '}
                <small>{review.stock.unit}</small>
              </dd>
            </div>
            <div>
              <dt>Below minimum</dt>
              <dd>{review.stock.minimum}</dd>
            </div>
            <div>
              <dt>Replenish to</dt>
              <dd>{review.stock.target}</dd>
            </div>
            <div>
              <dt>Proposed quantity</dt>
              <dd>{review.quantity ?? '—'}</dd>
            </div>
          </dl>
          {review.stock.checkedAt ? (
            <p>
              Stock checked <WorkspaceDate value={review.stock.checkedAt} />
            </p>
          ) : (
            <p>Stock evidence has not been recorded.</p>
          )}
          <dl className="procurement-run-objects">
            <div>
              <dt>Supplier</dt>
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
              <dt>Decision</dt>
              <dd>
                {review.decision?.outcome.replaceAll('_', ' ') ??
                  'No decision recorded'}
              </dd>
            </div>
            <div>
              <dt>Purchase order</dt>
              <dd>
                {review.purchaseOrder
                  ? `${review.purchaseOrder.reference} · ${review.purchaseOrder.status}`
                  : 'No order created'}
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
              ? 'The draft, supplier and quantity were independently verified. Stock receipt is not part of this outcome.'
              : review.verification.state === 'failed'
                ? 'The purchase order differs from the expected draft. Review the order before continuing.'
                : review.verification.state === 'inconclusive'
                  ? 'The purchase-order result could not be confirmed. Review the recorded evidence.'
                  : review.purchaseOrder
                    ? 'The purchase order exists. Independent verification is still pending.'
                    : 'No verified purchase-order outcome recorded.'}
            {review.verification.recordedAt ? (
              <span>
                {' '}
                Checked <WorkspaceDate value={review.verification.recordedAt} />
                .
              </span>
            ) : null}
          </Alert>
        </>
      ) : null}
      {run.processState === 'ended' && committed ? (
        <Alert tone="neutral">
          An existing draft or open purchase order covers this SKU. No new order
          was created.
        </Alert>
      ) : null}
      {query.error ? (
        <Alert tone="danger">
          {workflowError(query.error)}{' '}
          <Button variant="ghost" onClick={() => void query.refetch()}>
            Refresh review
          </Button>
        </Alert>
      ) : null}
      {review?.state === 'approval_required' ? (
        <>
          <p>
            {review.canRespond
              ? 'Review this quantity and supplier before approving the draft.'
              : 'Waiting for a different owner or admin. Stock evidence must still be fresh when approved.'}
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
                Reject proposal
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
                Approve {review.quantity} units
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
      {mutation.isSuccess && review?.verification.state === 'not_verified' ? (
        <Alert tone="success" role="status">
          Decision recorded. The workflow will check current stock and policy
          before continuing.
        </Alert>
      ) : null}
      {mutation.error ? (
        <Alert tone="danger" role="alert">
          {workflowError(mutation.error)}{' '}
          <Button variant="ghost" onClick={() => void query.refetch()}>
            Refresh review
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
        View run activity <ArrowRight size={14} aria-hidden="true" />
      </Link>
      {typeof orderId === 'string' ? (
        <Link
          to="/app/$organizationId/procurement/$purchaseOrderId"
          params={{ organizationId, purchaseOrderId: orderId }}
        >
          Inspect purchase order <ArrowRight size={14} aria-hidden="true" />
        </Link>
      ) : null}
    </div>
  );
}
