import './procurement.css';

import type {
  Attention,
  Commitment,
  Communication,
  PurchaseOrderContext,
  PurchaseOrderRecord,
  PurchaseOrderStatus,
} from '@luma/api-contract';
import { formatList } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import { CollectionDisplay } from '@luma/ui/components/primitives/collection-display';
import {
  DataTable,
  type DataTableColumn,
  type DataTableColumnState,
} from '@luma/ui/components/primitives/data-table';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { Empty } from '@luma/ui/components/primitives/empty';
import { RefreshButton } from '@luma/ui/components/primitives/refresh-button';
import { StateDot, StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { RecordHeader } from '@luma/ui/components/workspace/record-header';
import { quantityWithUnit } from '@luma/ui/lib/units';
import {
  onlineManager,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Link, useLocation, useParams } from '@tanstack/react-router';
import {
  ArrowRight,
  FileX,
  MessageSquarePlus,
  RefreshCw,
  Send,
  Workflow,
} from 'lucide-react';
import {
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { SignInRedirect } from '../../kit/identity/common';
import { ApiError } from '../../kit/identity/data';
import { RecordMessages } from '../../kit/record-messages';
import { EvidenceDisclosure } from '../../shared/evidence/evidence';
import { formatMoney } from '../../shared/orders/presentation';
import { RecordFields } from '../adaptive/record-fields';
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
import { TransitionDialog, transitionLabels } from './forms';
import { OrderRevisionDialog, PurchaseOrderChanges } from './order-changes';
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
import { PurchasingTimeline } from './purchasing-timeline';
import { ReceiptDialog } from './receipt-dialog';
import {
  CommitmentDialog,
  type CommitmentDraft,
  LinkSupplierDialog,
  MessageDialog,
  RespondDialog,
  SubmitDialog,
} from './record-dialogs';
import { ShortfallDialog } from './shortfall-dialog';
import { ReceiptStockBooking } from './stock-booking';
import { SupplierEmailPanel } from './supplier-email';

const subscribe = (changed: () => void) => onlineManager.subscribe(changed);
const onlineSnapshot = () => onlineManager.isOnline();
const serverSnapshot = () => true;

const channelLabels = {
  email: m.procurement_channel_email,
  portal: m.procurement_channel_portal,
  phone: m.procurement_channel_phone,
  other: m.procurement_channel_other,
} satisfies Record<Communication['channel'], () => string>;

const approvalLabels = {
  approved: m.procurement_trace_approved,
  rejected: m.procurement_trace_rejected,
  pending: m.procurement_trace_pending,
  not_required: m.procurement_trace_not_required,
  unknown: m.procurement_trace_approval_unknown,
} satisfies Record<
  NonNullable<PurchaseOrderContext['replenishment']>['approval'],
  () => string
>;

const verificationLabels = {
  verified: m.procurement_trace_verified,
  failed: m.procurement_trace_verification_failed,
  inconclusive: m.procurement_trace_inconclusive,
  not_verified: m.procurement_trace_not_verified,
} satisfies Record<
  NonNullable<PurchaseOrderContext['replenishment']>['verification'],
  () => string
>;

type Dialog =
  | { kind: 'receipt' }
  | { kind: 'reorder'; attention: Attention }
  | { kind: 'cancel_remainder'; attention: Attention }
  | { kind: 'submit' }
  | { kind: 'message' }
  | { kind: 'link' }
  | { kind: 'commitment'; draft: CommitmentDraft }
  | { kind: 'respond'; attention: Attention }
  | { kind: 'transition'; status: PurchaseOrderStatus };

/**
 * Polls an order only while approval or sending can change it without anyone acting here. Other
 * changes arrive through this screen's own mutations, a revisit or, in Needs you, a queue refresh.
 */
const recordPollInterval = (query: {
  state: { data?: PurchaseOrderRecord | undefined };
}) =>
  query.state.data &&
  ['awaiting_approval', 'sending'].includes(query.state.data.stage)
    ? 5000
    : false;

/** Loads a purchase order's record and its stock context, and keeps both fresh. */
export function PurchaseOrderPage() {
  const { organizationId, purchaseOrderId } = useParams({
    from: '/app/$organizationId/procurement/$purchaseOrderId',
  });
  const record = useQuery({
    ...purchaseOrderRecordOptions(organizationId, purchaseOrderId),
    refetchInterval: recordPollInterval,
  });
  const context = useQuery(
    purchaseOrderContextOptions(organizationId, purchaseOrderId),
  );
  const online = useSyncExternalStore(
    subscribe,
    onlineSnapshot,
    serverSnapshot,
  );
  if (record.error instanceof ApiError && record.error.status === 401)
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
          : record.error instanceof ApiError && record.error.status === 404
            ? 'missing'
            : procurementError(record.error)
      }
      reload={() => {
        void record.refetch();
        void context.refetch();
      }}
      messages={
        <>
          <RecordFields
            organizationId={organizationId}
            recordType="purchase_order"
            recordId={purchaseOrderId}
          />
          <RecordMessages
            organizationId={organizationId}
            kind="purchase_order"
            recordId={purchaseOrderId}
            frame={(content) => (
              <section
                className="procurement-section"
                aria-labelledby="purchase-order-inbox"
              >
                <div className="procurement-section-heading">
                  <h2 id="purchase-order-inbox">
                    {m.messaging_record_section_title()}
                  </h2>
                </div>
                {content}
              </section>
            )}
          />
        </>
      }
    />
  );
}

