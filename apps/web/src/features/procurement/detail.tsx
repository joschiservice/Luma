import './procurement.css';

import type {
  Attention,
  Commitment,
  Communication,
  PurchaseOrderContext,
  PurchaseOrderRecord,
  PurchaseOrderStatus,
} from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { DomainIcon } from '@luma/ui/components/primitives/domain-icon';
import { Empty } from '@luma/ui/components/primitives/empty';
import { StateDot, StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
import {
  onlineManager,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Link, useLocation, useParams } from '@tanstack/react-router';
import {
  ArrowLeft,
  ArrowRight,
  FileX,
  MessageSquarePlus,
  RefreshCw,
  Send,
  Workflow,
} from 'lucide-react';
import { type ReactNode, useRef, useState, useSyncExternalStore } from 'react';

import { SignInRedirect } from '../identity/common';
import { IdentityError } from '../identity/data';
import { stockQuantity } from '../inventory/presentation';
import { WorkflowCoverageCard } from '../workflows/coverage';
import {
  checkSubmission,
  decideSubmission,
  procurementError,
  procurementKey,
  purchaseOrderContextOptions,
  purchaseOrderRecordOptions,
  readMessage,
  refreshPurchaseOrder,
  removeMessageText,
  reviewCommitment,
  sendSubmission,
} from './data';
import { TransitionDialog } from './forms';
import {
  calendarDate,
  commitmentKinds,
  commitmentSource,
  commitmentValue,
  lineStages,
  milestoneLabels,
  milestoneStates,
  ownerLabels,
  quantity,
  reviewReasonLabels,
  StagePill,
  statusLabels,
} from './presentation';
import {
  CommitmentDialog,
  type CommitmentDraft,
  LinkSupplierDialog,
  MessageDialog,
  RespondDialog,
  SubmitDialog,
} from './record-dialogs';

const subscribe = (changed: () => void) => onlineManager.subscribe(changed);
const onlineSnapshot = () => onlineManager.isOnline();
const serverSnapshot = () => true;

type Dialog =
  | { kind: 'submit' }
  | { kind: 'message' }
  | { kind: 'link' }
  | { kind: 'commitment'; draft: CommitmentDraft }
  | { kind: 'respond'; attention: Attention }
  | { kind: 'transition'; status: PurchaseOrderStatus };

/** Loads a purchase order's record and its stock context, and keeps both fresh. */
export function PurchaseOrderPage() {
  const { organizationId, purchaseOrderId } = useParams({
    from: '/app/$organizationId/procurement/$purchaseOrderId',
  });
  const record = useQuery({
    ...purchaseOrderRecordOptions(organizationId, purchaseOrderId),
    refetchInterval: (query) =>
      query.state.data &&
      ['awaiting_approval', 'sending'].includes(query.state.data.stage)
        ? 5000
        : false,
  });
  const context = useQuery(
    purchaseOrderContextOptions(organizationId, purchaseOrderId),
  );
  const online = useSyncExternalStore(
    subscribe,
    onlineSnapshot,
    serverSnapshot,
  );
  if (record.error instanceof IdentityError && record.error.status === 401)
    return <SignInRedirect />;

  return (
    <PurchaseOrderRecordView
      organizationId={organizationId}
      record={record.data}
      context={context.data}
      contextError={!!context.error}
      loading={record.isPending}
      refreshing={record.isFetching}
      offline={!online}
      error={
        !record.error
          ? undefined
          : record.error instanceof IdentityError && record.error.status === 404
            ? 'missing'
            : procurementError(record.error)
      }
      reload={() => {
        void record.refetch();
        void context.refetch();
      }}
    />
  );
}

/** Shows how far an order has come, what is pending, and who acts next. */
export function PurchaseOrderRecordView({
  organizationId,
  record,
  context,
  contextError = false,
  loading = false,
  refreshing = false,
  offline = false,
  error,
  reload,
}: {
  organizationId: string;
  record?: PurchaseOrderRecord | undefined;
  context?: PurchaseOrderContext | undefined;
  contextError?: boolean;
  loading?: boolean;
  refreshing?: boolean;
  offline?: boolean;
  /** `missing`, or a message for an unavailable record. */
  error?: string | undefined;
  reload: () => void;
}) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const client = useQueryClient();
  const invalidate = () =>
    client.invalidateQueries({ queryKey: procurementKey(organizationId) });
  const sync = useMutation({
    mutationFn: () => refreshPurchaseOrder(organizationId, record!.order.id),
    onSuccess: invalidate,
  });
  const order = record?.order;

  return (
    <main className="procurement-page procurement-record">
      <Link
        className="procurement-back"
        to="/app/$organizationId/procurement"
        params={{ organizationId }}
        search={{ view: 'orders', q: '', status: '' }}
      >
        <ArrowLeft size={14} aria-hidden="true" />
        Purchase orders
      </Link>
      <PageHeader
        title={order?.reference ?? 'Purchase order'}
        icon={<DomainIcon domain="procurement" size="md" />}
        description={
          record && order ? (
            <>
              <Link
                to="/app/$organizationId/procurement/suppliers/$supplierId"
                params={{ organizationId, supplierId: order.supplierId }}
              >
                {order.supplierName}
              </Link>
              {` · ${order.lines.length} ${order.lines.length === 1 ? 'line' : 'lines'}`}
              {record.submission?.externalOrder?.orderNumber
                ? ` · Order ${record.submission.externalOrder.orderNumber} in ${record.readiness.connection?.label ?? 'the purchasing system'}`
                : ''}
            </>
          ) : (
            'Supplier commitments from draft to goods received.'
          )
        }
      />
      <div className="procurement-record-toolbar">
        <span className="procurement-flags">
          {record ? <StagePill stage={record.stage} /> : null}
          {order ? (
            <Badge>
              {order.authority === 'luma' ? 'Luma-owned' : 'Externally owned'}
            </Badge>
          ) : null}
          {record?.draftVerified ? (
            <Badge tone="success">Draft verified</Badge>
          ) : null}
        </span>
        <span className="procurement-flags">
          {record?.submission?.state === 'submitted' ? (
            <Button
              variant="outline"
              disabled={sync.isPending || offline}
              title={`Read confirmations and goods receipts from ${record.readiness.connection?.label ?? 'the purchasing system'} now`}
              onClick={() => sync.mutate()}
            >
              <RefreshCw size={14} aria-hidden="true" />
              {sync.isPending ? 'Checking…' : 'Check for updates'}
            </Button>
          ) : null}
          <Button variant="ghost" disabled={refreshing} onClick={reload}>
            <RefreshCw size={14} aria-hidden="true" />
            Refresh
          </Button>
        </span>
      </div>
      {offline ? (
        <Alert role="status">
          You are offline. Reconnect to refresh this order.
        </Alert>
      ) : null}
      {sync.error ? (
        <Alert tone="warning" role="alert">
          {procurementError(sync.error)}
        </Alert>
      ) : null}
      {error === 'missing' ? (
        <Empty>
          <FileX size={30} aria-hidden="true" />
          <h2>Purchase order not found</h2>
          <p>This order is not in this workspace.</p>
          <Link
            to="/app/$organizationId/procurement"
            params={{ organizationId }}
            search={{ view: 'orders', q: '', status: '' }}
          >
            Browse purchase orders
          </Link>
        </Empty>
      ) : error ? (
        <Alert tone="danger" role="alert">
          {record
            ? 'This order could not be refreshed. The details below may be out of date.'
            : error}{' '}
          <Button variant="outline" onClick={reload}>
            Retry
          </Button>
        </Alert>
      ) : null}
      {!record && loading && !error ? (
        <div className="procurement-skeleton" role="status">
          <span className="sr-only">Loading purchase order…</span>
          {Array.from({ length: 3 }, (_, i) => (
            <span className="lu-skeleton" key={i} />
          ))}
        </div>
      ) : null}
      {record && order && error !== 'missing' ? (
        <>
          <Milestones record={record} />
          <div className="procurement-record-layout">
            <div className="procurement-record-main">
              <NextStep
                organizationId={organizationId}
                record={record}
                open={setDialog}
              />
              <Lines
                organizationId={organizationId}
                record={record}
                context={context}
                contextError={contextError}
              />
              <Messages
                organizationId={organizationId}
                record={record}
                open={setDialog}
              />
              <CommitmentHistory record={record} open={setDialog} />
              <Lifecycle record={record} />
            </div>
            <aside className="procurement-record-aside">
              <SupplierCard
                organizationId={organizationId}
                record={record}
                open={setDialog}
              />
              <TraceCard organizationId={organizationId} context={context} />
              <IssuesCard organizationId={organizationId} context={context} />
              <OrderCard record={record} open={setDialog} />
            </aside>
          </div>
        </>
      ) : null}
      {record && dialog?.kind === 'submit' ? (
        <SubmitDialog
          organizationId={organizationId}
          record={record}
          close={() => setDialog(null)}
        />
      ) : null}
      {record && dialog?.kind === 'message' ? (
        <MessageDialog
          organizationId={organizationId}
          record={record}
          close={() => setDialog(null)}
        />
      ) : null}
      {record?.supplier && dialog?.kind === 'link' ? (
        <LinkSupplierDialog
          organizationId={organizationId}
          supplier={record.supplier}
          close={() => setDialog(null)}
        />
      ) : null}
      {record && dialog?.kind === 'commitment' ? (
        <CommitmentDialog
          organizationId={organizationId}
          record={record}
          draft={dialog.draft}
          close={() => setDialog(null)}
        />
      ) : null}
      {record && dialog?.kind === 'respond' ? (
        <RespondDialog
          organizationId={organizationId}
          orderId={record.order.id}
          attention={dialog.attention}
          close={() => setDialog(null)}
        />
      ) : null}
      {order && dialog?.kind === 'transition' ? (
        <TransitionDialog
          key={`${order.id}:${order.revision}:${dialog.status}`}
          organizationId={organizationId}
          order={order}
          status={dialog.status}
          close={() => setDialog(null)}
        />
      ) : null}
    </main>
  );
}

