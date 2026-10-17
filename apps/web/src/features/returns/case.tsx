import './returns.css';

import type {
  DecisionEvidence,
  ReturnCaseDetail,
  ReturnDetail,
  ReturnWaitingView,
} from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import { Empty } from '@luma/ui/components/primitives/empty';
import {
  type PersonOption,
  PersonPicker,
} from '@luma/ui/components/primitives/person-picker';
import { RefreshButton } from '@luma/ui/components/primitives/refresh-button';
import { StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { RecordHeader } from '@luma/ui/components/workspace/record-header';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowRight, RefreshCw, Send, Undo2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { SignInRedirect } from '../../kit/identity/common';
import { ApiError } from '../../kit/identity/data';
import { useNow } from '../../kit/live/now';
import { membersOptions } from '../../kit/settings/data';
import {
  caseCommands,
  returnCaseError,
  returnCaseKey,
  returnCaseOptions,
  returnExchangeOptions,
  returnSettlementOptions,
  returnWaitingOptions,
} from './case-data';
import {
  CancelDialog,
  CreationDialog,
  InspectionDialog,
  ProposalDialog,
  ReceiptDialog,
} from './case-dialogs';
import { ReturnExchange } from './case-exchange';
import {
  caseStageDescriptions,
  caseStageLabels,
  caseStageStates,
  creationBlocker,
  creationFailure,
  creationStateLabels,
  creationStateStates,
  personName,
  reasonLabels,
  resolutionLabels,
} from './case-presentation';
import { ReturnServiceSummary, ReturnServiceTimeline } from './case-service';
import { ReturnSettlement } from './case-settlement';
import { ReturnWaiting, returnWaitReasons } from './case-waiting';
import { returnOptions } from './data';

export type ReturnCaseLoadError = 'missing' | 'access' | 'unavailable';

type CaseDialogKind =
  'receipt' | 'inspection' | 'proposal' | 'cancel' | 'create';

/** Loads one return case with the workspace's people for assignment. */
export function ReturnCasePage() {
  const { organizationId, caseId } = useParams({
    from: '/app/$organizationId/returns/cases/$caseId',
  });
  const query = useQuery(returnCaseOptions(organizationId, caseId));
  const settlements = useQuery({
    ...returnSettlementOptions(organizationId, caseId),
    enabled: !!query.data,
  });
  const exchanges = useQuery({
    ...returnExchangeOptions(organizationId, caseId),
    enabled: !!query.data,
  });
  const waiting = useQuery({
    ...returnWaitingOptions(organizationId, caseId),
    enabled: !!query.data,
  });
  const members = useQuery({
    ...membersOptions(organizationId),
    enabled: !!query.data?.canManage,
  });
  const sourceId = query.data?.sourceReturn?.id;
  const source = useQuery({
    ...returnOptions(organizationId, sourceId ?? ''),
    refetchInterval: 30_000,
    refetchOnWindowFocus: 'always',
    enabled: !!sourceId,
  });
  if (query.error instanceof ApiError && query.error.status === 401)
    return <SignInRedirect />;
  const status = query.error instanceof ApiError ? query.error.status : 0;

  return (
    <ReturnCaseView
      organizationId={organizationId}
      detail={status === 403 ? undefined : query.data}
      sourceDetail={sourceId ? source.data : undefined}
      sourceLoading={!!sourceId && source.isPending}
      sourceUnavailable={!!sourceId && source.isError}
      waiting={waiting.isError ? undefined : waiting.data}
      settlement={
        query.data ? (
          <>
            <ReturnWaiting
              data={waiting.data}
              loading={waiting.isPending}
              error={waiting.error}
              organizationId={organizationId}
              detail={query.data}
            />
            <ReturnExchange
              organizationId={organizationId}
              detail={query.data}
              data={exchanges.data}
              loading={exchanges.isPending}
              unavailable={exchanges.isError}
              retry={() => void exchanges.refetch()}
            />
            <ReturnSettlement
              organizationId={organizationId}
              detail={query.data}
              data={settlements.data}
              loading={settlements.isPending}
              unavailable={settlements.isError}
              retry={() => void settlements.refetch()}
            />
          </>
        ) : null
      }
      settlementStarted={
        (settlements.data?.items.some((a) => a.sent) ?? false) ||
        (exchanges.data?.steps.some((a) => a.sent) ?? false)
      }
      loading={query.isPending}
      refreshing={query.isFetching}
      refresh={() => {
        void query.refetch();
        void settlements.refetch();
        void exchanges.refetch();
        if (sourceId) void source.refetch();
      }}
      people={(members.data ?? []).map((member) => ({
        id: member.userId,
        name: member.name ?? member.email ?? member.userId,
        detail: member.email ?? undefined,
      }))}
      error={
        !query.error
          ? undefined
          : status === 404
            ? 'missing'
            : status === 403
              ? 'access'
              : 'unavailable'
      }
    />
  );
}

function Section({
  title,
  description,
  children,
  actions,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Card as="section" aria-label={title}>
      <CardHeader>
        <div>
          <CardTitle as="h2">{title}</CardTitle>
          {description ? (
            <CardDescription>{description}</CardDescription>
          ) : null}
        </div>
        {actions}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Evidence({ value }: { value: DecisionEvidence | null }) {
  if (!value || (!value.note && !value.link)) return null;

  return (
    <span className="returns-case-proof">
      {value.note ? <span>{value.note}</span> : null}
      {value.link ? (
        <a href={value.link} target="_blank" rel="noreferrer noopener">
          {m.returns_case_evidence_open_link()}
        </a>
      ) : null}
    </span>
  );
}

const lineName = (line: ReturnCaseDetail['lines'][number]) =>
  line.title ?? line.sku ?? m.returns_refunds_order_line();

const count = (value: number | null) =>
  value === null ? (
    <span className="returns-muted">{m.returns_case_not_recorded()}</span>
  ) : (
    formatNumber(value)
  );

/** Lists each case line with requested, received, missing, judged and restocked units. */
function Lines({ detail }: { detail: ReturnCaseDetail }) {
  return (
    <Section
      title={m.returns_case_lines_title()}
      description={m.returns_case_lines_description()}
    >
      <DataTable
        className="returns-items"
        caption={m.returns_case_lines_caption()}
        rows={detail.lines}
        rowKey={(line) => line.orderLineId}
        columns={[
          {
            key: 'item',
            header: m.returns_items_column_item(),
            cell: (line) => (
              <span className="returns-cell">
                <span>{lineName(line)}</span>
                <small>
                  {reasonLabels[line.reason]}
                  {line.note ? ` · ${line.note}` : ''}
                </small>
              </span>
            ),
          },
          {
            key: 'requested',
            header: m.returns_case_column_requested(),
            numeric: true,
            cell: (line) => formatNumber(line.quantity),
          },
          {
            key: 'received',
            header: m.returns_items_column_received(),
            numeric: true,
            cell: (line) => count(line.received),
          },
          {
            key: 'missing',
            header: m.returns_case_column_missing(),
            numeric: true,
            hideOnNarrow: true,
            cell: (line) => count(line.missing),
          },
          {
            key: 'resellable',
            header: m.returns_case_column_resellable(),
            numeric: true,
            cell: (line) => count(line.resellable),
          },
          {
            key: 'damaged',
            header: m.returns_case_column_damaged(),
            numeric: true,
            cell: (line) => count(line.damaged),
          },
          {
            key: 'restock',
            header: m.returns_case_column_restock(),
            numeric: true,
            hideOnNarrow: true,
            cell: (line) => count(line.restock),
          },
        ]}
      />
    </Section>
  );
}

/** Who recorded each decision, when and on which evidence. */
function Decisions({ detail }: { detail: ReturnCaseDetail }) {
  const rows = [
    { label: m.returns_case_decision_receipt(), value: detail.receipt },
    { label: m.returns_case_decision_inspection(), value: detail.inspection },
    {
      label: detail.proposal
        ? m.returns_case_decision_proposal({
            resolution: resolutionLabels[detail.proposal.kind],
          })
        : m.returns_case_decision_proposal_none(),
      value: detail.proposal,
    },
  ];

  return (
    <Section
      title={m.returns_case_decisions_title()}
      description={m.returns_case_decisions_description()}
    >
      <dl className="returns-facts">
        {rows.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>
              {row.value ? (
                <span className="returns-cell">
                  <span>
                    {rich(m.returns_case_decided_by, {
                      name: personName(row.value.by),
                      date: <WorkspaceDate value={row.value.at} />,
                    })}
                  </span>
                  <Evidence value={row.value.evidence} />
                </span>
              ) : (
                <span className="returns-muted">
                  {m.returns_case_not_recorded()}
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

/**
 * Creating the return in the order's system: why it is unavailable, the request awaiting
 * approval, an uncertain result to check, or the return found by an independent read.
 */
function Creation({
  organizationId,
  detail,
  open,
}: {
  organizationId: string;
  detail: ReturnCaseDetail;
  open: (dialog: CaseDialogKind) => void;
}) {
  const { creation, creationAvailability: availability } = detail;
  const approving =
    creation?.operation === 'approve' ||
    (!creation &&
      detail.order.connection.provider === 'shopify' &&
      detail.sourceReturn?.status === 'requested');
  const system =
    availability.connection?.label ??
    detail.order.connection.label ??
    m.returns_source_fallback();
  const client = useQueryClient();
  const invalidate = () =>
    client.invalidateQueries({ queryKey: returnCaseKey(organizationId) });
  const commands = caseCommands(organizationId, detail.case.id);
  const decide = useMutation({
    mutationFn: (outcome: 'approved' | 'rejected') =>
      commands.decideCreation(creation!.id, {
        decisionId: creation!.decisionId!,
        outcome,
      }),
    onSettled: invalidate,
  });
  const send = useMutation({
    mutationFn: () => commands.sendCreation(creation!.id),
    onSettled: invalidate,
  });
  const check = useMutation({
    mutationFn: () => commands.checkCreation(creation!.id),
    onSettled: invalidate,
  });
  const failure = decide.error ?? send.error ?? check.error;
  // Apps that cannot create returns are not mentioned; the case works without them.
  if (availability.blocker === 'unsupported' && !creation) return null;

  return (
    <Section
      title={
        approving
          ? m.returns_case_approval_title({ system })
          : m.returns_case_creation_title({ system })
      }
      description={
        approving
          ? m.returns_case_approval_description({ system })
          : m.returns_case_creation_description({ system })
      }
    >
      {creation ? (
        <div className="returns-case-creation">
          <p>
            <StatePill state={creationStateStates[creation.state]}>
              {approving && creation.state === 'created'
                ? m.returns_case_approval_verified()
                : creationStateLabels[creation.state]}
            </StatePill>
          </p>
          {creation.observeOnly ? (
            <Alert role="status">
              {m.returns_case_creation_observe_only()}
            </Alert>
          ) : null}
          {creation.failure ? (
            <Alert tone="warning">{creationFailure(creation.failure)}</Alert>
          ) : null}
          <dl className="returns-facts">
            <div>
              <dt>{m.returns_case_creation_requested_by()}</dt>
              <dd>
                {rich(m.returns_case_decided_by, {
                  name: personName(creation.requestedBy),
                  date: <WorkspaceDate value={creation.requestedAt} />,
                })}
              </dd>
            </div>
            {!approving ? (
              <div>
                <dt>{m.returns_case_creation_warehouse()}</dt>
                <dd>{creation.warehouse.name ?? m.common_not_reported()}</dd>
              </div>
            ) : null}
            {!approving ? (
              <div>
                <dt>{m.returns_case_creation_reason()}</dt>
                <dd>{creation.reason.name ?? m.common_not_reported()}</dd>
              </div>
            ) : null}
            {creation.state === 'approval_required' ? (
              <div>
                <dt>{m.returns_case_creation_expires()}</dt>
                <dd>
                  <WorkspaceDate value={creation.expiresAt} />
                </dd>
              </div>
            ) : null}
            {creation.decidedBy ? (
              <div>
                <dt>{m.returns_case_creation_decided_by()}</dt>
                <dd>
                  {rich(m.returns_case_decided_by, {
                    name: personName(creation.decidedBy),
                    date: <WorkspaceDate value={creation.decidedAt!} />,
                  })}
                </dd>
              </div>
            ) : null}
            {creation.externalReturn ? (
              <div>
                <dt>{m.returns_case_creation_number({ system })}</dt>
                <dd>
                  <code>
                    {creation.externalReturn.number ??
                      creation.externalReturn.externalId}
                  </code>
                  {creation.createdAt ? (
                    <small>
                      {' · '}
                      {rich(m.returns_case_creation_verified, {
                        date: <WorkspaceDate value={creation.createdAt} />,
                      })}
                    </small>
                  ) : null}
                </dd>
              </div>
            ) : null}
          </dl>
          <p className="returns-note">
            {creation.state === 'approval_required'
              ? creation.canApprove
                ? m.returns_case_creation_review({ system })
                : m.returns_case_creation_waiting_approval()
              : creation.state === 'uncertain'
                ? m.returns_case_creation_uncertain({ system })
                : creation.state === 'created'
                  ? m.returns_case_creation_created({ system })
                  : null}
          </p>
          <div className="returns-case-actions">
            {creation.canApprove ? (
              <>
                <Button
                  disabled={decide.isPending}
                  onClick={() => decide.mutate('approved')}
                >
                  <Send size={14} aria-hidden="true" />
                  {decide.isPending
                    ? m.returns_case_creation_sending()
                    : approving
                      ? m.returns_case_approval_send({ system })
                      : m.returns_case_creation_approve({ system })}
                </Button>
                <Button
                  variant="outline"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate('rejected')}
                >
                  {m.returns_case_creation_reject()}
                </Button>
              </>
            ) : null}
            {creation.canSend ? (
              <Button disabled={send.isPending} onClick={() => send.mutate()}>
                <Send size={14} aria-hidden="true" />
                {send.isPending
                  ? m.returns_case_creation_sending()
                  : m.returns_case_creation_send_now()}
              </Button>
            ) : null}
            {creation.canCheck ? (
              <Button
                variant="outline"
                disabled={check.isPending}
                onClick={() => check.mutate()}
              >
                <RefreshCw size={14} aria-hidden="true" />
                {check.isPending
                  ? m.returns_case_creation_checking()
                  : m.returns_case_creation_check({ system })}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {failure ? (
        <Alert tone="danger" role="alert">
          {returnCaseError(failure)}
        </Alert>
      ) : null}
      {availability.blocker && availability.blocker !== 'in_progress' ? (
        availability.blocker === 'created' ? null : (
          <p className="returns-note">
            {creationBlocker(availability.blocker, system)}
          </p>
        )
      ) : !availability.blocker && detail.canManage ? (
        <div className="returns-case-actions">
          <Button onClick={() => open('create')}>
            <Send size={14} aria-hidden="true" />
            {creation
              ? m.returns_case_creation_request_again({ system })
              : approving
                ? m.returns_case_approval_start({ system })
                : m.returns_case_creation_start({ system })}
          </Button>
        </div>
      ) : null}
    </Section>
  );
}

/** Shows one return case: what to do next, lines, decisions, creation, history and facts. */
export function ReturnCaseView({
  organizationId,
  detail,
  error,
  loading = false,
  refreshing = false,
  refresh,
  people = [],
  sourceDetail,
  sourceLoading = false,
  sourceUnavailable = false,
  settlement,
  settlementStarted = false,
  waiting,
}: {
  organizationId: string;
  detail?: ReturnCaseDetail | undefined;
  error?: ReturnCaseLoadError | undefined;
  loading?: boolean;
  refreshing?: boolean;
  refresh: () => void;
  people?: readonly PersonOption[];
  sourceDetail?: ReturnDetail | undefined;
  sourceLoading?: boolean;
  sourceUnavailable?: boolean;
  settlement?: ReactNode;
  settlementStarted?: boolean;
  waiting?: ReturnWaitingView | undefined;
}) {
  const now = new Date(useNow()).toISOString();
  const [dialog, setDialog] = useState<CaseDialogKind | null>(null);
  const client = useQueryClient();
  const assign = useMutation({
    mutationFn: (assigneeId: string | null) =>
      caseCommands(organizationId, detail!.case.id).assign({
        commandId: crypto.randomUUID(),
        expectedRevision: detail!.case.revision,
        assigneeId,
      }),
    onSettled: () =>
      client.invalidateQueries({ queryKey: returnCaseKey(organizationId) }),
  });
  const item = detail?.case;
  const currentWait = waiting?.episodes
    .filter((e) => ['waiting', 'escalated'].includes(e.state))
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0];
  const open = item?.state === 'open';
  const canAssign = !!detail?.canManage && open;
  const manage = canAssign && !settlementStarted;
  const order = detail?.order.number ?? detail?.order.id.slice(0, 8) ?? '';
  const source = detail?.order.connection.label ?? m.returns_source_fallback();
  const close = () => setDialog(null);
  const system =
    detail?.creationAvailability.connection?.label ??
    detail?.order.connection.label ??
    m.returns_source_fallback();
  const here = item
    ? `/app/${encodeURIComponent(organizationId)}/returns/cases/${item.id}`
    : '';

  return (
    <div className="returns-page">
      <RecordHeader
        section={{
          label: m.returns_page_title(),
          domain: 'returns',
          link: (
            <Link
              to="/app/$organizationId/returns"
              params={{ organizationId }}
            />
          ),
        }}
        title={
          detail
            ? m.returns_case_title({ order })
            : m.returns_case_title_fallback()
        }
        actions={
          <RefreshButton
            refreshing={refreshing}
            onClick={refresh}
            label={m.returns_case_refresh()}
          />
        }
        status={
          item ? (
            <>
              <StatePill state={caseStageStates[item.stage]}>
                {caseStageLabels[item.stage]}
              </StatePill>
              {item.externalNumber ? (
                <Badge tone="success">
                  {m.returns_case_created_badge({
                    system,
                    number: item.externalNumber,
                  })}
                </Badge>
              ) : null}
            </>
          ) : null
        }
        description={
          detail
            ? m.returns_case_description({
                units: item!.units,
                order,
                source,
              })
            : null
        }
      />
      {error === 'missing' ? (
        <Empty>
          <Undo2 size={30} aria-hidden="true" />
          <h2>{m.returns_case_missing_title()}</h2>
          <p>{m.returns_case_missing_body()}</p>
          <Link to="/app/$organizationId/returns" params={{ organizationId }}>
            {m.returns_detail_browse()}
          </Link>
        </Empty>
      ) : error === 'access' ? (
        <Alert tone="danger" role="alert">
          {m.returns_case_no_access()}
        </Alert>
      ) : error ? (
        <Alert tone="danger" role="alert">
          {detail
            ? m.returns_case_refresh_failed()
            : m.returns_case_load_failed()}{' '}
          <Button variant="outline" onClick={refresh}>
            {m.common_retry()}
          </Button>
        </Alert>
      ) : null}
      {loading && !error ? (
        <div className="returns-loading" role="status">
          <span className="sr-only">{m.returns_case_loading()}</span>
          {Array.from({ length: 3 }, (_, i) => (
            <span className="lu-skeleton" key={i} />
          ))}
        </div>
      ) : null}
      {detail && item && error !== 'missing' ? (
        <>
          <section
            className="returns-explanation"
            data-group={open ? 'action' : 'done'}
            aria-labelledby="return-case-next-step"
          >
            <h2 id="return-case-next-step">{caseStageLabels[item.stage]}</h2>
            <p>{caseStageDescriptions[item.stage]}</p>
            <dl className="returns-facts">
              <div>
                <dt>{m.returns_service_owner()}</dt>
                <dd>
                  {item.assignee
                    ? personName(item.assignee)
                    : currentWait
                      ? personName(detail.case.openedBy)
                      : m.returns_service_unassigned()}
                </dd>
              </div>
              <div>
                <dt>{m.returns_service_waiting_on()}</dt>
                <dd>
                  {!open
                    ? item.state === 'completed'
                      ? m.returns_service_completed_wait()
                      : m.returns_service_cancelled_wait()
                    : detail.creation?.state === 'approval_required'
                      ? m.returns_service_waiting_approver()
                      : currentWait
                        ? returnWaitReasons[currentWait.reason]()
                        : detail.creation?.state === 'uncertain' ||
                            detail.creation?.state === 'sending'
                          ? m.returns_service_waiting_check()
                          : item.stage === 'awaiting_receipt'
                            ? m.returns_service_waiting_customer()
                            : item.stage === 'proposed' &&
                                sourceDetail?.item.refund.state === 'pending'
                              ? m.returns_service_waiting_payment()
                              : m.returns_service_waiting_operator()}
                </dd>
              </div>
              {open ? (
                <div>
                  <dt>{m.returns_service_blocker()}</dt>
                  <dd>
                    {sourceUnavailable
                      ? m.returns_service_source_unavailable()
                      : item.stage === 'awaiting_receipt'
                        ? m.returns_service_blocker_receipt()
                        : item.stage === 'awaiting_inspection'
                          ? m.returns_service_blocker_inspection()
                          : item.stage === 'awaiting_proposal'
                            ? m.returns_service_blocker_proposal()
                            : m.returns_service_blocker_settlement()}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>{m.returns_service_due()}</dt>
                <dd>
                  {detail.creation?.state === 'approval_required' ? (
                    <WorkspaceDate value={detail.creation.expiresAt} />
                  ) : currentWait ? (
                    <WorkspaceDate value={currentWait.dueAt} />
                  ) : (
                    m.returns_service_due_unset()
                  )}
                </dd>
              </div>
            </dl>
            {detail.case.cancellation ? (
              <p className="returns-note">
                {rich(m.returns_case_cancelled_by, {
                  name: personName(detail.case.cancellation.by),
                  date: <WorkspaceDate value={detail.case.cancellation.at} />,
                  reason: detail.case.cancellation.reason,
                })}
              </p>
            ) : null}
            {manage ? (
              <div className="returns-case-actions">
                <Button
                  variant={
                    item.stage === 'awaiting_receipt' ? 'default' : 'outline'
                  }
                  onClick={() => setDialog('receipt')}
                >
                  {detail.receipt
                    ? m.returns_case_action_receipt_again()
                    : m.returns_case_action_receipt()}
                </Button>
                {detail.receipt ? (
                  <Button
                    variant={
                      item.stage === 'awaiting_inspection'
                        ? 'default'
                        : 'outline'
                    }
                    onClick={() => setDialog('inspection')}
                  >
                    {detail.inspection
                      ? m.returns_case_action_inspection_again()
                      : m.returns_case_action_inspection()}
                  </Button>
                ) : null}
                {detail.inspection ? (
                  <Button
                    variant={
                      item.stage === 'awaiting_proposal' ? 'default' : 'outline'
                    }
                    onClick={() => setDialog('proposal')}
                  >
                    {detail.proposal
                      ? m.returns_case_action_proposal_again()
                      : m.returns_case_action_proposal()}
                  </Button>
                ) : null}
                <Button variant="ghost" onClick={() => setDialog('cancel')}>
                  {m.returns_case_action_cancel()}
                </Button>
              </div>
            ) : null}
          </section>
          <div className="returns-layout">
            <div className="returns-main">
              <ReturnServiceSummary
                detail={detail}
                now={now}
                source={sourceDetail}
                loading={sourceLoading}
                unavailable={sourceUnavailable}
              />
              {settlement}
              {settlementStarted ? (
                <Alert>{m.returns_settlement_locked()}</Alert>
              ) : null}
              <Lines detail={detail} />
              <Decisions detail={detail} />
              <Creation
                organizationId={organizationId}
                detail={detail}
                open={setDialog}
              />
              <ReturnServiceTimeline
                detail={detail}
                now={now}
                source={sourceDetail}
              />
            </div>
            <aside
              className="returns-inspector"
              aria-label={m.returns_context_label()}
            >
              <Section title={m.returns_case_facts_title()}>
                <dl className="returns-facts">
                  <div>
                    <dt>{m.returns_order_title()}</dt>
                    <dd>
                      <Link
                        to="/app/$organizationId/orders/$orderId"
                        params={{ organizationId, orderId: detail.order.id }}
                        search={{ from: here }}
                      >
                        {order} <ArrowRight size={13} aria-hidden="true" />
                      </Link>
                    </dd>
                  </div>
                  <div>
                    <dt>{m.returns_evidence_source()}</dt>
                    <dd>{source}</dd>
                  </div>
                  <div>
                    <dt>{m.returns_case_store_return()}</dt>
                    <dd>
                      {detail.sourceReturn ? (
                        <Link
                          to="/app/$organizationId/returns/$returnId"
                          params={{
                            organizationId,
                            returnId: detail.sourceReturn.id,
                          }}
                        >
                          {detail.sourceReturn.name ??
                            m.returns_case_store_return_unnamed()}{' '}
                          <ArrowRight size={13} aria-hidden="true" />
                        </Link>
                      ) : (
                        <span className="returns-muted">
                          {m.returns_case_store_return_none()}
                        </span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{m.returns_case_opened()}</dt>
                    <dd>
                      {rich(m.returns_case_decided_by, {
                        name: personName(detail.case.openedBy),
                        date: <WorkspaceDate value={item.openedAt} />,
                      })}
                    </dd>
                  </div>
                  <div>
                    <dt>{m.returns_case_assignee()}</dt>
                    <dd className="returns-case-assignee">
                      <span>
                        {item.assignee
                          ? personName(item.assignee)
                          : m.returns_case_unassigned()}
                      </span>
                      {canAssign && people.length ? (
                        <PersonPicker
                          label={m.returns_case_assign()}
                          title={m.returns_case_assign_title()}
                          disabled={assign.isPending}
                          people={people}
                          onSelect={(id) => assign.mutate(id)}
                        />
                      ) : null}
                      {canAssign && item.assignee ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={assign.isPending}
                          onClick={() => assign.mutate(null)}
                        >
                          {m.returns_case_unassign()}
                        </Button>
                      ) : null}
                    </dd>
                  </div>
                </dl>
                {assign.error ? (
                  <Alert tone="danger" role="alert">
                    {returnCaseError(assign.error)}
                  </Alert>
                ) : null}
              </Section>
            </aside>
          </div>
          {dialog === 'receipt' ? (
            <ReceiptDialog
              organizationId={organizationId}
              detail={detail}
              close={close}
            />
          ) : dialog === 'inspection' ? (
            <InspectionDialog
              organizationId={organizationId}
              detail={detail}
              close={close}
            />
          ) : dialog === 'proposal' ? (
            <ProposalDialog
              organizationId={organizationId}
              detail={detail}
              close={close}
            />
          ) : dialog === 'cancel' ? (
            <CancelDialog
              organizationId={organizationId}
              detail={detail}
              close={close}
            />
          ) : dialog === 'create' ? (
            <CreationDialog
              organizationId={organizationId}
              detail={detail}
              system={system}
              close={close}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
