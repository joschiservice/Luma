import './returns.css';

import type { ReturnDetail } from '@luma/api-contract';
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
import { RefreshButton } from '@luma/ui/components/primitives/refresh-button';
import { StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { RecordHeader } from '@luma/ui/components/workspace/record-header';
import { onlineManager, useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { ArrowRight, Check, Minus, Undo2, X } from 'lucide-react';
import { type ReactNode, useSyncExternalStore } from 'react';

import { appsOptions } from '../apps/data';
import { AppExtension } from '../apps/extension';
import { SignInRedirect } from '../identity/common';
import { IdentityError } from '../identity/data';
import {
  formatMoney,
  paymentLabels,
  statusLabels,
} from '../orders/presentation';
import { recordReturnPath } from '../records/data';
import { returnFilters, returnOptions, type ReturnsSearch } from './data';
import {
  nextStep,
  refundLabels,
  refundMoney,
  refundOutcome,
  restockLabels,
  returnLabel,
  returnSteps,
  returnSystem,
  showsRefundState,
  stageLabels,
  stageStates,
  transactionLabels,
  transactionTones,
  units,
} from './presentation';

const subscribe = (changed: () => void) => onlineManager.subscribe(changed);
const onlineSnapshot = () => onlineManager.isOnline();
const serverSnapshot = () => true;

export type ReturnError = 'missing' | 'access' | 'unavailable';

/** Loads one return and mounts live order context from installed apps that support records. */
export function ReturnPage() {
  const { organizationId, returnId } = useParams({
    from: '/app/$organizationId/returns/$returnId',
  });
  const search = useSearch({ from: '/app/$organizationId/returns/$returnId' });
  const query = useQuery(returnOptions(organizationId, returnId));
  const apps = useQuery(appsOptions(organizationId));
  const online = useSyncExternalStore(
    subscribe,
    onlineSnapshot,
    serverSnapshot,
  );
  if (query.error instanceof IdentityError && query.error.status === 401)
    return <SignInRedirect />;
  const status = query.error instanceof IdentityError ? query.error.status : 0;
  const detail = status === 403 ? undefined : query.data;
  const appId = detail?.source?.appId;
  const recordApp =
    !!appId &&
    (apps.data?.catalog ?? []).some(
      (app) =>
        app.id === appId &&
        app.ui.includes('record') &&
        apps.data?.installations.some(
          (item) => item.appId === app.id && item.status === 'installed',
        ),
    );

  return (
    <ReturnDetailView
      organizationId={organizationId}
      search={search}
      detail={detail}
      loading={query.isPending}
      refreshing={query.isFetching}
      offline={!online}
      error={
        !query.error
          ? undefined
          : status === 404
            ? 'missing'
            : status === 403
              ? 'access'
              : 'unavailable'
      }
      refresh={() => void query.refetch()}
      orderContext={
        detail?.order?.externalId && appId && recordApp ? (
          <AppExtension
            appId={appId}
            organizationId={organizationId}
            slot="record"
            record={{
              kind: 'order',
              connectionId: detail.item.connectionId,
              externalId: detail.order.externalId,
            }}
            done={async () => undefined}
          />
        ) : null
      }
    />
  );
}

function Section({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card as="section" aria-label={title} className={className}>
      <CardHeader>
        <div>
          <CardTitle as="h2">{title}</CardTitle>
          {description ? (
            <CardDescription>{description}</CardDescription>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

const stepIcons = {
  done: <Check size={14} strokeWidth={3} aria-hidden="true" />,
  failed: <X size={14} strokeWidth={3} aria-hidden="true" />,
  skipped: <Minus size={14} strokeWidth={3} aria-hidden="true" />,
  unreported: <Minus size={14} strokeWidth={3} aria-hidden="true" />,
  current: <span className="returns-step-pulse" aria-hidden="true" />,
  upcoming: null,
};

const stepStateLabels = {
  done: m.returns_step_state_done,
  current: m.returns_step_state_current,
  upcoming: m.returns_step_state_upcoming,
  failed: m.returns_step_state_failed,
  skipped: m.returns_step_state_skipped,
  unreported: m.returns_step_state_unreported,
};

const historyStatuses: Record<string, () => string> = {
  requested: m.returns_history_status_requested,
  open: m.returns_history_status_open,
  closed: m.returns_history_status_closed,
  declined: m.returns_history_status_declined,
  cancelled: m.returns_history_status_cancelled,
};

/** Names a return state read from the source, keeping unrecognized statuses readable. */
function historyStatus(status: string | null) {
  if (status === null || status === 'unknown')
    return m.returns_history_status_unknown();

  return (
    historyStatuses[status]?.() ?? m.returns_history_status_other({ status })
  );
}

/** Shows a return's progress from request to close, with each step's source time. */
function ReturnProgress({ detail }: { detail: ReturnDetail }) {
  const steps = returnSteps(detail);

  return (
    <ol className="returns-steps" aria-label={m.returns_progress_label()}>
      {steps.map((step) => (
        <li key={step.key} data-state={step.state}>
          <span className="returns-step-marker">{stepIcons[step.state]}</span>
          <span className="returns-step-body">
            <strong>{step.label}</strong>
            <span className="sr-only">{stepStateLabels[step.state]()}. </span>
            <small>{step.detail}</small>
            {step.at ? (
              <small>
                <WorkspaceDate value={step.at} />
              </small>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Separates money actually returned from payments in progress and the value of the items. */
function MoneySummary({ detail }: { detail: ReturnDetail }) {
  const { refund, value } = detail.item;
  const refunded = refundMoney(refund.refunded, refund.currency);
  const pending = refundMoney(refund.pending, refund.currency);

  return (
    <Section
      title={m.returns_money_title()}
      description={m.returns_money_description()}
    >
      <dl className="returns-money-summary">
        <div data-tone="success">
          <dt>{m.returns_money_refunded()}</dt>
          <dd>
            <span>{refunded ?? m.returns_money_nothing_yet()}</span>
          </dd>
        </div>
        <div data-tone={pending ? 'info' : undefined}>
          <dt>{m.returns_money_processing()}</dt>
          <dd>
            <span>{pending ?? m.returns_money_none()}</span>
            {pending ? <small>{m.returns_money_not_received()}</small> : null}
          </dd>
        </div>
        {refund.failedAttempts ? (
          <div data-tone="danger">
            <dt>{m.returns_money_failed_attempts()}</dt>
            <dd>
              <span>{formatNumber(refund.failedAttempts)}</span>
            </dd>
          </div>
        ) : null}
        {detail.item.kind === 'return' ? (
          <div>
            <dt>{m.returns_money_item_value()}</dt>
            <dd>
              <span>{formatMoney(value) ?? m.common_not_reported()}</span>
              <small>{m.returns_money_item_value_hint()}</small>
            </dd>
          </div>
        ) : null}
      </dl>
      {refund.currency === null && refund.state !== 'none' ? (
        <p className="returns-note">{m.returns_money_several_currencies()}</p>
      ) : null}
    </Section>
  );
}

/** Lists each refund with every payment attempt and the units it covered. */
function Refunds({ detail }: { detail: ReturnDetail }) {
  return (
    <Section
      title={m.returns_refunds_title()}
      description={m.returns_refunds_description()}
    >
      {detail.refunds.length ? (
        <ol className="returns-refunds">
          {detail.refunds.map((refund, index) => {
            const outcome = refundOutcome(refund.transactions);

            return (
              <li key={refund.id}>
                <div className="returns-refund-head">
                  <strong>
                    {m.returns_refunds_item({ index: index + 1 })}
                  </strong>
                  {refund.transactions.length === 1 ? null : (
                    <Badge tone={transactionTones[outcome]}>
                      {refund.transactions.length
                        ? transactionLabels[outcome]
                        : refundLabels.recorded}
                    </Badge>
                  )}
                  {refund.createdAt ? (
                    <small>
                      {rich(m.returns_refunds_created, {
                        date: <WorkspaceDate value={refund.createdAt} />,
                      })}
                    </small>
                  ) : null}
                </div>
                {refund.transactions.length ? (
                  <ul
                    className="returns-payments"
                    aria-label={m.returns_refunds_payments_label()}
                  >
                    {refund.transactions.map((transaction, position) => (
                      <li key={position}>
                        <Badge tone={transactionTones[transaction.status]}>
                          {transactionLabels[transaction.status]}
                        </Badge>
                        <span className="returns-money">
                          {formatMoney(transaction.amount)}
                        </span>
                        <small>
                          {transaction.processedAt ? (
                            <WorkspaceDate value={transaction.processedAt} />
                          ) : (
                            m.returns_refunds_not_processed()
                          )}
                          {transaction.gateway
                            ? ` · ${transaction.gateway.replaceAll('_', ' ')}`
                            : ''}
                        </small>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="returns-note">
                    {m.returns_refunds_no_payment()}
                  </p>
                )}
                {refund.lines.length ? (
                  <p className="returns-note">
                    {refund.lines
                      .map((line) =>
                        m.returns_refunds_line({
                          quantity: units(line.quantity),
                          item: line.title ?? m.returns_refunds_order_line(),
                          restock: restockLabels[line.restock],
                        }),
                      )
                      .join('; ')}
                  </p>
                ) : null}
                <small className="returns-muted">
                  {refund.total
                    ? `${m.returns_refunds_source_total({ total: formatMoney(refund.total) ?? '' })} · `
                    : ''}
                  {refund.externalId
                    ? `${m.returns_refunds_source_id({ id: refund.externalId })} · `
                    : ''}
                  {rich(m.returns_refunds_read, {
                    date: <WorkspaceDate value={refund.observedAt} />,
                  })}
                </small>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="returns-note">
          {detail.item.stage === 'declined' || detail.item.stage === 'cancelled'
            ? m.returns_refunds_none_expected()
            : m.returns_refunds_none_yet()}
        </p>
      )}
    </Section>
  );
}

/** Lists the returned items with reasons and what came back and was refunded. */
function Items({
  detail,
  organizationId,
}: {
  detail: ReturnDetail;
  organizationId: string;
}) {
  return (
    <Section
      title={m.returns_items_title()}
      description={m.returns_items_description()}
    >
      <DataTable
        className="returns-items"
        caption={m.returns_items_caption()}
        rows={detail.lines}
        rowKey={(line) =>
          `${line.orderLineId ?? 'unmatched'}:${line.reason}:${line.quantity}`
        }
        columns={[
          {
            key: 'item',
            header: m.returns_items_column_item(),
            cell: (line) => (
              <span className="returns-cell">
                {line.skuId ? (
                  <Link
                    to="/app/$organizationId/products/$skuId"
                    params={{ organizationId, skuId: line.skuId }}
                  >
                    {line.title ??
                      line.skuCode ??
                      m.returns_refunds_order_line()}
                  </Link>
                ) : (
                  <span>
                    {line.title ??
                      (line.orderLineId
                        ? m.returns_refunds_order_line()
                        : m.returns_items_unmatched())}
                  </span>
                )}
                <small>
                  {line.skuCode
                    ? m.returns_items_sku({ sku: line.skuCode })
                    : m.returns_items_no_sku()}
                </small>
              </span>
            ),
          },
          {
            key: 'quantity',
            header: m.returns_items_column_returned(),
            numeric: true,
            cell: (line) => units(line.quantity),
          },
          {
            key: 'reason',
            header: m.returns_items_column_reason(),
            cell: (line) => line.reason ?? m.returns_items_no_reason(),
          },
          {
            key: 'received',
            header: m.returns_items_column_received(),
            numeric: true,
            cell: (line) =>
              line.received === null ? (
                <span className="returns-muted">{m.common_not_reported()}</span>
              ) : (
                <span className="returns-cell">
                  <span>{units(line.received)}</span>
                  {line.restocked !== null && Number(line.restocked) > 0 ? (
                    <small>
                      {m.returns_items_restocked({
                        units: units(line.restocked),
                      })}
                    </small>
                  ) : null}
                </span>
              ),
          },
          {
            key: 'refunded',
            header: m.returns_items_column_refunded(),
            numeric: true,
            cell: (line) =>
              line.refunded === null ? (
                <span className="returns-muted">{m.common_not_reported()}</span>
              ) : (
                units(line.refunded)
              ),
          },
          {
            key: 'value',
            header: m.returns_items_column_value(),
            numeric: true,
            hideOnNarrow: true,
            cell: (line) => formatMoney(line.value) ?? m.common_empty_value(),
          },
        ]}
      />
    </Section>
  );
}

/** Shows one return: next step, progress, items, refunds, money, order context and evidence. */
export function ReturnDetailView({
  organizationId,
  search = {},
  detail,
  error,
  loading = false,
  refreshing = false,
  offline = false,
  refresh,
  orderContext,
}: {
  organizationId: string;
  search?: ReturnsSearch;
  detail?: ReturnDetail | undefined;
  error?: ReturnError | undefined;
  loading?: boolean;
  refreshing?: boolean;
  offline?: boolean;
  refresh: () => void;
  /** Live customer and payment context for the order from its source app. */
  orderContext?: ReactNode;
}) {
  const from = recordReturnPath(organizationId, search.from);
  const item = detail?.item;
  const system = returnSystem(detail?.source?.system ?? null);
  const here = item
    ? `/app/${encodeURIComponent(organizationId)}/returns/${item.id}`
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
              search={returnFilters(search)}
            />
          ),
        }}
        title={item ? returnLabel(item) : m.returns_detail_title_fallback()}
        back={from ? <Link to={from} /> : undefined}
        actions={
          <RefreshButton refreshing={refreshing} onClick={refresh}>
            {m.returns_detail_refresh()}
          </RefreshButton>
        }
        status={
          item ? (
            <>
              <StatePill state={stageStates[item.stage]}>
                {stageLabels[item.stage]}
              </StatePill>
              {showsRefundState(item) ? (
                <Badge
                  tone={
                    item.refund.state === 'refunded'
                      ? 'success'
                      : item.refund.state === 'pending'
                        ? 'info'
                        : 'neutral'
                  }
                >
                  {refundLabels[item.refund.state]}
                </Badge>
              ) : null}
              {item.deleted ? (
                <Badge tone="warning">{m.returns_removed_at_source()}</Badge>
              ) : null}
            </>
          ) : null
        }
        description={
          item
            ? (item.kind === 'refund'
                ? m.returns_detail_description_refund
                : m.returns_detail_description_return)({
                order: item.order.displayNumber ?? item.order.id.slice(0, 8),
                source: detail?.source?.label ?? m.returns_source_fallback(),
              })
            : null
        }
      />
      {offline ? (
        <Alert role="status">{m.returns_detail_offline()}</Alert>
      ) : null}
      {error === 'missing' ? (
        <Empty>
          <Undo2 size={30} aria-hidden="true" />
          <h2>{m.returns_detail_missing_title()}</h2>
          <p>{m.returns_detail_missing_body()}</p>
          <Link to="/app/$organizationId/returns" params={{ organizationId }}>
            {m.returns_detail_browse()}
          </Link>
        </Empty>
      ) : error === 'access' ? (
        <Alert tone="danger" role="alert">
          {m.returns_detail_no_access()}
        </Alert>
      ) : error ? (
        <Alert tone="danger" role="alert">
          {detail
            ? m.returns_detail_refresh_failed()
            : m.returns_detail_load_failed()}{' '}
          <Button variant="outline" onClick={refresh}>
            {m.common_retry()}
          </Button>
        </Alert>
      ) : null}
      {loading && !error ? (
        <div className="returns-loading" role="status">
          <span className="sr-only">{m.returns_detail_loading()}</span>
          {Array.from({ length: 3 }, (_, i) => (
            <span className="lu-skeleton" key={i} />
          ))}
        </div>
      ) : null}
      {detail && item && error !== 'missing' ? (
        <>
          <section
            className="returns-explanation"
            data-group={item.group}
            aria-labelledby="return-next-step"
          >
            <h2 id="return-next-step">
              {item.group === 'action'
                ? m.returns_detail_next_step({ stage: stageLabels[item.stage] })
                : item.group === 'waiting'
                  ? stageLabels[item.stage]
                  : m.returns_detail_nothing_pending()}
            </h2>
            <p>{nextStep(item, detail.source?.system ?? null)}</p>
            {item.group === 'action' ? (
              <p className="returns-note">
                {m.returns_detail_luma_note({ system })}
              </p>
            ) : null}
          </section>
          {item.kind === 'return' ? <ReturnProgress detail={detail} /> : null}
          <div className="returns-layout">
            <div className="returns-main">
              {item.kind === 'return' ? (
                <Items detail={detail} organizationId={organizationId} />
              ) : null}
              <Refunds detail={detail} />
              {orderContext ? (
                <Section
                  title={m.returns_order_details_title({ system })}
                  description={m.returns_order_details_description({
                    system,
                  })}
                >
                  {orderContext}
                </Section>
              ) : null}
              <Section
                title={m.returns_history_title()}
                description={m.returns_history_description()}
              >
                <ol className="returns-history">
                  {detail.history.entries.map((entry) => (
                    <li key={entry.snapshotId}>
                      <span className="returns-cell">
                        <strong>
                          {entry.entityKind === 'return'
                            ? historyStatus(entry.status)
                            : m.returns_history_refund_recorded()}
                          {entry.deleted
                            ? ` · ${m.returns_history_removed()}`
                            : ''}
                        </strong>
                        <small>
                          {entry.sourceUpdatedAt
                            ? rich(m.returns_history_times, {
                                source: (
                                  <WorkspaceDate
                                    value={entry.sourceUpdatedAt}
                                  />
                                ),
                                read: (
                                  <WorkspaceDate value={entry.observedAt} />
                                ),
                              })
                            : rich(m.returns_history_times_unreported, {
                                read: (
                                  <WorkspaceDate value={entry.observedAt} />
                                ),
                              })}
                        </small>
                      </span>
                      {entry.current ? (
                        <Badge>{m.returns_history_current()}</Badge>
                      ) : null}
                    </li>
                  ))}
                </ol>
                {detail.history.truncated ? (
                  <p className="returns-note">
                    {m.returns_history_truncated()}
                  </p>
                ) : null}
              </Section>
            </div>
            <aside
              className="returns-inspector"
              aria-label={m.returns_context_label()}
            >
              <MoneySummary detail={detail} />
              <Section title={m.returns_order_title()}>
                {detail.order ? (
                  <dl className="returns-facts">
                    <div>
                      <dt>{m.returns_order_title()}</dt>
                      <dd>
                        <Link
                          to="/app/$organizationId/orders/$orderId"
                          params={{
                            organizationId,
                            orderId: detail.order.id,
                          }}
                          search={{ from: here }}
                        >
                          {detail.order.displayNumber ??
                            detail.order.id.slice(0, 8)}{' '}
                          <ArrowRight size={13} aria-hidden="true" />
                        </Link>
                      </dd>
                    </div>
                    <div>
                      <dt>{m.returns_order_status()}</dt>
                      <dd>
                        {statusLabels[detail.order.status] ??
                          detail.order.status}
                      </dd>
                    </div>
                    <div>
                      <dt>{m.returns_order_payment()}</dt>
                      <dd>
                        {paymentLabels[detail.order.paymentStatus] ??
                          detail.order.paymentStatus}
                      </dd>
                    </div>
                    <div>
                      <dt>{m.returns_order_total()}</dt>
                      <dd>
                        {formatMoney(detail.order.total) ??
                          m.common_not_reported()}
                      </dd>
                    </div>
                    <div>
                      <dt>{m.returns_order_placed()}</dt>
                      <dd>
                        {detail.order.placedAt ? (
                          <WorkspaceDate value={detail.order.placedAt} />
                        ) : (
                          m.common_not_reported()
                        )}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  <p className="returns-note">{m.returns_order_missing()}</p>
                )}
              </Section>
              <Section title={m.returns_evidence_title()}>
                <dl className="returns-facts">
                  <div>
                    <dt>{m.returns_evidence_source()}</dt>
                    <dd>
                      {detail.source?.label ?? m.returns_source_fallback()}
                    </dd>
                  </div>
                  <div>
                    <dt>{m.returns_evidence_source_id()}</dt>
                    <dd>
                      <code>
                        {item.externalId ?? m.returns_evidence_not_linked()}
                      </code>
                    </dd>
                  </div>
                  <div>
                    <dt>{m.returns_evidence_read()}</dt>
                    <dd>
                      <WorkspaceDate value={item.observedAt} />
                    </dd>
                  </div>
                  <div>
                    <dt>{m.returns_evidence_activity()}</dt>
                    <dd>
                      <WorkspaceDate value={item.activityAt} />
                    </dd>
                  </div>
                  {detail.source?.lastReadAt ? (
                    <div>
                      <dt>{m.returns_evidence_last_sync()}</dt>
                      <dd>
                        {detail.source.failing ? (
                          rich(m.returns_evidence_retrying, {
                            date: (
                              <WorkspaceDate value={detail.source.lastReadAt} />
                            ),
                          })
                        ) : (
                          <WorkspaceDate value={detail.source.lastReadAt} />
                        )}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </Section>
              {detail.related.length ? (
                <Section title={m.returns_related_title()}>
                  <ul className="returns-related">
                    {detail.related.map((other) => (
                      <li key={other.id}>
                        <Link
                          to="/app/$organizationId/returns/$returnId"
                          params={{ organizationId, returnId: other.id }}
                          search={search}
                        >
                          {returnLabel(other)}
                        </Link>
                        <StatePill state={stageStates[other.stage]}>
                          {stageLabels[other.stage]}
                        </StatePill>
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : null}
            </aside>
          </div>
        </>
      ) : null}
    </div>
  );
}