/** The four supplier milestones, each with the evidence behind its state. */
function Milestones({ record }: { record: PurchaseOrderRecord }) {
  return (
    <ol className="procurement-milestones" aria-label="Order progress">
      {record.progress.milestones.map((milestone) => {
        const state = milestoneStates[milestone.state];

        return (
          <li key={milestone.key} data-state={milestone.state}>
            <StateDot state={state.state} />
            <div>
              <h2>{milestoneLabels[milestone.key]}</h2>
              <p className="procurement-milestone-state">
                {state.label}
                {milestone.at ? (
                  <>
                    {' · '}
                    <WorkspaceDate value={milestone.at} />
                  </>
                ) : null}
              </p>
              <p>{milestone.evidence}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Who acts next and the controls they need, including attention items and approvals. */
function NextStep({
  organizationId,
  record,
  open,
  inline = false,
}: {
  organizationId: string;
  record: PurchaseOrderRecord;
  open: (dialog: Dialog) => void;
  /** Rendered outside the record page; message reviews are listed by the caller. */
  inline?: boolean;
}) {
  const { progress, submission, readiness, canManage, order } = record;
  const client = useQueryClient();
  const invalidate = () =>
    client.invalidateQueries({ queryKey: procurementKey(organizationId) });
  const decide = useMutation({
    mutationFn: (outcome: 'approved' | 'rejected') =>
      decideSubmission(organizationId, submission!.id, {
        decisionId: submission!.decisionId!,
        outcome,
      }),
    onSettled: invalidate,
  });
  const send = useMutation({
    mutationFn: () => sendSubmission(organizationId, submission!.id),
    onSettled: invalidate,
  });
  const check = useMutation({
    mutationFn: () => checkSubmission(organizationId, submission!.id),
    onSettled: invalidate,
  });
  const failure = decide.error ?? send.error ?? check.error;
  const canSend =
    canManage &&
    order.authority === 'luma' &&
    ['draft', 'open'].includes(order.status) &&
    (!submission ||
      ['rejected', 'expired', 'failed'].includes(submission.state));
  const others = progress.attention.filter(
    (a) => !['submission_approval', 'submission_uncertain'].includes(a.kind),
  );

  return (
    <Card as="section" className="procurement-next" aria-labelledby="next-step">
      <div className="procurement-next-heading">
        <p className="procurement-eyebrow">Next step</p>
        <Badge tone={progress.next.owner === 'none' ? 'neutral' : 'accent'}>
          {ownerLabels[progress.next.owner]}
        </Badge>
      </div>
      <h2 id="next-step">{progress.next.title}</h2>
      <p className="procurement-note">{progress.next.detail}</p>
      {submission && !['submitted'].includes(submission.state) ? (
        <Alert
          tone={
            ['failed', 'rejected', 'expired', 'uncertain'].includes(
              submission.state,
            )
              ? 'warning'
              : 'info'
          }
        >
          {submission.message}
        </Alert>
      ) : null}
      {submission?.state === 'approval_required' ? (
        <dl className="procurement-send-facts">
          <div>
            <dt>Requested delivery</dt>
            <dd>{calendarDate(submission.requestedDeliveryDate)}</dd>
          </div>
          <div>
            <dt>Requested</dt>
            <dd>
              <WorkspaceDate value={submission.requestedAt} />
            </dd>
          </div>
          <div>
            <dt>Approval expires</dt>
            <dd>
              <WorkspaceDate value={submission.expiresAt} />
            </dd>
          </div>
        </dl>
      ) : null}
      <div className="procurement-next-actions">
        {submission?.canApprove ? (
          <>
            <Button
              disabled={decide.isPending}
              onClick={() => decide.mutate('approved')}
            >
              <Send size={14} aria-hidden="true" />
              {decide.isPending ? 'Sending…' : 'Approve and send'}
            </Button>
            <Button
              variant="outline"
              disabled={decide.isPending}
              onClick={() => decide.mutate('rejected')}
            >
              Reject
            </Button>
          </>
        ) : null}
        {submission?.canSend ? (
          <Button disabled={send.isPending} onClick={() => send.mutate()}>
            <Send size={14} aria-hidden="true" />
            {send.isPending ? 'Sending…' : 'Send now'}
          </Button>
        ) : null}
        {submission?.canCheck ? (
          <Button
            variant="outline"
            disabled={check.isPending}
            onClick={() => check.mutate()}
          >
            <RefreshCw size={14} aria-hidden="true" />
            {check.isPending ? 'Checking…' : 'Check purchasing system'}
          </Button>
        ) : null}
        {canSend && readiness.ready ? (
          <Button onClick={() => open({ kind: 'submit' })}>
            <Send size={14} aria-hidden="true" />
            Send to supplier
          </Button>
        ) : null}
        {canSend &&
        !readiness.ready &&
        !record.supplier?.link &&
        record.supplier ? (
          <Button variant="outline" onClick={() => open({ kind: 'link' })}>
            Link supplier
          </Button>
        ) : null}
      </div>
      {canSend && !readiness.ready ? (
        <ul className="procurement-blockers" aria-label="Before sending">
          {readiness.blockers.map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      ) : null}
      {failure ? (
        <Alert tone="danger" role="alert">
          {procurementError(failure)}
        </Alert>
      ) : null}
      {others.length ? (
        <ul className="procurement-attention" aria-label="Needs a response">
          {others.map((attention) => (
            <li key={attention.key}>
              <StateDot
                state={
                  attention.kind === 'review_commitment'
                    ? 'approval'
                    : 'attention'
                }
              />
              <span>
                <strong>{attention.summary}</strong>
                <small>
                  {attention.kind === 'review_commitment'
                    ? 'Read from a supplier message. Review it below.'
                    : attention.kind === 'commitment_changed'
                      ? 'Differs from the order'
                      : 'Overdue since '}
                  {attention.kind.endsWith('overdue') ? (
                    <WorkspaceDate value={attention.dueAt} />
                  ) : null}
                </small>
              </span>
              {canManage && attention.kind !== 'review_commitment' ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => open({ kind: 'respond', attention })}
                >
                  {attention.kind === 'commitment_changed'
                    ? 'Accept or follow up'
                    : 'Record follow-up'}
                </Button>
              ) : attention.kind === 'review_commitment' && !inline ? (
                <a
                  className="procurement-inline-link"
                  href="#supplier-messages"
                >
                  Review
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

/** Each line's ordered, confirmed and received quantities, expected date and current stock. */
function Lines({
  organizationId,
  record,
  context,
  contextError,
}: {
  organizationId: string;
  record: PurchaseOrderRecord;
  context?: PurchaseOrderContext | undefined;
  contextError: boolean;
}) {
  const rows = record.progress.lines.map((line) => ({
    line,
    context: context?.lines.find((c) => c.lineId === line.lineId),
  }));

  return (
    <section className="procurement-section" aria-labelledby="order-lines">
      <div className="procurement-section-heading">
        <h2 id="order-lines">Lines and stock</h2>
        {record.progress.expectedDate ? (
          <span>
            Next expected {calendarDate(record.progress.expectedDate)}
          </span>
        ) : null}
      </div>
      <DataTable
        caption="Order lines with supplier commitments and stock"
        density="compact"
        rows={rows}
        rowKey={(row) => row.line.lineId}
        columns={[
          {
            key: 'item',
            header: 'Item',
            cell: ({ line, context }) => (
              <span className="procurement-cell">
                {context?.skuId ? (
                  <Link
                    to="/app/$organizationId/products/$skuId"
                    params={{ organizationId, skuId: context.skuId }}
                  >
                    {line.description}
                  </Link>
                ) : (
                  <span>{line.description}</span>
                )}
                <small>
                  <code>{context?.positions[0]?.sku ?? line.sku}</code>
                  {line.overdue ? ' · overdue' : ''}
                </small>
              </span>
            ),
          },
          {
            key: 'ordered',
            header: 'Ordered',
            numeric: true,
            cell: ({ line }) => `${quantity(line.ordered)} ${line.unit}`,
          },
          {
            key: 'confirmed',
            header: 'Confirmed',
            numeric: true,
            cell: ({ line }) =>
              line.confirmed === null ? (
                <span className="procurement-muted">—</span>
              ) : (
                <span
                  className={
                    Math.abs(line.confirmed - line.ordered) > 1e-9
                      ? 'procurement-changed'
                      : undefined
                  }
                >
                  {quantity(line.confirmed)}
                </span>
              ),
          },
          {
            key: 'received',
            header: 'Received',
            numeric: true,
            cell: ({ line }) => (
              <span className="procurement-cell procurement-cell-end">
                <span>{quantity(line.received)}</span>
                {line.outstanding > 1e-9 && line.received > 0 ? (
                  <small>{quantity(line.outstanding)} open</small>
                ) : null}
              </span>
            ),
          },
          {
            key: 'expected',
            header: 'Expected',
            hideOnNarrow: true,
            cell: ({ line }) =>
              line.stage === 'received' ? (
                <span className="procurement-muted">Arrived</span>
              ) : line.expectedDate ? (
                <span className="procurement-cell">
                  <span>{calendarDate(line.expectedDate)}</span>
                  <small>{line.promisedDate ? 'Promised' : 'Requested'}</small>
                </span>
              ) : (
                <span className="procurement-muted">Not set</span>
              ),
          },
          {
            key: 'stock',
            header: 'Stock now',
            hideOnNarrow: true,
            cell: ({ context }) =>
              contextError ? (
                <span className="procurement-muted">Unavailable</span>
              ) : !context ? (
                <span className="procurement-muted">…</span>
              ) : context.positions.length ? (
                <span className="procurement-cell">
                  {context.positions.slice(0, 2).map((position) => (
                    <Link
                      key={position.id}
                      to="/app/$organizationId/inventory/$positionId"
                      params={{ organizationId, positionId: position.id }}
                    >
                      {position.sources
                        .map(
                          (s) =>
                            `${s.deleted ? 'removed' : stockQuantity(s.available)} ${position.unit}`,
                        )
                        .join(' / ')}{' '}
                      <small>{position.location}</small>
                    </Link>
                  ))}
                  {context.otherOrders.length ? (
                    <small>
                      Also on {context.otherOrders.length} other{' '}
                      {context.otherOrders.length === 1 ? 'order' : 'orders'}
                    </small>
                  ) : null}
                </span>
              ) : (
                <span className="procurement-muted">
                  {context.skuId ? 'No stock observed' : 'Unknown SKU'}
                </span>
              ),
          },
          {
            key: 'stage',
            header: 'State',
            hideOnNarrow: true,
            cell: ({ line }) => (
              <StatePill state={lineStages[line.stage].state}>
                {lineStages[line.stage].label}
              </StatePill>
            ),
          },
        ]}
      />
      <p className="procurement-note">
        Receipt counts only what the purchasing system booked as received. Stock
        is shown per source and location; sources are never added together.
      </p>
    </section>
  );
}

/** Splits message text into plain and highlighted runs for the commitments that cite it. */
function segments(
  text: string,
  marks: {
    start: number;
    end: number;
    id: string;
    status: Commitment['status'];
  }[],
) {
  const sorted = [...marks]
    .filter((m) => m.start >= 0 && m.end <= text.length && m.end > m.start)
    .sort((a, b) => a.start - b.start);
  const out: { text: string; mark?: (typeof sorted)[number] }[] = [];
  let at = 0;
  for (const mark of sorted) {
    if (mark.start < at) continue;
    if (mark.start > at) out.push({ text: text.slice(at, mark.start) });
    out.push({ text: text.slice(mark.start, mark.end), mark });
    at = mark.end;
  }
  if (at < text.length) out.push({ text: text.slice(at) });

  return out;
}

/** Supplier messages with the facts read from them, and controls to review or record more. */
function Messages({
  organizationId,
  record,
  open,
}: {
  organizationId: string;
  record: PurchaseOrderRecord;
  open: (dialog: Dialog) => void;
}) {
  const { communications, extractions, commitments, canManage } = record;

  return (
    <section
      className="procurement-section"
      aria-labelledby="supplier-messages"
      id="supplier-messages"
    >
      <div className="procurement-section-heading">
        <h2>
          <span id="supplier-messages-title">Supplier messages</span>
        </h2>
        {canManage ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => open({ kind: 'message' })}
          >
            <MessageSquarePlus size={14} aria-hidden="true" />
            Add message
          </Button>
        ) : null}
      </div>
      {!record.extraction.available && canManage ? (
        <p className="procurement-note">
          {record.extraction.reason ??
            'Automatic reading isn’t set up on this server.'}{' '}
          Select words in a message to record what the supplier committed to.
        </p>
      ) : null}
      {communications.length ? (
        <ol className="procurement-messages">
          {communications.map((communication) => (
            <Message
              key={communication.id}
              organizationId={organizationId}
              communication={communication}
              extraction={extractions
                .filter((e) => e.communicationId === communication.id)
                .at(-1)}
              commitments={commitments.filter(
                (c) =>
                  c.source.kind === 'communication' &&
                  c.source.communicationId === communication.id,
              )}
              record={record}
              open={open}
            />
          ))}
        </ol>
      ) : (
        <p className="procurement-empty">
          No supplier messages yet. Add the supplier’s order confirmation or
          delivery notice to track what they committed to.
        </p>
      )}
    </section>
  );
}

function Message({
  organizationId,
  communication,
  extraction,
  commitments,
  record,
  open,
}: {
  organizationId: string;
  communication: Communication;
  extraction: PurchaseOrderRecord['extractions'][number] | undefined;
  commitments: Commitment[];
  record: PurchaseOrderRecord;
  open: (dialog: Dialog) => void;
}) {
  const textRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{
    start: number;
    end: number;
    quote: string;
  } | null>(null);
  const client = useQueryClient();
  const invalidate = () =>
    client.invalidateQueries({ queryKey: procurementKey(organizationId) });
  const review = useMutation({
    mutationFn: (input: {
      id: string;
      outcome: 'confirmed' | 'rejected';
      acceptChange: boolean;
    }) =>
      reviewCommitment(organizationId, input.id, {
        outcome: input.outcome,
        acceptChange: input.acceptChange,
      }),
    onSettled: invalidate,
  });
  const reread = useMutation({
    mutationFn: () => readMessage(organizationId, communication.id),
    onSettled: invalidate,
  });
  const remove = useMutation({
    mutationFn: () => removeMessageText(organizationId, communication.id),
    onSettled: invalidate,
  });
  const purged = communication.body === null;
  const text = purged
    ? ''
    : `${communication.subject ?? ''}\n\n${communication.body ?? ''}`;
  const unit = (lineId: string | null) =>
    record.order.lines.find((l) => l.id === lineId)?.unit;
  const lineLabel = (lineId: string | null) =>
    record.order.lines.find((l) => l.id === lineId)?.description ??
    'Whole order';

  const capture = () => {
    const root = textRef.current;
    const current = window.getSelection();
    if (!root || !current || current.rangeCount === 0 || current.isCollapsed) {
      setSelection(null);

      return;
    }
    const range = current.getRangeAt(0);
    if (
      !root.contains(range.startContainer) ||
      !root.contains(range.endContainer)
    ) {
      setSelection(null);

      return;
    }
    const before = document.createRange();
    before.selectNodeContents(root);
    before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length;
    const quote = range.toString();
    if (quote.trim()) setSelection({ start, end: start + quote.length, quote });
  };

  return (
    <li className="procurement-message">
      <header>
        <span className="procurement-cell">
          <strong>{communication.from}</strong>
          <small>
            <WorkspaceDate value={communication.receivedAt} /> ·{' '}
            {communication.channel === 'email'
              ? 'Email'
              : communication.channel === 'portal'
                ? 'Supplier portal'
                : communication.channel === 'phone'
                  ? 'Phone notes'
                  : 'Other'}
          </small>
        </span>
        {extraction ? (
          <Badge
            tone={
              extraction.state === 'completed'
                ? 'info'
                : extraction.state === 'failed'
                  ? 'warning'
                  : 'neutral'
            }
          >
            {extraction.state === 'completed'
              ? `${commitments.length} ${commitments.length === 1 ? 'fact' : 'facts'} read`
              : extraction.state === 'failed'
                ? 'Not read'
                : 'Not read automatically'}
          </Badge>
        ) : null}
      </header>
      {purged ? (
        <p className="procurement-note">
          Message text removed{' '}
          {communication.purgeReason === 'retention'
            ? 'after the retention period'
            : 'on request'}
          . Recorded commitments remain.
        </p>
      ) : (
        <div
          ref={textRef}
          className="procurement-message-text"
          onMouseUp={record.canManage ? capture : undefined}
          onKeyUp={record.canManage ? capture : undefined}
          tabIndex={0}
          aria-label={`Message from ${communication.from}`}
        >
          {segments(
            text,
            commitments.map((c) => ({
              ...(c.source.kind === 'communication'
                ? c.source.span
                : { start: 0, end: 0 }),
              id: c.id,
              status: c.status,
            })),
          ).map((part, index) =>
            part.mark ? (
              <mark key={index} data-status={part.mark.status}>
                {part.text}
              </mark>
            ) : (
              <span key={index}>{part.text}</span>
            ),
          )}
        </div>
      )}
      {selection && record.canManage ? (
        <div className="procurement-selection" role="status">
          <span>
            “{selection.quote.slice(0, 80)}
            {selection.quote.length > 80 ? '…' : ''}”
          </span>
          <Button
            size="sm"
            onClick={() => {
              open({
                kind: 'commitment',
                draft: {
                  mode: 'message',
                  communicationId: communication.id,
                  span: { start: selection.start, end: selection.end },
                  quote: selection.quote,
                },
              });
              setSelection(null);
            }}
          >
            Record what this says
          </Button>
        </div>
      ) : null}
      {extraction?.state === 'failed' || extraction?.state === 'unavailable' ? (
        extraction.state === 'failed' && record.canManage && !purged ? (
          <p className="procurement-note">
            {extraction.reason}{' '}
            <Button
              size="sm"
              variant="ghost"
              disabled={reread.isPending}
              onClick={() => reread.mutate()}
            >
              Read again
            </Button>
          </p>
        ) : null
      ) : null}
      {extraction?.state === 'completed' &&
      extraction.relatesToOrder === false ? (
        <Alert tone="warning">
          This message may not be about {record.order.reference}. Its facts wait
          for review.
        </Alert>
      ) : null}
      {commitments.length ? (
        <ul className="procurement-facts">
          {commitments.map((c) => (
            <li key={c.id} data-status={c.status}>
              <StateDot
                state={
                  c.status === 'confirmed'
                    ? 'verified'
                    : c.status === 'rejected'
                      ? 'idle'
                      : 'approval'
                }
              />
              <span className="procurement-cell">
                <strong>
                  {commitmentKinds[c.kind]}:{' '}
                  {commitmentValue(c, unit(c.lineId))}
                </strong>
                <small>
                  {lineLabel(c.lineId)} ·{' '}
                  {c.status === 'needs_review'
                    ? c.reviewReasons
                        .map((r) => reviewReasonLabels[r])
                        .join(', ') || 'Needs review'
                    : c.status === 'rejected'
                      ? 'Rejected'
                      : c.source.kind === 'communication' && c.source.extraction
                        ? 'Read automatically'
                        : 'Recorded by hand'}
                </small>
              </span>
              {c.status === 'needs_review' && record.canManage ? (
                <span className="procurement-fact-actions">
                  <Button
                    size="sm"
                    disabled={review.isPending}
                    onClick={() =>
                      review.mutate({
                        id: c.id,
                        outcome: 'confirmed',
                        acceptChange: c.reviewReasons.some((r) =>
                          [
                            'quantity_changed',
                            'date_later',
                            'supplier_condition',
                          ].includes(r),
                        ),
                      })
                    }
                  >
                    {c.reviewReasons.some((r) =>
                      [
                        'quantity_changed',
                        'date_later',
                        'supplier_condition',
                      ].includes(r),
                    )
                      ? 'Confirm and accept'
                      : 'Confirm'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={review.isPending}
                    onClick={() =>
                      review.mutate({
                        id: c.id,
                        outcome: 'rejected',
                        acceptChange: false,
                      })
                    }
                  >
                    Reject
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {review.error || reread.error || remove.error ? (
        <Alert tone="danger" role="alert">
          {procurementError(review.error ?? reread.error ?? remove.error)}
        </Alert>
      ) : null}
      {!purged && record.canManage ? (
        <Disclosure variant="plain" className="procurement-message-more">
          <summary>Message details</summary>
          <p className="procurement-note">
            Kept until <WorkspaceDate value={communication.retainUntil} />, then
            the text is removed.{' '}
            {communication.messageId ? (
              <>
                Message ID <code>{communication.messageId}</code>.
              </>
            ) : null}
          </p>
          <Button
            size="sm"
            variant="ghost"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            Remove message text now
          </Button>
        </Disclosure>
      ) : null}
    </li>
  );
}

/** Every commitment in recorded order, with its source; corrections never overwrite. */
function CommitmentHistory({
  record,
  open,
}: {
  record: PurchaseOrderRecord;
  open: (dialog: Dialog) => void;
}) {
  const label = record.readiness.connection?.label ?? null;
  const entries = [...record.commitments].reverse();
  const unit = (lineId: string | null) =>
    record.order.lines.find((l) => l.id === lineId)?.unit;

  return (
    <section
      className="procurement-section"
      aria-labelledby="commitment-history"
    >
      <div className="procurement-section-heading">
        <h2 id="commitment-history">Commitment history</h2>
        <span>{record.commitments.length} recorded</span>
      </div>
      {entries.length ? (
        <ol className="procurement-commitments">
          {entries.map((c) => {
            const corrected = record.commitments.some(
              (o) => o.supersedes === c.id,
            );

            return (
              <li key={c.id} data-status={c.status} data-corrected={corrected}>
                <StateDot
                  state={
                    c.kind === 'received'
                      ? 'verified'
                      : c.status === 'needs_review'
                        ? 'approval'
                        : c.status === 'rejected' || corrected
                          ? 'idle'
                          : 'waiting'
                  }
                />
                <span className="procurement-cell">
                  <strong>
                    {commitmentKinds[c.kind]}:{' '}
                    {commitmentValue(c, unit(c.lineId))}
                    {corrected ? ' · corrected' : ''}
                  </strong>
                  <small>
                    {record.order.lines.find((l) => l.id === c.lineId)
                      ?.description ?? 'Whole order'}{' '}
                    · {commitmentSource(c, label)} ·{' '}
                    <WorkspaceDate value={c.recordedAt} />
                  </small>
                  {c.source.kind === 'correction' ? (
                    <small>Reason: {c.source.reason}</small>
                  ) : null}
                </span>
                {record.canManage &&
                c.kind !== 'received' &&
                c.status === 'confirmed' &&
                !corrected ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      open({
                        kind: 'commitment',
                        draft: { mode: 'correction', commitment: c },
                      })
                    }
                  >
                    Correct
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="procurement-empty">
          No commitments yet. They appear when the supplier confirms in the
          purchasing system or in a message.
        </p>
      )}
      {record.observations.length ? (
        <Disclosure>
          <summary>
            Purchasing-system reads ({record.observations.length})
          </summary>
          <ol className="procurement-reads">
            {record.observations.map((o) => (
              <li key={o.id}>
                <WorkspaceDate value={o.observedAt} /> · order{' '}
                {o.orderNumber ?? o.externalId} ·{' '}
                {o.status.replaceAll('_', ' ')}
                {o.confirmed ? ' · confirmed' : ''}
              </li>
            ))}
          </ol>
        </Disclosure>
      ) : null}
    </section>
  );
}

/** Audited lifecycle changes recorded in Luma. */
function Lifecycle({ record }: { record: PurchaseOrderRecord }) {
  return (
    <section
      className="procurement-section"
      aria-labelledby="lifecycle-history"
    >
      <div className="procurement-section-heading">
        <h2 id="lifecycle-history">Status history in Luma</h2>
        <span>Revision {record.order.revision}</span>
      </div>
      <ol className="procurement-commitments">
        {record.history.map((event) => (
          <li key={event.id}>
            <StateDot state="idle" />
            <span className="procurement-cell">
              <strong>
                {event.from
                  ? `${statusLabels[event.from]} → ${statusLabels[event.to]}`
                  : 'Purchase order created'}
              </strong>
              <small>
                <WorkspaceDate value={event.occurredAt} />
                {event.from ? ` · ${event.reason}` : ''}
              </small>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** The supplier, its purchasing link and follow-up terms. */
function SupplierCard({
  organizationId,
  record,
  open,
}: {
  organizationId: string;
  record: PurchaseOrderRecord;
  open: (dialog: Dialog) => void;
}) {
  const supplier = record.supplier;

  return (
    <Card
      as="section"
      className="procurement-side"
      aria-labelledby="side-supplier"
    >
      <h2 id="side-supplier">Supplier</h2>
      <dl className="procurement-side-facts">
        <Fact label="Name">
          <Link
            to="/app/$organizationId/procurement/suppliers/$supplierId"
            params={{ organizationId, supplierId: record.order.supplierId }}
          >
            {record.order.supplierName}
          </Link>
        </Fact>
        <Fact label="Purchasing link">
          {supplier?.link ? (
            <>
              {supplier.link.name ?? `Supplier ${supplier.link.externalId}`}
              <small>
                in {record.readiness.connection?.label ?? 'a purchasing system'}
              </small>
            </>
          ) : (
            <span className="procurement-muted">Not linked</span>
          )}
        </Fact>
        <Fact label="Confirmation expected within">
          {supplier?.confirmationHours ?? 48} hours
        </Fact>
        {record.progress.confirmationDueAt ? (
          <Fact label="Confirmation due">
            <WorkspaceDate value={record.progress.confirmationDueAt} />
          </Fact>
        ) : null}
      </dl>
      {record.canManage && supplier ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => open({ kind: 'link' })}
        >
          {supplier.link ? 'Change link' : 'Link supplier'}
        </Button>
      ) : null}
    </Card>
  );
}

/** The replenishment decision that created this draft, from the run's recorded evidence. */
function TraceCard({
  organizationId,
  context,
}: {
  organizationId: string;
  context?: PurchaseOrderContext | undefined;
}) {
  const trace = context?.replenishment;
  const here = useLocation({ select: (location) => location.href });
  if (!trace) return null;
  const unit = trace.stock.unit ?? '';

  return (
    <>
      <Card
        as="section"
        className="procurement-side"
        aria-labelledby="side-trace"
      >
        <h2 id="side-trace">
          <Workflow size={14} aria-hidden="true" /> Why it was ordered
        </h2>
        <ol className="procurement-trace">
          <li>
            <StateDot state="verified" />
            <span className="procurement-cell">
              <strong>
                Stock{' '}
                {trace.stock.available === null
                  ? 'unknown'
                  : `${quantity(trace.stock.available)} ${unit}`}
                {trace.minimum !== null
                  ? `, below ${quantity(trace.minimum)}`
                  : ''}
              </strong>
              <small>
                {trace.location ?? 'Stock position'}
                {trace.stock.checkedAt ? (
                  <>
                    {' · checked '}
                    <WorkspaceDate value={trace.stock.checkedAt} />
                  </>
                ) : null}
              </small>
            </span>
          </li>
          <li>
            <StateDot state="verified" />
            <span className="procurement-cell">
              <strong>
                Proposed{' '}
                {trace.proposedQuantity === null
                  ? '—'
                  : quantity(trace.proposedQuantity)}{' '}
                {unit}
              </strong>
              <small>
                Refill to {trace.target === null ? '—' : quantity(trace.target)}{' '}
                {unit}
              </small>
            </span>
          </li>
          <li>
            <StateDot
              state={
                trace.approval === 'approved'
                  ? 'verified'
                  : trace.approval === 'rejected'
                    ? 'error'
                    : 'approval'
              }
            />
            <span className="procurement-cell">
              <strong>
                {trace.approval === 'approved'
                  ? 'Approved by a second person'
                  : trace.approval === 'rejected'
                    ? 'Rejected'
                    : trace.approval === 'pending'
                      ? 'Waiting for approval'
                      : 'Approval not recorded'}
              </strong>
              {trace.approvedAt ? (
                <small>
                  <WorkspaceDate value={trace.approvedAt} />
                </small>
              ) : null}
            </span>
          </li>
          <li>
            <StateDot
              state={
                trace.verification === 'verified'
                  ? 'verified'
                  : trace.verification === 'failed'
                    ? 'error'
                    : 'waiting'
              }
            />
            <span className="procurement-cell">
              <strong>
                {trace.verification === 'verified'
                  ? 'Draft verified by a separate read'
                  : trace.verification === 'failed'
                    ? 'Draft verification failed'
                    : trace.verification === 'inconclusive'
                      ? 'Draft verification inconclusive'
                      : 'Draft not verified yet'}
              </strong>
              {trace.verifiedAt ? (
                <small>
                  <WorkspaceDate value={trace.verifiedAt} />
                </small>
              ) : null}
            </span>
          </li>
        </ol>
        <div className="procurement-side-links">
          {trace.positionId ? (
            <Link
              to="/app/$organizationId/inventory/$positionId"
              params={{ organizationId, positionId: trace.positionId }}
              search={{ from: here }}
            >
              Stock position <ArrowRight size={13} aria-hidden="true" />
            </Link>
          ) : null}
          <Link
            to="/app/$organizationId/workflows/$definitionId"
            params={{ organizationId, definitionId: trace.definitionId }}
            search={{}}
            hash={`run-${trace.runId}`}
          >
            Workflow run <ArrowRight size={13} aria-hidden="true" />
          </Link>
        </div>
      </Card>
      {trace.positionId ? (
        <WorkflowCoverageCard
          organizationId={organizationId}
          positionId={trace.positionId}
          className="procurement-side"
        />
      ) : null}
    </>
  );
}

/** Issues about the ordered SKUs or their stock. */
function IssuesCard({
  organizationId,
  context,
}: {
  organizationId: string;
  context?: PurchaseOrderContext | undefined;
}) {
  if (!context) return null;

  return (
    <Card
      as="section"
      className="procurement-side"
      aria-labelledby="side-issues"
    >
      <h2 id="side-issues">Related issues</h2>
      {context.issues.length ? (
        <ul className="procurement-side-list">
          {context.issues.map((issue) => (
            <li key={issue.id}>
              <Link
                to="/app/$organizationId/exceptions/$exceptionId"
                params={{ organizationId, exceptionId: issue.id }}
                search={{ view: 'needs_you' }}
              >
                {issue.label}
              </Link>
              <small>{issue.state.replaceAll('_', ' ')}</small>
            </li>
          ))}
        </ul>
      ) : (
        <p className="procurement-note">
          No issues for these SKUs or their stock.
        </p>
      )}
    </Card>
  );
}

/** Ownership, provenance and Luma status changes. */
function OrderCard({
  record,
  open,
}: {
  record: PurchaseOrderRecord;
  open: (dialog: Dialog) => void;
}) {
  const { order } = record;
  const allowed = record.canManage
    ? order.authority === 'luma'
      ? order.status === 'draft'
        ? (['open', 'cancelled'] as const)
        : order.status === 'open'
          ? (['closed', 'cancelled'] as const)
          : []
      : []
    : [];

  return (
    <Card
      as="section"
      className="procurement-side"
      aria-labelledby="side-order"
    >
      <h2 id="side-order">Order in Luma</h2>
      <dl className="procurement-side-facts">
        <Fact label="Status">{statusLabels[order.status]}</Fact>
        <Fact label="Created">
          <WorkspaceDate value={order.createdAt} />
        </Fact>
        <Fact label="Origin">
          {order.origin.workflowRunId
            ? 'Replenishment workflow'
            : 'Created in Luma'}
        </Fact>
        {order.externalReferences.map((ref) => (
          <Fact key={`${ref.system}:${ref.externalId}`} label={ref.system}>
            <code>{ref.externalId}</code>
          </Fact>
        ))}
      </dl>
      {allowed.length ? (
        <div className="procurement-side-actions">
          {allowed.map((status) => (
            <Button
              key={status}
              size="sm"
              variant="outline"
              onClick={() => open({ kind: 'transition', status })}
            >
              {status === 'open'
                ? 'Open order'
                : status === 'closed'
                  ? 'Close order'
                  : 'Cancel order'}
            </Button>
          ))}
        </div>
      ) : null}
      {order.status === 'open' &&
      record.stage !== 'received' &&
      record.submission?.state === 'submitted' ? (
        <p className="procurement-note">
          Closing records completion in Luma. It doesn’t cancel the order in the
          purchasing system.
        </p>
      ) : null}
      <Disclosure variant="plain">
        <summary>IDs</summary>
        <p className="procurement-note">
          Order <code>{order.id}</code>
        </p>
      </Disclosure>
    </Card>
  );
}

/**
 * The order's own controls for Needs you: approve or check a submission, answer changes and
 * missed deadlines, and review facts read from supplier messages.
 */
export function PurchaseOrderReview({
  organizationId,
  purchaseOrderId,
}: {
  organizationId: string;
  purchaseOrderId: string;
}) {
  const record = useQuery({
    ...purchaseOrderRecordOptions(organizationId, purchaseOrderId),
    refetchInterval: 5000,
  });
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const client = useQueryClient();
  const review = useMutation({
    mutationFn: (input: {
      id: string;
      outcome: 'confirmed' | 'rejected';
      acceptChange: boolean;
    }) =>
      reviewCommitment(organizationId, input.id, {
        outcome: input.outcome,
        acceptChange: input.acceptChange,
      }),
    onSettled: () =>
      client.invalidateQueries({ queryKey: procurementKey(organizationId) }),
  });
  if (record.isPending) return <p role="status">Loading the purchase order…</p>;
  if (!record.data)
    return (
      <p role="alert">
        {record.error instanceof IdentityError && record.error.status === 404
          ? 'This purchase order is missing or you no longer have access.'
          : procurementError(record.error)}
      </p>
    );
  const data = record.data;
  const pending = data.commitments.filter((c) => c.status === 'needs_review');
  const material = ['quantity_changed', 'date_later', 'supplier_condition'];

  return (
    <div className="procurement-review">
      <NextStep
        organizationId={organizationId}
        record={data}
        open={setDialog}
        inline
      />
      {pending.length ? (
        <ul className="procurement-facts" aria-label="Facts to review">
          {pending.map((c) => {
            const communication = data.communications.find(
              (m) =>
                c.source.kind === 'communication' &&
                m.id === c.source.communicationId,
            );
            const quote =
              communication?.body != null && c.source.kind === 'communication'
                ? `${communication.subject ?? ''}\n\n${communication.body}`.slice(
                    c.source.span.start,
                    c.source.span.end,
                  )
                : null;
            const unit = data.order.lines.find((l) => l.id === c.lineId)?.unit;

            return (
              <li key={c.id} data-status={c.status}>
                <StateDot state="approval" />
                <span className="procurement-cell">
                  <strong>
                    {commitmentKinds[c.kind]}: {commitmentValue(c, unit)}
                  </strong>
                  {quote ? <small>“{quote}”</small> : null}
                  <small>
                    {c.reviewReasons
                      .map((r) => reviewReasonLabels[r])
                      .join(', ')}
                  </small>
                </span>
                {data.canManage ? (
                  <span className="procurement-fact-actions">
                    <Button
                      size="sm"
                      disabled={review.isPending}
                      onClick={() =>
                        review.mutate({
                          id: c.id,
                          outcome: 'confirmed',
                          acceptChange: c.reviewReasons.some((r) =>
                            material.includes(r),
                          ),
                        })
                      }
                    >
                      Confirm
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={review.isPending}
                      onClick={() =>
                        review.mutate({
                          id: c.id,
                          outcome: 'rejected',
                          acceptChange: false,
                        })
                      }
                    >
                      Reject
                    </Button>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {review.error ? (
        <Alert tone="danger" role="alert">
          {procurementError(review.error)}
        </Alert>
      ) : null}
      <Link
        to="/app/$organizationId/procurement/$purchaseOrderId"
        params={{ organizationId, purchaseOrderId }}
      >
        Open {data.order.reference} <ArrowRight size={14} aria-hidden="true" />
      </Link>
      {dialog?.kind === 'submit' ? (
        <SubmitDialog
          organizationId={organizationId}
          record={data}
          close={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'respond' ? (
        <RespondDialog
          organizationId={organizationId}
          orderId={data.order.id}
          attention={dialog.attention}
          close={() => setDialog(null)}
        />
      ) : null}
      {data.supplier && dialog?.kind === 'link' ? (
        <LinkSupplierDialog
          organizationId={organizationId}
          supplier={data.supplier}
          close={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}
