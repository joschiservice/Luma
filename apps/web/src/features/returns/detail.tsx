import './returns.css';

import type { ReturnDetail } from '@luma/api-contract';
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
import { DomainIcon } from '@luma/ui/components/primitives/domain-icon';
import { Empty } from '@luma/ui/components/primitives/empty';
import { StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
import { onlineManager, useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Minus,
  RefreshCw,
  Undo2,
  X,
} from 'lucide-react';
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
import { systemName } from '../products/presentation';
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
  done: 'Done',
  current: 'Current step',
  upcoming: 'Not reached',
  failed: 'Stopped',
  skipped: 'Not needed',
  unreported: 'Not reported by the source',
};

/** Shows a return's progress from request to close, with each step's source time. */
function ReturnProgress({ detail }: { detail: ReturnDetail }) {
  const steps = returnSteps(detail);

  return (
    <ol className="returns-steps" aria-label="Return progress">
      {steps.map((step) => (
        <li key={step.key} data-state={step.state}>
          <span className="returns-step-marker">{stepIcons[step.state]}</span>
          <span className="returns-step-body">
            <strong>{step.label}</strong>
            <span className="sr-only">{stepStateLabels[step.state]}. </span>
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
      title="Money"
      description="Only successful refund payments count as money returned."
    >
      <dl className="returns-money-summary">
        <div data-tone="success">
          <dt>Refunded to the customer</dt>
          <dd>
            <span>{refunded ?? 'Nothing yet'}</span>
          </dd>
        </div>
        <div data-tone={pending ? 'info' : undefined}>
          <dt>Processing</dt>
          <dd>
            <span>{pending ?? 'None'}</span>
            {pending ? <small>Not received by the customer yet</small> : null}
          </dd>
        </div>
        {refund.failedAttempts ? (
          <div data-tone="danger">
            <dt>Failed payment attempts</dt>
            <dd>
              <span>{refund.failedAttempts}</span>
            </dd>
          </div>
        ) : null}
        {detail.item.kind === 'return' ? (
          <div>
            <dt>Value of returned items</dt>
            <dd>
              <span>{formatMoney(value) ?? 'Not reported'}</span>
              <small>After discounts; not an amount refunded</small>
            </dd>
          </div>
        ) : null}
      </dl>
      {refund.currency === null && refund.state !== 'none' ? (
        <p className="returns-note">
          Refund payments use several currencies, so Luma does not add them up.
          Each payment is listed under Refunds.
        </p>
      ) : null}
    </Section>
  );
}

/** Lists each refund with every payment attempt and the units it covered. */
function Refunds({ detail }: { detail: ReturnDetail }) {
  return (
    <Section
      title="Refunds"
      description="Each refund with every payment attempt, as the source reports them."
    >
      {detail.refunds.length ? (
        <ol className="returns-refunds">
          {detail.refunds.map((refund, index) => {
            const outcome = refundOutcome(refund.transactions);

            return (
              <li key={refund.id}>
                <div className="returns-refund-head">
                  <strong>Refund {index + 1}</strong>
                  {refund.transactions.length === 1 ? null : (
                    <Badge tone={transactionTones[outcome]}>
                      {refund.transactions.length
                        ? transactionLabels[outcome]
                        : refundLabels.recorded}
                    </Badge>
                  )}
                  {refund.createdAt ? (
                    <small>
                      Created <WorkspaceDate value={refund.createdAt} />
                    </small>
                  ) : null}
                </div>
                {refund.transactions.length ? (
                  <ul
                    className="returns-payments"
                    aria-label="Payment attempts"
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
                            'Not processed yet'
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
                    No payment is attached to this refund, so no money was
                    returned through it.
                  </p>
                )}
                {refund.lines.length ? (
                  <p className="returns-note">
                    {refund.lines
                      .map(
                        (line) =>
                          `${units(line.quantity)} × ${line.title ?? 'Order line'} · ${restockLabels[line.restock]}`,
                      )
                      .join('; ')}
                  </p>
                ) : null}
                <small className="returns-muted">
                  {refund.total
                    ? `Source total ${formatMoney(refund.total)} · `
                    : ''}
                  {refund.externalId ? `Source ID ${refund.externalId} · ` : ''}
                  Read <WorkspaceDate value={refund.observedAt} />
                </small>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="returns-note">
          {detail.item.stage === 'declined' || detail.item.stage === 'cancelled'
            ? 'No refund is expected for this return.'
            : 'No refund has been issued for this return yet.'}
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
      title="Items"
      description="Requested units with the reason given, and what the source reports as received and refunded."
    >
      <DataTable
        className="returns-items"
        caption="Returned items"
        rows={detail.lines}
        rowKey={(line) =>
          `${line.orderLineId ?? 'unmatched'}:${line.reason}:${line.quantity}`
        }
        columns={[
          {
            key: 'item',
            header: 'Item',
            cell: (line) => (
              <span className="returns-cell">
                {line.skuId ? (
                  <Link
                    to="/app/$organizationId/products/$skuId"
                    params={{ organizationId, skuId: line.skuId }}
                  >
                    {line.title ?? line.skuCode ?? 'Order line'}
                  </Link>
                ) : (
                  <span>
                    {line.title ??
                      (line.orderLineId
                        ? 'Order line'
                        : 'Not matched to an order line')}
                  </span>
                )}
                <small>{line.skuCode ? `SKU ${line.skuCode}` : 'No SKU'}</small>
              </span>
            ),
          },
          {
            key: 'quantity',
            header: 'Returned',
            numeric: true,
            cell: (line) => units(line.quantity),
          },
          {
            key: 'reason',
            header: 'Reason',
            cell: (line) => line.reason ?? 'Not given',
          },
          {
            key: 'received',
            header: 'Received',
            numeric: true,
            cell: (line) =>
              line.received === null ? (
                <span className="returns-muted">Not reported</span>
              ) : (
                <span className="returns-cell">
                  <span>{units(line.received)}</span>
                  {line.restocked !== null && Number(line.restocked) > 0 ? (
                    <small>{units(line.restocked)} restocked</small>
                  ) : null}
                </span>
              ),
          },
          {
            key: 'refunded',
            header: 'Refunded',
            numeric: true,
            cell: (line) =>
              line.refunded === null ? (
                <span className="returns-muted">Not reported</span>
              ) : (
                units(line.refunded)
              ),
          },
          {
            key: 'value',
            header: 'Value',
            numeric: true,
            hideOnNarrow: true,
            cell: (line) => formatMoney(line.value) ?? '—',
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
  const system = detail?.source?.system ?? null;
  const store = system ? systemName(system) : 'the source';
  const here = item
    ? `/app/${encodeURIComponent(organizationId)}/returns/${item.id}`
    : '';

  return (
    <main className="returns-page">
      {from ? (
        <Link className="returns-back" to={from}>
          <ArrowLeft size={14} />
          Back to context
        </Link>
      ) : (
        <Link
          className="returns-back"
          to="/app/$organizationId/returns"
          params={{ organizationId }}
          search={returnFilters(search)}
        >
          <ArrowLeft size={14} />
          Back to returns
        </Link>
      )}
      <PageHeader
        title={item ? returnLabel(item) : 'Return'}
        icon={<DomainIcon domain="returns" size="md" />}
        description={
          item
            ? `${item.kind === 'refund' ? 'Refund without a return' : 'Return'} for order ${item.order.displayNumber ?? item.order.id.slice(0, 8)} · ${detail?.source?.label ?? 'Connected source'}`
            : 'Follow a return from request to refund.'
        }
      />
      <div className="returns-detail-toolbar">
        <span className="returns-flags">
          {item ? (
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
                <Badge tone="warning">Removed at source</Badge>
              ) : null}
            </>
          ) : null}
        </span>
        <Button variant="outline" disabled={refreshing} onClick={refresh}>
          <RefreshCw size={14} />
          Refresh return
        </Button>
      </div>
      {offline ? (
        <Alert role="status">
          You are offline. The return below may be out of date.
        </Alert>
      ) : null}
      {error === 'missing' ? (
        <Empty>
          <Undo2 size={30} aria-hidden="true" />
          <h2>Return not found</h2>
          <p>
            This return is not in this workspace, or no source reports it
            anymore.
          </p>
          <Link to="/app/$organizationId/returns" params={{ organizationId }}>
            Browse returns
          </Link>
        </Empty>
      ) : error === 'access' ? (
        <Alert tone="danger" role="alert">
          You no longer have access to returns in this workspace.
        </Alert>
      ) : error ? (
        <Alert tone="danger" role="alert">
          {detail
            ? 'This return could not be refreshed. The details below may be out of date.'
            : 'This return could not be loaded.'}{' '}
          <Button variant="outline" onClick={refresh}>
            Retry
          </Button>
        </Alert>
      ) : null}
      {loading && !error ? (
        <div className="returns-loading" role="status">
          <span className="sr-only">Loading return…</span>
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
                ? `Next step: ${stageLabels[item.stage].toLowerCase()}`
                : item.group === 'waiting'
                  ? stageLabels[item.stage]
                  : 'Nothing pending'}
            </h2>
            <p>{nextStep(item, system)}</p>
            {item.group === 'action' ? (
              <p className="returns-note">
                Luma does not approve, receive or refund returns. Do it in{' '}
                {store}; Luma reads the result on its next sync.
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
                  title={`${store} order details`}
                  description={`Customer, payments and source events for this order, read live from ${store} with the connection’s permissions.`}
                >
                  {orderContext}
                </Section>
              ) : null}
              <Section
                title="Observed history"
                description="Each entry is a state Luma read from the source, newest first. It shows what the source reported at that time, not every change it made."
              >
                <ol className="returns-history">
                  {detail.history.entries.map((entry) => (
                    <li key={entry.snapshotId}>
                      <span className="returns-cell">
                        <strong>
                          {entry.entityKind === 'return'
                            ? `Return ${entry.status ?? 'unknown'}`
                            : 'Refund recorded'}
                          {entry.deleted ? ' · removed' : ''}
                        </strong>
                        <small>
                          Source time{' '}
                          {entry.sourceUpdatedAt ? (
                            <WorkspaceDate value={entry.sourceUpdatedAt} />
                          ) : (
                            'not reported'
                          )}
                          {' · Read '}
                          <WorkspaceDate value={entry.observedAt} />
                        </small>
                      </span>
                      {entry.current ? <Badge>Current</Badge> : null}
                    </li>
                  ))}
                </ol>
                {detail.history.truncated ? (
                  <p className="returns-note">Showing the latest 50 reads.</p>
                ) : null}
              </Section>
            </div>
            <aside className="returns-inspector" aria-label="Return context">
              <MoneySummary detail={detail} />
              <Section title="Order">
                {detail.order ? (
                  <dl className="returns-facts">
                    <div>
                      <dt>Order</dt>
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
                      <dt>Status</dt>
                      <dd>
                        {statusLabels[detail.order.status] ??
                          detail.order.status}
                      </dd>
                    </div>
                    <div>
                      <dt>Payment</dt>
                      <dd>
                        {paymentLabels[detail.order.paymentStatus] ??
                          detail.order.paymentStatus}
                      </dd>
                    </div>
                    <div>
                      <dt>Total</dt>
                      <dd>
                        {formatMoney(detail.order.total) ?? 'Not reported'}
                      </dd>
                    </div>
                    <div>
                      <dt>Placed</dt>
                      <dd>
                        {detail.order.placedAt ? (
                          <WorkspaceDate value={detail.order.placedAt} />
                        ) : (
                          'Not reported'
                        )}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  <p className="returns-note">
                    The order is no longer reported by this source.
                  </p>
                )}
              </Section>
              <Section title="Source and evidence">
                <dl className="returns-facts">
                  <div>
                    <dt>Source</dt>
                    <dd>{detail.source?.label ?? 'Connected source'}</dd>
                  </div>
                  <div>
                    <dt>Source ID</dt>
                    <dd>
                      <code>{item.externalId ?? 'Not mapped'}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Read</dt>
                    <dd>
                      <WorkspaceDate value={item.observedAt} />
                    </dd>
                  </div>
                  <div>
                    <dt>Last source activity</dt>
                    <dd>
                      <WorkspaceDate value={item.activityAt} />
                    </dd>
                  </div>
                  {detail.source?.lastReadAt ? (
                    <div>
                      <dt>Last returns sync</dt>
                      <dd>
                        <WorkspaceDate value={detail.source.lastReadAt} />
                        {detail.source.failing ? ' · retrying' : ''}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </Section>
              {detail.related.length ? (
                <Section title="Other returns of this order">
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
    </main>
  );
}
