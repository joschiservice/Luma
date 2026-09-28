import './replenishment.css';

import type {
  ReplenishmentRuleInput,
  ReplenishmentSetup,
  WorkflowDetail,
  WorkflowRunView,
} from '@luma/api-contract';
import { replenishmentRuleSchema } from '@luma/api-contract';
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
import { Empty } from '@luma/ui/components/primitives/empty';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
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
  configureReplenishment,
  decideReplenishment,
  replenishmentOptions,
  replenishmentReviewOptions,
  startReplenishment,
  workflowError,
  workflowsKey,
} from './data';

/** Shows scoped stock rules with explicit thresholds, fresh evidence and retryable starts. */
export function ReplenishmentPanel({
  organizationId,
  detail,
}: {
  organizationId: string;
  detail: WorkflowDetail;
}) {
  const query = useQuery({
    ...replenishmentOptions(organizationId),
    refetchInterval: 30000,
  });
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [locked, setLocked] = useState(false);
  const [notice, setNotice] = useState('');
  const refresh = () =>
    client.invalidateQueries({ queryKey: workflowsKey(organizationId) });
  const start = useMutation({
    mutationFn: (body: { id: string; activationId: string }) =>
      startReplenishment(organizationId, body),
    onSuccess: async () => {
      setNotice(
        'Stock checked. Follow the proposal and outcome in Recent runs.',
      );
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

  return (
    <Card as="section" className="workflow-section replenishment-panel">
      <div className="workflows-heading">
        <div>
          <p className="workflow-eyebrow">STOCK → PURCHASE ORDER</p>
          <CardTitle as="h2">Replenishment rules</CardTitle>
        </div>
        <Button
          disabled={!data?.canManage || !data.available}
          onClick={() => setOpen(true)}
        >
          <Plus size={15} aria-hidden="true" /> Add stock rule
        </Button>
      </div>
      <p>
        Monitor a stock position, replenish to a target, and verify the
        purchase-order draft. Draft and open orders prevent duplicate
        replenishment.
      </p>
      {query.isPending ? (
        <p role="status">Loading stock and suppliers…</p>
      ) : query.error ? (
        <Alert tone="danger">
          {workflowError(query.error)}{' '}
          <Button variant="ghost" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </Alert>
      ) : null}
      {data && !data.available ? (
        <Alert tone="warning">
          Execution is unavailable. Check the workflow worker connection.
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
      {data?.rules.length === 0 ? (
        <Empty>
          <PackageCheck size={26} aria-hidden="true" />
          <h3>Keep replenishment deliberate</h3>
          <p>
            Choose the inventory source, supplier, minimum stock and target.
            Each proposal keeps its evidence and approval history.
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
            <p>
              Connect and map an inventory source to make stock positions
              available.
            </p>
          ) : null}
        </Empty>
      ) : null}
      <div className="replenishment-rules">
        {data?.rules.map((rule) => {
          const stock = data.positions.find(
            (p) =>
              p.positionId === rule.positionId &&
              p.connectionId === rule.connectionId,
          );
          const fresh =
            !!stock &&
            query.dataUpdatedAt - Date.parse(stock.observedAt) < 300000 &&
            stock.available !== null;

          return (
            <article
              key={rule.id}
              id={`rule-${rule.id}`}
              tabIndex={-1}
              className="replenishment-rule"
            >
              <div className="workflows-heading">
                <div>
                  <h3>{rule.sku}</h3>
                  <p>{rule.supplier}</p>
                </div>
                <Badge tone={rule.active ? 'success' : 'neutral'}>
                  {rule.active ? 'Monitoring' : 'Revoked'}
                </Badge>
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
              <div className="replenishment-rule-footer">
                <span>
                  {stock ? (
                    <>
                      Observed <WorkspaceDate value={stock.observedAt} /> ·{' '}
                      {fresh ? 'Fresh' : 'Refresh required'}
                    </>
                  ) : (
                    'Inventory unavailable'
                  )}
                </span>
                {rule.active &&
                rule.principalId === detail.principalId &&
                data.canManage ? (
                  <Button
                    variant="outline"
                    disabled={!data.available || start.isPending || uncertain}
                    onClick={() =>
                      start.mutate({
                        id: crypto.randomUUID(),
                        activationId: rule.id,
                      })
                    }
                  >
                    {start.isPending &&
                    start.variables?.activationId === rule.id
                      ? 'Checking stock…'
                      : 'Check stock now'}
                  </Button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
      <div className="workflow-approval-note">
        <ShieldCheck size={17} aria-hidden="true" />
        <p>
          A different owner or admin reviews each draft. Approval never bypasses
          fresh inventory, active grants or duplicate-order checks.
        </p>
      </div>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!locked) setOpen(value);
        }}
      >
        <DialogContent className="workflow-dialog" showCloseButton={!locked}>
          <DialogTitle>Activate a stock rule</DialogTitle>
          <DialogDescription>
            Review the exact stock source and quantity limits. Monitoring starts
            after activation.
          </DialogDescription>
          {data ? (
            <ReplenishmentRuleForm
              key={String(open)}
              organizationId={organizationId}
              detail={detail}
              setup={data}
              onLock={setLocked}
              done={async () => {
                setOpen(false);
                await refresh();
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** Reviews one stock position, supplier and quantity limits, then activates a retry-safe rule. */
export function ReplenishmentRuleForm({
  organizationId,
  detail,
  setup,
  done,
  onLock,
}: {
  organizationId: string;
  detail: WorkflowDetail;
  setup: ReplenishmentSetup;
  done(): Promise<void>;
  onLock(value: boolean): void;
}) {
  const [position, setPosition] = useState('');
  const [supplier, setSupplier] = useState('');
  const [minimum, setMinimum] = useState('10');
  const [target, setTarget] = useState('50');
  const [limit, setLimit] = useState('100');
  const [error, setError] = useState('');
  const mutation = useMutation({
    mutationFn: (body: ReplenishmentRuleInput) =>
      configureReplenishment(organizationId, body),
    onMutate: () => onLock(true),
    onSuccess: async () => {
      onLock(false);
      await done();
    },
    onError: (error) =>
      onLock(!(error instanceof IdentityError) || error.status >= 500),
  });
  const uncertain =
    mutation.isError &&
    (!(mutation.error instanceof IdentityError) ||
      mutation.error.status >= 500);
  const locked = mutation.isPending || uncertain;
  const selected = setup.positions.find(
    (p) => `${p.positionId}:${p.connectionId}` === position,
  );
  const units = selected?.unit ?? 'units';

  return (
    <form
      className="replenishment-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (uncertain) {
          mutation.mutate(mutation.variables!);

          return;
        }
        const parsed = replenishmentRuleSchema.safeParse({
          id: crypto.randomUUID(),
          positionId: selected?.positionId,
          connectionId: selected?.connectionId,
          supplierId: supplier,
          minimum: minimum.trim() ? Number(minimum) : NaN,
          target: target.trim() ? Number(target) : NaN,
          approvalQuantity: limit.trim() ? Number(limit) : NaN,
          reviewedDigest: detail.versions[0]!.digest,
        });
        if (!parsed.success) {
          setError(
            'Select a stock position and supplier. Use whole quantities, with target stock above the minimum.',
          );

          return;
        }
        setError('');
        mutation.mutate(parsed.data);
      }}
    >
      <label>
        Stock position
        <Select
          aria-label="Stock position"
          disabled={locked}
          value={position}
          onValueChange={(value) => setPosition(value ?? '')}
          placeholder="Choose inventory"
          options={setup.positions.map((p) => ({
            value: `${p.positionId}:${p.connectionId}`,
            label: `${p.sku} · ${p.available ?? 'Unknown'} ${p.unit} · ${p.connectionId.slice(0, 8)}`,
          }))}
        />
      </label>
      <label>
        Supplier
        <Select
          aria-label="Supplier"
          disabled={locked}
          value={supplier}
          onValueChange={(value) => setSupplier(value ?? '')}
          placeholder="Choose supplier"
          options={setup.suppliers.map((s) => ({ value: s.id, label: s.name }))}
        />
      </label>
      <div className="replenishment-form-pair">
        <label>
          Minimum stock
          <Input
            type="number"
            min="0"
            max="999999"
            step="1"
            required
            disabled={locked}
            value={minimum}
            onChange={(e) => setMinimum(e.target.value)}
          />
        </label>
        <label>
          Target stock
          <Input
            type="number"
            min="1"
            max="1000000"
            step="1"
            required
            disabled={locked}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
        </label>
      </div>
      <label>
        High-risk quantity threshold
        <Input
          type="number"
          min="0"
          max="1000000"
          step="1"
          required
          disabled={locked}
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
        />
      </label>
      <div className="replenishment-preview">
        <strong>
          When stock falls below {minimum || '—'} {units}
        </strong>
        <p>
          Propose enough to reach {target || '—'} {units}. Above {limit || '—'}{' '}
          {units}, classify the proposal as high risk. Current workspace policy
          also requires approval for smaller drafts.
        </p>
      </div>
      {error || mutation.error ? (
        <Alert tone="danger" role="alert">
          {error || workflowError(mutation.error)}
        </Alert>
      ) : null}
      <Button
        type="submit"
        disabled={
          mutation.isPending ||
          !setup.positions.length ||
          !setup.suppliers.length
        }
      >
        {mutation.isPending
          ? 'Activating…'
          : uncertain
            ? 'Retry activation'
            : 'Activate reviewed rule'}
      </Button>
    </form>
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