/** Shows how far an order has come, what is pending, and who acts next. */
function PurchaseOrderRecordView({
  organizationId,
  record,
  context,
  contextError = false,
  loading = false,
  refreshing = false,
  offline = false,
  error,
  reload,
  messages,
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
  /** Inbox threads linked to the order, framed as a record section. */
  messages?: ReactNode;
}) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const client = useQueryClient();
  const invalidate = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: procurementKey(organizationId) }),
      client.invalidateQueries({
        queryKey: ['private', 'organization', organizationId, 'decisions'],
      }),
    ]);
  const sync = useMutation({
    mutationFn: () => refreshPurchaseOrder(organizationId, record!.order.id),
    onSuccess: invalidate,
  });
  const order = record?.order;

  return (
    <div className="procurement-page procurement-record">
      <RecordHeader
        section={{
          label: m.procurement_title(),
          domain: 'procurement',
          link: (
            <Link
              to="/app/$organizationId/procurement"
              params={{ organizationId }}
              search={{}}
            />
          ),
        }}
        title={order?.reference ?? m.procurement_detail_title_fallback()}
        actions={
          <>
            {record?.submission?.state === 'submitted' ? (
              <Button
                variant="outline"
                disabled={sync.isPending || offline}
                title={
                  record.readiness.connection?.label
                    ? m.procurement_detail_check_updates_title({
                        system: record.readiness.connection.label,
                      })
                    : m.procurement_detail_check_updates_title_generic()
                }
                onClick={() => sync.mutate()}
              >
                <RefreshCw size={14} aria-hidden="true" />
                {sync.isPending
                  ? m.procurement_detail_checking()
                  : m.procurement_detail_check_updates()}
              </Button>
            ) : null}
            <RefreshButton refreshing={refreshing} onClick={reload} />
          </>
        }
        status={
          <>
            {record ? <StagePill stage={record.stage} /> : null}
            {order ? (
              <Badge>
                {order.authority === 'luma'
                  ? m.procurement_detail_managed_luma()
                  : m.procurement_detail_managed_external()}
              </Badge>
            ) : null}
            {record?.draftVerified ? (
              <Badge tone="success">
                {m.procurement_detail_draft_verified()}
              </Badge>
            ) : null}
          </>
        }
        description={
          record && order ? (
            <>
              <Link
                to="/app/$organizationId/procurement/suppliers/$supplierId"
                params={{ organizationId, supplierId: order.supplierId }}
              >
                {order.supplierName}
              </Link>
              {` · ${m.procurement_lines_count({ count: order.lines.length })}`}
              {record.submission?.externalOrder?.orderNumber
                ? ` · ${
                    record.readiness.connection?.label
                      ? m.procurement_detail_external_order({
                          number: record.submission.externalOrder.orderNumber,
                          system: record.readiness.connection.label,
                        })
                      : m.procurement_detail_external_order_generic({
                          number: record.submission.externalOrder.orderNumber,
                        })
                  }`
                : ''}
            </>
          ) : null
        }
      />
      {offline ? (
        <Alert role="status">{m.procurement_detail_offline()}</Alert>
      ) : null}
      {sync.error ? (
        <Alert tone="warning" role="alert">
          {procurementError(sync.error)}
        </Alert>
      ) : null}
      {error === 'missing' ? (
        <Empty>
          <FileX size={30} aria-hidden="true" />
          <h2>{m.procurement_detail_missing_title()}</h2>
          <p>{m.procurement_detail_missing_body()}</p>
          <Link
            to="/app/$organizationId/procurement"
            params={{ organizationId }}
            search={{}}
          >
            {m.procurement_detail_missing_link()}
          </Link>
        </Empty>
      ) : error ? (
        <Alert tone="danger" role="alert">
          {record ? m.procurement_detail_refresh_failed() : error}{' '}
          <Button variant="outline" onClick={reload}>
            {m.common_retry()}
          </Button>
        </Alert>
      ) : null}
      {!record && loading && !error ? (
        <div className="procurement-skeleton" role="status">
          <span className="sr-only">{m.procurement_detail_loading()}</span>
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
              <SupplierEmailPanel
                organizationId={organizationId}
                record={record}
              />
              <NextStep
                organizationId={organizationId}
                record={record}
                open={setDialog}
              />
              {record.canManage &&
              record.reconciliation.available &&
              order.status === 'open' ? (
                <Button
                  variant="outline"
                  disabled={offline}
                  onClick={() => setDialog({ kind: 'receipt' })}
                >
                  {m.procurement_receipt_title()}
                </Button>
              ) : null}
              {dialog?.kind === 'receipt' ? (
                <ReceiptDialog
                  organizationId={organizationId}
                  record={record}
                  close={() => setDialog(null)}
                />
              ) : null}
              {dialog?.kind === 'reorder' ? (
                <ShortfallDialog
                  organizationId={organizationId}
                  record={record}
                  context={context}
                  attention={dialog.attention}
                  close={() => setDialog(null)}
                />
              ) : null}
              <PurchaseOrderChanges
                organizationId={organizationId}
                order={order}
              />
              {dialog?.kind === 'cancel_remainder' ? (
                <OrderRevisionDialog
                  organizationId={organizationId}
                  order={order}
                  initialLineId={dialog.attention.lineId ?? undefined}
                  initialQuantity={
                    record.commitments.find(
                      (fact) => fact.id === dialog.attention.commitmentId,
                    )?.quantity ?? undefined
                  }
                  close={() => setDialog(null)}
                />
              ) : null}
              <ReceiptStockBooking
                organizationId={organizationId}
                record={record}
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
              {messages}
              <CommitmentHistory record={record} open={setDialog} />
              <PurchasingTimeline
                organizationId={organizationId}
                record={record}
              />
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
    </div>
  );
}

/** The four supplier milestones, each with the evidence behind its state. */
function Milestones({ record }: { record: PurchaseOrderRecord }) {
  return (
    <ol
      className="procurement-milestones"
      aria-label={m.procurement_detail_progress()}
    >
      {record.progress.milestones.map((milestone) => {
        const state = milestoneStates[milestone.state];

        return (
          <li key={milestone.key} data-state={milestone.state}>
            <StateDot state={state.state} />
            <div>
              <h2>{milestoneLabels[milestone.key]()}</h2>
              <p className="procurement-milestone-state">
                {state.label()}
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
    Promise.all([
      client.invalidateQueries({ queryKey: procurementKey(organizationId) }),
      client.invalidateQueries({
        queryKey: ['private', 'organization', organizationId, 'decisions'],
      }),
    ]);
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
      ['rejected', 'expired', 'failed', 'not_executed'].includes(
        submission.state,
      ));
  const system = readiness.connection?.label;
  // The timeline's verified submission entry cites the verifying reads and the write receipt.
  const verifiedSubmission = submission
    ? record.timeline.entries.find(
        (entry) => entry.id === `submission:${submission.id}:verified`,
      )
    : undefined;
  const others = progress.attention.filter(
    (a) => !['submission_approval', 'submission_uncertain'].includes(a.kind),
  );

  return (
    <Card as="section" className="procurement-next" aria-labelledby="next-step">
      <div className="procurement-next-heading">
        <p className="procurement-eyebrow">{m.procurement_next_title()}</p>
        <Badge tone={progress.next.owner === 'none' ? 'neutral' : 'accent'}>
          {ownerLabels[progress.next.owner]()}
        </Badge>
      </div>
      <h2 id="next-step">{progress.next.title}</h2>
      <p className="procurement-note">{progress.next.detail}</p>
      {submission?.observeOnly ? (
        <p>{m.issues_observe_only_proposal()}</p>
      ) : null}
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
      {submission && verifiedSubmission?.evidenceRefs.length ? (
        <EvidenceDisclosure
          organizationId={organizationId}
          subject={{ kind: 'purchase_order', id: order.id }}
          refs={verifiedSubmission.evidenceRefs}
          label={m.procurement_submission_evidence({
            count: verifiedSubmission.evidenceRefs.length,
          })}
        />
      ) : null}
      {submission?.state === 'approval_required' ? (
        <dl className="procurement-send-facts">
          <div>
            <dt>{m.procurement_next_requested_delivery()}</dt>
            <dd>{calendarDate(submission.requestedDeliveryDate)}</dd>
          </div>
          <div>
            <dt>{m.procurement_next_requested_at()}</dt>
            <dd>
              <WorkspaceDate value={submission.requestedAt} />
            </dd>
          </div>
          <div>
            <dt>{m.procurement_next_approval_expires()}</dt>
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
              {decide.isPending
                ? m.procurement_next_sending()
                : m.procurement_next_approve_send()}
            </Button>
            <Button
              variant="outline"
              disabled={decide.isPending}
              onClick={() => decide.mutate('rejected')}
            >
              {m.procurement_next_reject()}
            </Button>
          </>
        ) : null}
        {submission?.canSend ? (
          <Button disabled={send.isPending} onClick={() => send.mutate()}>
            <Send size={14} aria-hidden="true" />
            {send.isPending
              ? m.procurement_next_sending()
              : m.procurement_next_send_now()}
          </Button>
        ) : null}
        {submission?.canCheck ? (
          <Button
            variant="outline"
            disabled={check.isPending}
            onClick={() => check.mutate()}
          >
            <RefreshCw size={14} aria-hidden="true" />
            {check.isPending
              ? m.procurement_detail_checking()
              : system
                ? m.procurement_next_check_system({ system })
                : m.procurement_next_check_system_generic()}
          </Button>
        ) : null}
        {canSend && readiness.ready ? (
          <Button onClick={() => open({ kind: 'submit' })}>
            <Send size={14} aria-hidden="true" />
            {m.procurement_next_send()}
          </Button>
        ) : null}
        {canSend &&
        !readiness.ready &&
        !record.supplier?.link &&
        record.supplier ? (
          <Button variant="outline" onClick={() => open({ kind: 'link' })}>
            {m.procurement_next_link_supplier()}
          </Button>
        ) : null}
      </div>
      {canSend && !readiness.ready ? (
        <ul
          className="procurement-blockers"
          aria-label={m.procurement_next_blockers()}
        >
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
        <ul
          className="procurement-attention"
          aria-label={m.procurement_next_attention()}
        >
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
                    ? m.procurement_next_attention_read()
                    : attention.kind === 'commitment_changed'
                      ? m.procurement_next_attention_changed()
                      : attention.kind === 'receipt_difference'
                        ? m.procurement_receipt_difference()
                        : rich(m.procurement_next_attention_overdue, {
                            date: <WorkspaceDate value={attention.dueAt} />,
                          })}
                </small>
              </span>
              {canManage &&
              record.reconciliation.decisions &&
              ['commitment_changed', 'receipt_difference'].includes(
                attention.kind,
              ) &&
              attention.lineId ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => open({ kind: 'reorder', attention })}
                >
                  {m.procurement_shortfall_title()}
                </Button>
              ) : null}
              {canManage &&
              record.supplier?.link &&
              attention.kind === 'commitment_changed' &&
              attention.lineId &&
              record.commitments.some(
                (fact) =>
                  fact.id === attention.commitmentId &&
                  fact.kind === 'confirmed_quantity' &&
                  fact.quantity !== null &&
                  fact.quantity > 0,
              ) ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => open({ kind: 'cancel_remainder', attention })}
                >
                  {m.procurement_shortfall_cancel_remainder()}
                </Button>
              ) : null}
              {canManage &&
              !['review_commitment', 'submission_failed'].includes(
                attention.kind,
              ) ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => open({ kind: 'respond', attention })}
                >
                  {attention.kind === 'receipt_difference'
                    ? m.procurement_receipt_difference()
                    : attention.kind === 'commitment_changed'
                      ? m.procurement_next_accept_or_follow_up()
                      : m.procurement_next_record_follow_up()}
                </Button>
              ) : attention.kind === 'review_commitment' && !inline ? (
                <a
                  className="procurement-inline-link"
                  href="#supplier-messages"
                >
                  {m.procurement_next_review()}
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

  const [columnState, setColumnState] = useState<DataTableColumnState>({
    columns: [
      'item',
      'ordered',
      'confirmed',
      'received',
      'expected',
      'unit_cost',
    ].map((key) => ({ key })),
  });
  const columns: DataTableColumn<(typeof rows)[number]>[] = [
    {
      key: 'item',
      required: true,
      header: m.procurement_lines_item(),
      cell: ({ line, context }) => (
        <span className="procurement-cell">
          {context?.skuId ? (
            <Link
              to="/app/$organizationId/products/$skuId"
              params={{ organizationId, skuId: context.skuId }}
            >
              {context?.title ?? line.description}
            </Link>
          ) : (
            <span>{context?.title ?? line.description}</span>
          )}
          <small>
            <code>{context?.positions[0]?.sku ?? line.sku}</code>
            {line.overdue ? ` · ${m.procurement_overdue()}` : ''}
          </small>
        </span>
      ),
    },
    {
      key: 'unit_cost',
      header: m.workflows_review_unit_cost(),
      numeric: true,
      cell: ({ line }) =>
        formatMoney(
          record.order.lines.find((item) => item.id === line.lineId)
            ?.unitPrice ?? null,
        ) ?? m.workflows_review_not_reported(),
    },
    {
      key: 'ordered',
      header: m.procurement_lines_ordered(),
      numeric: true,
      cell: ({ line }) =>
        quantityWithUnit(quantity(line.ordered), line.unit, line.ordered),
    },
    {
      key: 'confirmed',
      header: m.procurement_lines_confirmed(),
      numeric: true,
      cell: ({ line }) =>
        line.confirmed === null ? (
          <span className="procurement-muted">{m.common_empty_value()}</span>
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
      key: 'shipped',
      header: m.procurement_lines_shipped(),
      numeric: true,
      cell: ({ line }) =>
        line.shipped === null ? m.common_empty_value() : quantity(line.shipped),
    },
    {
      key: 'ordered_difference',
      header: m.procurement_lines_ordered_difference(),
      numeric: true,
      hideOnNarrow: true,
      cell: ({ line }) =>
        line.orderedDifference === null
          ? m.common_empty_value()
          : quantity(line.orderedDifference),
    },
    {
      key: 'shipped_difference',
      header: m.procurement_lines_shipped_difference(),
      numeric: true,
      hideOnNarrow: true,
      cell: ({ line }) =>
        line.shippedDifference === null
          ? m.common_empty_value()
          : quantity(line.shippedDifference),
    },
    {
      key: 'received',
      header: m.procurement_lines_received(),
      numeric: true,
      cell: ({ line }) => (
        <span className="procurement-cell procurement-cell-end">
          <span>{quantity(line.received)}</span>
          {line.damaged > 0 ? (
            <small>
              {m.procurement_receipt_good({
                quantity: quantity(line.goodReceived),
              })}
            </small>
          ) : null}
          {line.outstanding > 1e-9 && line.received > 0 ? (
            <small>
              {m.procurement_lines_outstanding({
                quantity: quantity(line.outstanding),
              })}
            </small>
          ) : null}
        </span>
      ),
    },
    {
      key: 'received_difference',
      header: m.procurement_lines_received_difference(),
      numeric: true,
      hideOnNarrow: true,
      cell: ({ line }) =>
        line.receivedDifference === null
          ? m.common_empty_value()
          : quantity(line.receivedDifference),
    },
    {
      key: 'damaged',
      header: m.procurement_lines_damage(),
      numeric: true,
      cell: ({ line }) => quantity(line.damaged),
    },
    {
      key: 'shortage',
      header: m.procurement_lines_shortage(),
      numeric: true,
      hideOnNarrow: true,
      cell: ({ line }) => quantity(line.shortage),
    },
    {
      key: 'expected',
      header: m.procurement_column_expected(),
      hideOnNarrow: true,
      cell: ({ line }) =>
        line.stage === 'received' ? (
          <span className="procurement-muted">
            {m.procurement_lines_arrived()}
          </span>
        ) : line.expectedDate ? (
          <span className="procurement-cell">
            <span>{calendarDate(line.expectedDate)}</span>
            <small>
              {line.promisedDate
                ? m.procurement_lines_promised()
                : m.procurement_lines_requested()}
            </small>
          </span>
        ) : (
          <span className="procurement-muted">
            {m.procurement_lines_not_set()}
          </span>
        ),
    },
    {
      key: 'stock',
      header: m.procurement_lines_stock(),
      hideOnNarrow: true,
      cell: ({ context }) =>
        contextError ? (
          <span className="procurement-muted">{m.common_not_available()}</span>
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
                {(new Set(
                  position.sources
                    .filter((s) => !s.deleted)
                    .map((s) => s.available),
                ).size === 1 && position.sources.every((s) => !s.deleted)
                  ? position.sources.slice(0, 1)
                  : position.sources
                )
                  .map((s) =>
                    s.deleted
                      ? m.procurement_stock_removed()
                      : `${position.sources.some((other) => other.available !== s.available) ? `${s.label}: ` : ''}${quantityWithUnit(stockQuantity(s.available), position.unit, s.available ?? '')}`,
                  )
                  .join(' / ')}{' '}
                <small>{position.location}</small>
              </Link>
            ))}
            {context.otherOrders.length ? (
              <small>
                {m.procurement_lines_other_orders({
                  count: context.otherOrders.length,
                })}
              </small>
            ) : null}
          </span>
        ) : (
          <span className="procurement-muted">
            {context.skuId
              ? m.procurement_stock_none()
              : m.procurement_lines_unknown_sku()}
          </span>
        ),
    },
    {
      key: 'stage',
      header: m.procurement_lines_state(),
      hideOnNarrow: true,
      cell: ({ line }) => (
        <StatePill state={lineStages[line.stage].state}>
          {lineStages[line.stage].label()}
        </StatePill>
      ),
    },
  ];

  return (
    <section className="procurement-section" aria-labelledby="order-lines">
      <div className="procurement-section-heading">
        <h2 id="order-lines">{m.procurement_lines_title()}</h2>
        {record.progress.expectedDate ? (
          <span>
            {m.procurement_lines_next_expected({
              date: calendarDate(record.progress.expectedDate),
            })}
          </span>
        ) : null}
        <CollectionDisplay
          columns={{
            options: columns.map((column) => ({
              key: column.key,
              label: String(column.header),
              required: column.key === 'item',
            })),
            shown: columnState.columns.map(({ key }) => key),
            onChange: (keys) =>
              setColumnState({ columns: keys.map((key) => ({ key })) }),
          }}
        />
      </div>
      <DataTable
        caption={m.procurement_lines_caption()}
        density="compact"
        rows={rows}
        rowKey={(row) => row.line.lineId}
        columns={columns}
        columnState={columnState}
        onColumnStateChange={setColumnState}
      />
      <p className="procurement-note">{m.procurement_lines_note()}</p>
      <p>
        {m.workflows_review_total_value()}:{' '}
        {record.value && record.value !== 'unknown'
          ? formatMoney(record.value)
          : m.workflows_review_not_reported()}
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
    .filter(
      (mark) =>
        mark.start >= 0 && mark.end <= text.length && mark.end > mark.start,
    )
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
          <span id="supplier-messages-title">
            {m.procurement_messages_title()}
          </span>
        </h2>
        {canManage ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => open({ kind: 'message' })}
          >
            <MessageSquarePlus size={14} aria-hidden="true" />
            {m.procurement_messages_add()}
          </Button>
        ) : null}
      </div>
      {!record.extraction.available && canManage ? (
        <p className="procurement-note">
          {record.extraction.reason
            ? m.procurement_messages_manual_reason({
                reason: record.extraction.reason,
              })
            : m.procurement_messages_manual()}
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
        <p className="procurement-empty">{m.procurement_messages_empty()}</p>
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
    Promise.all([
      client.invalidateQueries({ queryKey: procurementKey(organizationId) }),
      client.invalidateQueries({
        queryKey: ['private', 'organization', organizationId, 'decisions'],
      }),
    ]);
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
    m.procurement_whole_order();

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
            {channelLabels[communication.channel]()}
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
              ? commitments.length
                ? m.procurement_message_read_count({
                    count: commitments.length,
                  })
                : m.procurement_message_read_none()
              : extraction.state === 'failed'
                ? m.procurement_message_read_failed()
                : m.procurement_message_not_read()}
          </Badge>
        ) : null}
      </header>
      {purged ? (
        <p className="procurement-note">
          {communication.purgeReason === 'retention'
            ? m.procurement_message_purged_retention()
            : m.procurement_message_purged_request()}
        </p>
      ) : (
        <div
          ref={textRef}
          className="procurement-message-text"
          onMouseUp={record.canManage ? capture : undefined}
          onKeyUp={record.canManage ? capture : undefined}
          tabIndex={0}
          aria-label={m.procurement_message_from({ from: communication.from })}
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
            {m.procurement_quote({
              quote: `${selection.quote.slice(0, 80)}${selection.quote.length > 80 ? '…' : ''}`,
            })}
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
            {m.procurement_message_record_selection()}
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
              {m.procurement_message_read_again()}
            </Button>
          </p>
        ) : null
      ) : null}
      {extraction?.state === 'completed' &&
      extraction.relatesToOrder === false ? (
        <Alert tone="warning">
          {m.procurement_message_unrelated({ order: record.order.reference })}
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
                  {m.procurement_commitment_statement({
                    kind: commitmentKinds[c.kind](),
                    value: commitmentValue(c, unit(c.lineId)),
                  })}
                </strong>
                <small>
                  {lineLabel(c.lineId)} ·{' '}
                  {c.status === 'needs_review'
                    ? c.reviewReasons.length
                      ? formatList(
                          c.reviewReasons.map((r) => reviewReasonLabels[r]()),
                        )
                      : m.procurement_message_needs_review()
                    : c.status === 'rejected'
                      ? m.procurement_message_rejected()
                      : c.source.kind === 'communication' && c.source.extraction
                        ? m.procurement_message_read_by_luma()
                        : m.procurement_message_recorded_by_hand()}
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
                      ? m.procurement_message_confirm_accept()
                      : m.procurement_message_confirm()}
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
                    {m.procurement_next_reject()}
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
          <summary>{m.procurement_message_details()}</summary>
          <p className="procurement-note">
            {rich(m.procurement_message_retention, {
              date: <WorkspaceDate value={communication.retainUntil} />,
            })}
            {communication.messageId ? (
              <>
                {' '}
                {rich(m.procurement_message_id, {
                  id: <code>{communication.messageId}</code>,
                })}
              </>
            ) : null}
          </p>
          <Button
            size="sm"
            variant="ghost"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {m.procurement_message_remove_text()}
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
        <h2 id="commitment-history">{m.procurement_history_title()}</h2>
        <span>
          {m.procurement_history_count({ count: record.commitments.length })}
        </span>
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
                    c.kind === 'received' &&
                    c.source.kind === 'purchasing_system'
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
                    {m.procurement_commitment_statement({
                      kind: commitmentKinds[c.kind](),
                      value: commitmentValue(c, unit(c.lineId)),
                    })}
                    {corrected ? ` · ${m.procurement_history_corrected()}` : ''}
                  </strong>
                  <small>
                    {record.order.lines.find((l) => l.id === c.lineId)
                      ?.description ?? m.procurement_whole_order()}{' '}
                    · {commitmentSource(c, label)} ·{' '}
                    <WorkspaceDate value={c.recordedAt} />
                  </small>
                  {c.orderRevision ? (
                    <small>
                      {m.procurement_changes_revision({
                        revision: c.orderRevision,
                      })}
                    </small>
                  ) : null}
                  <small>
                    {m.procurement_receipt_recorded_by({
                      actor: c.recordedBy.id,
                    })}
                  </small>
                  {c.source.kind === 'correction' ||
                  c.source.kind === 'manual_receipt' ? (
                    <small>
                      {m.procurement_history_reason({
                        reason: c.source.reason,
                      })}
                    </small>
                  ) : null}
                  {c.source.kind === 'manual_receipt' ? (
                    <small>{c.source.evidence.join(' · ')}</small>
                  ) : null}
                </span>
                {record.canManage &&
                !['received', 'shortage', 'damaged'].includes(c.kind) &&
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
                    {m.procurement_history_correct()}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="procurement-empty">{m.procurement_history_empty()}</p>
      )}
      {record.observations.length ? (
        <Disclosure>
          <summary>
            {m.procurement_history_reads({
              count: record.observations.length,
            })}
          </summary>
          <ol className="procurement-reads">
            {record.observations.map((o) => (
              <li key={o.id}>
                <WorkspaceDate value={o.observedAt} /> ·{' '}
                {m.procurement_history_read_order({
                  number: o.orderNumber ?? o.externalId,
                })}{' '}
                · {o.status.replaceAll('_', ' ')}
                {o.confirmed
                  ? ` · ${m.procurement_history_read_confirmed()}`
                  : ''}
              </li>
            ))}
          </ol>
        </Disclosure>
      ) : null}
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
      <h2 id="side-supplier">{m.procurement_supplier_card_title()}</h2>
      <dl className="procurement-side-facts">
        <Fact label={m.procurement_supplier_card_name()}>
          <Link
            to="/app/$organizationId/procurement/suppliers/$supplierId"
            params={{ organizationId, supplierId: record.order.supplierId }}
          >
            {record.order.supplierName}
          </Link>
        </Fact>
        <Fact label={m.procurement_supplier_card_link()}>
          {supplier?.link ? (
            <>
              {supplier.link.name ??
                m.procurement_supplier_external({
                  id: supplier.link.externalId,
                })}
              <small>
                {record.readiness.connection?.label
                  ? m.procurement_supplier_card_link_in({
                      system: record.readiness.connection.label,
                    })
                  : m.procurement_supplier_card_link_in_generic()}
              </small>
            </>
          ) : (
            <span className="procurement-muted">
              {m.procurement_not_linked()}
            </span>
          )}
        </Fact>
        <Fact label={m.procurement_supplier_card_window()}>
          {m.procurement_hours({ hours: supplier?.confirmationHours ?? 48 })}
        </Fact>
        {record.progress.confirmationDueAt ? (
          <Fact label={m.procurement_supplier_card_due()}>
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
          {supplier.link
            ? m.procurement_supplier_change_link()
            : m.procurement_next_link_supplier()}
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
  const amount = (value: number | null) =>
    value === null
      ? m.common_empty_value()
      : unit
        ? quantityWithUnit(quantity(value), unit, value)
        : quantity(value);

  return (
    <>
      <Card
        as="section"
        className="procurement-side"
        aria-labelledby="side-trace"
      >
        <h2 id="side-trace">
          <Workflow size={14} aria-hidden="true" />{' '}
          {m.procurement_trace_title()}
        </h2>
        <ol className="procurement-trace">
          <li>
            <StateDot state="verified" />
            <span className="procurement-cell">
              <strong>
                {trace.stock.available === null
                  ? m.procurement_trace_stock_unknown()
                  : trace.minimum !== null
                    ? m.procurement_trace_stock_below({
                        quantity: amount(trace.stock.available),
                        minimum: quantity(trace.minimum),
                      })
                    : m.procurement_trace_stock({
                        quantity: amount(trace.stock.available),
                      })}
              </strong>
              <small>
                {trace.location ?? m.procurement_trace_position()}
                {trace.stock.checkedAt ? (
                  <>
                    {' · '}
                    {rich(m.procurement_trace_checked, {
                      date: <WorkspaceDate value={trace.stock.checkedAt} />,
                    })}
                  </>
                ) : null}
              </small>
            </span>
          </li>
          <li>
            <StateDot state="verified" />
            <span className="procurement-cell">
              <strong>
                {m.procurement_trace_proposed({
                  quantity: amount(trace.proposedQuantity),
                })}
              </strong>
              <small>
                {m.procurement_trace_target({ quantity: amount(trace.target) })}
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
              <strong>{approvalLabels[trace.approval]()}</strong>
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
              <strong>{verificationLabels[trace.verification]()}</strong>
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
              {m.procurement_trace_position_link()}{' '}
              <ArrowRight size={13} aria-hidden="true" />
            </Link>
          ) : null}
          <Link
            to="/app/$organizationId/workflows/$definitionId"
            params={{ organizationId, definitionId: trace.definitionId }}
            search={{}}
            hash={`run-${trace.runId}`}
          >
            {m.procurement_trace_run_link()}{' '}
            <ArrowRight size={13} aria-hidden="true" />
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
      <h2 id="side-issues">{m.procurement_related_issues()}</h2>
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
        <p className="procurement-note">{m.procurement_issues_empty()}</p>
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
  const sourceCancellationUnavailable =
    record.submission?.channel !== 'email' &&
    ['submitting', 'uncertain', 'submitted'].includes(
      record.submission?.state ?? '',
    );
  const allowed = record.canManage
    ? order.authority === 'luma'
      ? order.status === 'draft'
        ? sourceCancellationUnavailable
          ? (['open'] as const)
          : (['open', 'cancelled'] as const)
        : order.status === 'open'
          ? sourceCancellationUnavailable
            ? (['closed'] as const)
            : (['closed', 'cancelled'] as const)
          : []
      : []
    : [];

  return (
    <Card
      as="section"
      className="procurement-side"
      aria-labelledby="side-order"
    >
      <h2 id="side-order">{m.procurement_order_card_title()}</h2>
      <dl className="procurement-side-facts">
        <Fact label={m.common_status()}>{statusLabels[order.status]()}</Fact>
        <Fact label={m.procurement_order_card_created()}>
          <WorkspaceDate value={order.createdAt} />
        </Fact>
        <Fact label={m.procurement_order_card_origin()}>
          {order.origin.workflowRunId
            ? m.procurement_order_card_origin_workflow()
            : m.procurement_order_card_origin_manual()}
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
              {transitionLabels[status]()}
            </Button>
          ))}
        </div>
      ) : null}
      {order.status === 'open' &&
      record.stage !== 'received' &&
      record.submission?.state === 'submitted' ? (
        <p className="procurement-note">
          {m.procurement_order_card_close_note()}
        </p>
      ) : null}
      <Disclosure variant="plain">
        <summary>{m.procurement_order_card_ids()}</summary>
        <p className="procurement-note">
          {rich(m.procurement_order_card_order_id, {
            id: <code>{order.id}</code>,
          })}
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
  refreshedAt = 0,
}: {
  organizationId: string;
  purchaseOrderId: string;
  /**
   * When Needs you last read this decision. Supplier replies and follow-ups change the queue
   * through its stream in any stage, so the record is read again whenever the queue is.
   */
  refreshedAt?: number;
}) {
  const record = useQuery({
    ...purchaseOrderRecordOptions(organizationId, purchaseOrderId),
    refetchInterval: recordPollInterval,
  });
  const seen = useRef(refreshedAt);
  const { refetch } = record;
  useEffect(() => {
    if (refreshedAt === seen.current) return;
    seen.current = refreshedAt;
    void refetch();
  }, [refreshedAt, refetch]);
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
  if (record.isPending)
    return <p role="status">{m.procurement_detail_loading()}</p>;
  if (!record.data)
    return (
      <p role="alert">
        {record.error instanceof ApiError && record.error.status === 404
          ? m.procurement_review_missing()
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
        <ul
          className="procurement-facts"
          aria-label={m.procurement_review_facts()}
        >
          {pending.map((c) => {
            const communication = data.communications.find(
              (message) =>
                c.source.kind === 'communication' &&
                message.id === c.source.communicationId,
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
                    {m.procurement_commitment_statement({
                      kind: commitmentKinds[c.kind](),
                      value: commitmentValue(c, unit),
                    })}
                  </strong>
                  {quote ? (
                    <small>{m.procurement_quote({ quote })}</small>
                  ) : null}
                  <small>
                    {formatList(
                      c.reviewReasons.map((r) => reviewReasonLabels[r]()),
                    )}
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
                      {m.procurement_message_confirm()}
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
                      {m.procurement_next_reject()}
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
        {m.procurement_review_open({ order: data.order.reference })}{' '}
        <ArrowRight size={14} aria-hidden="true" />
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
