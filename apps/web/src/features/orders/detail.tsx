import './orders.css';

import type {
  ActivityEvent,
  OrderDetail,
  OrderSourceFacts,
} from '@luma/api-contract';
import { issueKind } from '@luma/ui/components/issues/case-presentation';
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
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { StateDot, StatePill } from '@luma/ui/components/primitives/state';
import {
  WorkspaceDate,
  WorkspaceTimezone,
} from '@luma/ui/components/primitives/workspace-date';
import { workspaceDateValue } from '@luma/ui/lib/timezone';
import { onlineManager, useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, Copy } from 'lucide-react';
import {
  type ReactNode,
  useContext,
  useState,
  useSyncExternalStore,
} from 'react';

import { activityLabel, activityState } from '../activity/presentation';
import { appsOptions } from '../apps/data';
import { AppExtension } from '../apps/extension';
import { SignInRedirect } from '../identity/common';
import { IdentityError } from '../identity/data';
import { recordReturnPath } from '../records/data';
import { orderFilters, orderOptions, type OrdersSearch } from './data';
import {
  formatMoney,
  formatQuantity,
  fulfillmentLabel,
  orderLabel,
  orderSummary,
  paymentLabels,
  shipmentLabels,
  statusLabels,
} from './presentation';

const subscribe = (changed: () => void) => onlineManager.subscribe(changed);
const onlineSnapshot = () => onlineManager.isOnline();
const serverSnapshot = () => true;

/** Loads one order and mounts live context from installed apps that support records. */
export function OrderPage() {
  const { organizationId, orderId } = useParams({
    from: '/app/$organizationId/orders/$orderId',
  });
  const search = useSearch({ from: '/app/$organizationId/orders/$orderId' });
  const query = useQuery(orderOptions(organizationId, orderId));
  const apps = useQuery(appsOptions(organizationId));
  const online = useSyncExternalStore(
    subscribe,
    onlineSnapshot,
    serverSnapshot,
  );
  if (query.error instanceof IdentityError && query.error.status === 401)
    return <SignInRedirect />;
  const status = query.error instanceof IdentityError ? query.error.status : 0;
  const recordApps = new Set(
    (apps.data?.catalog ?? [])
      .filter(
        (app) =>
          app.ui.includes('record') &&
          apps.data?.installations.some(
            (item) => item.appId === app.id && item.status === 'installed',
          ),
      )
      .map((app) => app.id),
  );

  return (
    <OrderDetailView
      organizationId={organizationId}
      search={search}
      detail={status === 403 ? undefined : query.data}
      loading={query.isPending}
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
      sourceContext={(source) =>
        source.appId && source.externalId && recordApps.has(source.appId) ? (
          <AppExtension
            appId={source.appId}
            organizationId={organizationId}
            slot="record"
            record={{
              kind: 'order',
              connectionId: source.connectionId,
              externalId: source.externalId,
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
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Card as="section" aria-label={title}>
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          {description ? (
            <CardDescription>{description}</CardDescription>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Lines({
  source,
  organizationId,
  from,
}: {
  source: OrderSourceFacts;
  organizationId: string;
  from: string;
}) {
  if (!source.lines.length)
    return <p className="order-note">This source reports no order lines.</p>;

  return (
    <div className="orders-table-wrap">
      <table className="order-lines">
        <caption className="sr-only">Lines reported by {source.label}</caption>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col" className="orders-number">
              Ordered
            </th>
            <th scope="col" className="orders-number">
              Cancelled
            </th>
            <th scope="col" className="orders-number">
              Fulfilled
            </th>
            <th scope="col" className="orders-number">
              Remaining
            </th>
          </tr>
        </thead>
        <tbody>
          {source.lines.map((line) => (
            <tr key={line.id}>
              <th scope="row">
                <span className="orders-cell-stack">
                  <span>{line.title ?? line.skuCode ?? 'Untitled item'}</span>
                  <small>
                    {line.skuCode ? `SKU ${line.skuCode}` : 'No SKU text'}
                    {line.skuId ? (
                      <>
                        {' · '}
                        <Link
                          to="/app/$organizationId/records/$kind/$recordId"
                          params={{
                            organizationId,
                            kind: 'sku',
                            recordId: line.skuId,
                          }}
                          search={{ from }}
                        >
                          Stock and product
                        </Link>
                      </>
                    ) : (
                      ' · SKU not mapped'
                    )}
                  </small>
                </span>
              </th>
              <td className="orders-number">
                {formatQuantity(line.quantity, line.unit)}
              </td>
              <td className="orders-number">
                {line.cancelledQuantity === null
                  ? 'Not reported'
                  : formatQuantity(line.cancelledQuantity, line.unit)}
              </td>
              <td className="orders-number">
                {formatQuantity(line.fulfilledQuantity, line.unit)}
              </td>
              <td className="orders-number">
                {line.remainingQuantity === null
                  ? 'Unknown'
                  : formatQuantity(line.remainingQuantity, line.unit)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Comparison({ detail }: { detail: OrderDetail }) {
  const differs = new Set<string>(detail.differences.map((item) => item.field));
  const rows: {
    label: string;
    field?: string;
    value: (source: OrderSourceFacts) => ReactNode;
  }[] = [
    { label: 'Number', value: (source) => source.displayNumber ?? '—' },
    {
      label: 'Status',
      field: 'status',
      value: (source) => statusLabels[source.status] ?? source.status,
    },
    {
      label: 'Payment',
      field: 'paymentStatus',
      value: (source) =>
        paymentLabels[source.paymentStatus] ?? source.paymentStatus,
    },
    {
      label: 'Total',
      field: 'total',
      value: (source) => formatMoney(source.total) ?? 'Not reported',
    },
    {
      label: 'Ordered items',
      field: 'lines',
      value: (source) =>
        source.lines
          .map(
            (line) =>
              `${formatQuantity(line.quantity, line.unit)} × ${line.skuCode ?? line.title ?? 'item'}`,
          )
          .join(', ') || 'None',
    },
    {
      label: 'Fulfillment',
      value: (source) => fulfillmentLabel(source),
    },
    {
      label: 'Placed',
      value: (source) =>
        source.placedAt ? <WorkspaceDate value={source.placedAt} /> : '—',
    },
    {
      label: 'Due',
      value: (source) =>
        source.dueAt ? <WorkspaceDate value={source.dueAt} /> : '—',
    },
    {
      label: 'Source updated',
      value: (source) =>
        source.sourceUpdatedAt ? (
          <WorkspaceDate value={source.sourceUpdatedAt} />
        ) : (
          'Not reported'
        ),
    },
  ];

  return (
    <div className="orders-table-wrap">
      <table className="order-comparison">
        <caption className="sr-only">Facts reported by each source</caption>
        <thead>
          <tr>
            <th scope="col">Field</th>
            {detail.sources.map((source) => (
              <th scope="col" key={source.connectionId}>
                {source.label}
                {source.deleted ? ' (removed)' : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.label}
              data-differs={
                row.field && differs.has(row.field) ? '' : undefined
              }
            >
              <th scope="row">
                {row.label}
                {row.field && differs.has(row.field) ? (
                  <Badge tone="warning">Differs</Badge>
                ) : null}
              </th>
              {detail.sources.map((source) => (
                <td key={source.connectionId}>{row.value(source)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActivityList({
  entries,
  organizationId,
}: {
  entries: OrderDetail['activity']['entries'];
  organizationId: string;
}) {
  return (
    <ol className="order-activity">
      {entries.map((entry) => (
        <li key={entry.id}>
          <StateDot
            state={activityState(entry.outcome as ActivityEvent['outcome'])}
          />
          <span className="orders-cell-stack">
            <strong>{activityLabel(entry.action)}</strong>
            <small>
              <WorkspaceDate value={entry.recordedAt} />
              {entry.summary ? ` · ${entry.summary}` : ''}
            </small>
          </span>
          {entry.exceptionId ? (
            <Link
              to="/app/$organizationId/exceptions/$exceptionId"
              params={{ organizationId, exceptionId: entry.exceptionId }}
              search={{ view: 'active' }}
            >
              Issue
            </Link>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export type OrderError = 'missing' | 'access' | 'unavailable';

/** Presents one order's state, source facts, evidence and linked work with its unavailable states. */
export function OrderDetailView({
  organizationId,
  search,
  detail,
  loading = false,
  offline = false,
  error,
  refresh,
  sourceContext,
}: {
  organizationId: string;
  search: OrdersSearch;
  detail?: OrderDetail | undefined;
  loading?: boolean;
  offline?: boolean;
  error?: OrderError | undefined;
  refresh: () => void;
  sourceContext?: (source: OrderSourceFacts) => ReactNode;
}) {
  const timeZone = useContext(WorkspaceTimezone);
  const [chosen, setChosen] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const returnPath = recordReturnPath(organizationId, search.from);
  const listSearch = {
    ...orderFilters(search),
    cursor: search.cursor,
    page: search.page,
  };
  const here = detail
    ? `/app/${encodeURIComponent(organizationId)}/orders/${detail.order.id}`
    : '';
  const shown =
    detail?.sources.find((source) => source.connectionId === chosen) ??
    detail?.sources.find((source) => source.selected) ??
    detail?.sources[0];
  const needsYou = detail?.issues.find((issue) => issue.needsYou);
  const contexts =
    detail && sourceContext
      ? detail.sources.flatMap((source) => {
          const content = sourceContext(source);

          return content ? [{ source, content }] : [];
        })
      : [];

  return (
    <main className="order-page">
      {returnPath ? (
        <a className="order-back" href={returnPath}>
          <ArrowLeft size={16} aria-hidden="true" /> Back to context
        </a>
      ) : (
        <Link
          className="order-back"
          to="/app/$organizationId/orders"
          params={{ organizationId }}
          search={listSearch}
        >
          <ArrowLeft size={16} aria-hidden="true" /> Back to orders
        </Link>
      )}
      {offline ? (
        <Alert role="status">
          You are offline. The order below may be out of date.
        </Alert>
      ) : null}
      {error === 'missing' ? (
        <Alert role="alert">
          This order is not in this workspace or is no longer reported by any
          source.
        </Alert>
      ) : error === 'access' ? (
        <Alert tone="danger" role="alert">
          You no longer have access to orders in this workspace.
        </Alert>
      ) : error ? (
        <Alert tone="danger" role="alert">
          The order could not be loaded.{' '}
          <Button variant="outline" onClick={refresh}>
            Retry
          </Button>
        </Alert>
      ) : null}
      {!detail ? (
        loading && !error ? (
          <p role="status" className="order-note">
            Loading order…
          </p>
        ) : null
      ) : (
        <>
          <header className="order-head">
            <p className="order-eyebrow">Order · {detail.order.id}</p>
            <h1>{orderLabel(detail.order)}</h1>
            <div className="order-pills">
              {detail.order.issueIds.length ? (
                <StatePill state="attention">Needs you</StatePill>
              ) : null}
              {detail.order.overdue ? (
                <Badge tone="danger">Overdue</Badge>
              ) : null}
              <Badge>
                {statusLabels[detail.order.status] ?? detail.order.status}
              </Badge>
              <Badge>
                {paymentLabels[detail.order.paymentStatus] ??
                  detail.order.paymentStatus}
              </Badge>
              <Badge tone="info">{fulfillmentLabel(detail.order)}</Badge>
              {detail.order.differs ? (
                <Badge tone="warning">Differs by source</Badge>
              ) : null}
            </div>
            <p className="order-meta">
              {detail.order.placedAt ? (
                <span>
                  Placed <WorkspaceDate value={detail.order.placedAt} />
                </span>
              ) : null}
              {detail.order.total ? (
                <span>Total {formatMoney(detail.order.total)}</span>
              ) : null}
              {detail.order.dueAt ? (
                <span>
                  Due <WorkspaceDate value={detail.order.dueAt} />
                </span>
              ) : null}
              <span>
                Read <WorkspaceDate value={detail.order.observedAt} />
              </span>
            </p>
          </header>
          <div className="order-layout">
            <div className="order-main">
              <Section
                title="Current state"
                description={`Based on ${shown?.label ?? 'the newest source'}, the source with the newest update. Other sources are compared below.`}
              >
                <ul className="order-summary">
                  {orderSummary(detail, (value) =>
                    workspaceDateValue(new Date(value), timeZone),
                  ).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </Section>
              <Section
                title="Lines"
                description="Fulfilled quantities count shipped, delivered or completed work reported by the same source."
              >
                {detail.sources.length > 1 ? (
                  <div
                    className="order-source-switch"
                    role="group"
                    aria-label="Source for lines"
                  >
                    {detail.sources.map((source) => (
                      <Button
                        key={source.connectionId}
                        variant="ghost"
                        size="sm"
                        aria-pressed={
                          shown?.connectionId === source.connectionId
                        }
                        onClick={() => setChosen(source.connectionId)}
                      >
                        {source.label}
                      </Button>
                    ))}
                  </div>
                ) : null}
                {shown ? (
                  <Lines
                    source={shown}
                    organizationId={organizationId}
                    from={here}
                  />
                ) : null}
              </Section>
              {detail.sources.length > 1 ? (
                <Section
                  title="Source comparison"
                  description="Each source keeps its own facts. Order numbers and dates are shown but not compared, because systems assign them independently."
                >
                  <Comparison detail={detail} />
                </Section>
              ) : null}
              <Section
                title="Fulfillments"
                description="Fulfillment work reported by each source. Mirrored work in different systems is not added together."
              >
                {detail.fulfillments.length ? (
                  <ul className="order-list">
                    {detail.fulfillments.map((item) => (
                      <li key={`${item.id}:${item.connectionId}`}>
                        <span className="orders-cell-stack">
                          <strong>
                            {shipmentLabels[item.status] ?? item.status}
                            {item.deleted ? ' · removed at source' : ''}
                          </strong>
                          <small>
                            {detail.sources.find(
                              (source) =>
                                source.connectionId === item.connectionId,
                            )?.label ?? 'Connected source'}
                            {' · '}
                            {item.lines
                              .map((line) =>
                                formatQuantity(line.quantity, line.unit),
                              )
                              .join(' + ')}{' '}
                            units
                            {item.failureCode
                              ? ` · Failure ${item.failureCode}`
                              : ''}
                          </small>
                          <small>
                            {item.lastProgressAt ? (
                              <>
                                Last progress{' '}
                                <WorkspaceDate value={item.lastProgressAt} />
                              </>
                            ) : (
                              'No progress time reported'
                            )}
                            {item.externalId
                              ? ` · Source ID ${item.externalId}`
                              : ''}
                          </small>
                        </span>
                        <Link
                          to="/app/$organizationId/records/$kind/$recordId"
                          params={{
                            organizationId,
                            kind: 'fulfillment',
                            recordId: item.id,
                          }}
                          search={{ from: here }}
                        >
                          Record <ArrowRight size={13} aria-hidden="true" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="order-note">
                    No source has reported fulfillment work for this order.
                  </p>
                )}
              </Section>
              {contexts.map(({ source, content }) => (
                <Section
                  key={source.connectionId}
                  title={`${source.label} details`}
                  description="Payments, customer, fulfillment holds, returns, refunds and source events, read live with this connection's permissions. Luma does not store these details."
                >
                  {content}
                </Section>
              ))}
              <Section
                title="Observed history"
                description="Each entry is a state Luma read from a source, newest first. It shows what the source reported at that time, not every change the source made."
              >
                <ol className="order-history">
                  {detail.history.entries.map((entry) => (
                    <li key={entry.snapshotId}>
                      <span className="orders-cell-stack">
                        <strong>
                          {entry.entityKind === 'order'
                            ? `Order ${(statusLabels[entry.status] ?? entry.status).toLowerCase()}${entry.paymentStatus ? ` · ${(paymentLabels[entry.paymentStatus] ?? entry.paymentStatus).toLowerCase()}` : ''}`
                            : `Fulfillment ${(shipmentLabels[entry.status] ?? entry.status).toLowerCase()}`}
                          {entry.deleted ? ' · removed' : ''}
                        </strong>
                        <small>
                          {detail.sources.find(
                            (source) =>
                              source.connectionId === entry.connectionId,
                          )?.label ?? 'Connected source'}
                          {' · Source time '}
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
                  <p className="order-note">Showing the latest 100 entries.</p>
                ) : null}
              </Section>
              <Section
                title="Luma activity"
                description="Decisions, actions and results Luma recorded for this order, its issues and workflow runs."
              >
                {detail.activity.entries.length ? (
                  <ActivityList
                    entries={detail.activity.entries}
                    organizationId={organizationId}
                  />
                ) : (
                  <p className="order-note">
                    No Luma activity is recorded for this order in the last
                    year.
                  </p>
                )}
                {detail.activity.truncated ? (
                  <p className="order-note">Showing the latest 25 events.</p>
                ) : null}
              </Section>
            </div>
            <aside className="order-inspector" aria-label="Order details">
              <Card as="section" aria-label="Actions">
                <CardContent className="order-actions">
                  {needsYou ? (
                    <Link
                      className="order-primary-action"
                      to="/app/$organizationId/exceptions/$exceptionId"
                      params={{ organizationId, exceptionId: needsYou.id }}
                      search={{ view: 'needs_you' }}
                    >
                      Review issue <ArrowRight size={14} aria-hidden="true" />
                    </Link>
                  ) : null}
                  <Link
                    to="/app/$organizationId/records/$kind/$recordId"
                    params={{
                      organizationId,
                      kind: 'order',
                      recordId: detail.order.id,
                    }}
                    search={{ from: here }}
                  >
                    Open in Records <ArrowRight size={14} aria-hidden="true" />
                  </Link>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void navigator.clipboard
                        ?.writeText(new URL(here, window.location.origin).href)
                        .then(() => setCopied(true));
                    }}
                  >
                    <Copy aria-hidden="true" /> Copy link
                  </Button>
                  <span role="status" className="order-note">
                    {copied ? 'Link copied.' : ''}
                  </span>
                </CardContent>
              </Card>
              <Card as="section" aria-label="Issues">
                <CardHeader>
                  <CardTitle as="h2">Issues</CardTitle>
                </CardHeader>
                <CardContent>
                  {detail.issues.length ? (
                    <ul className="order-list">
                      {detail.issues.map((issue) => (
                        <li key={issue.id}>
                          <span className="orders-cell-stack">
                            <strong>{issueKind(issue).label}</strong>
                            <small>
                              {issue.state === 'resolved'
                                ? 'Resolved'
                                : issue.state.replaceAll('_', ' ')}
                              {' · '}
                              {issue.relationship === 'sku'
                                ? 'Affects an ordered item'
                                : issue.relationship === 'fulfillment'
                                  ? 'On a fulfillment'
                                  : 'On this order'}
                            </small>
                          </span>
                          {issue.needsYou ? (
                            <StatePill state="attention">Needs you</StatePill>
                          ) : null}
                          <Link
                            to="/app/$organizationId/exceptions/$exceptionId"
                            params={{ organizationId, exceptionId: issue.id }}
                            search={{
                              view:
                                issue.state === 'resolved'
                                  ? 'history'
                                  : issue.needsYou
                                    ? 'needs_you'
                                    : 'active',
                            }}
                            aria-label={`Open ${issueKind(issue).label} issue`}
                          >
                            Open
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="order-note">No linked issues.</p>
                  )}
                </CardContent>
              </Card>
              <Card as="section" aria-label="Workflow runs">
                <CardHeader>
                  <CardTitle as="h2">Workflow runs</CardTitle>
                </CardHeader>
                <CardContent>
                  {detail.workflows.length ? (
                    <ul className="order-list">
                      {detail.workflows.map((run) => (
                        <li key={run.id}>
                          <span className="orders-cell-stack">
                            <strong>{run.name ?? run.definitionId}</strong>
                            <small>
                              {run.state.replaceAll('_', ' ')} · version{' '}
                              {run.version}
                              {run.createdAt ? (
                                <>
                                  {' · '}
                                  <WorkspaceDate value={run.createdAt} />
                                </>
                              ) : null}
                            </small>
                          </span>
                          <Link
                            to="/app/$organizationId/workflows/$definitionId"
                            params={{
                              organizationId,
                              definitionId: run.definitionId,
                            }}
                            aria-label={`Open workflow ${run.name ?? run.definitionId}`}
                          >
                            Open
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="order-note">
                      No workflow has run for this order or its issues.
                    </p>
                  )}
                </CardContent>
              </Card>
              <Card as="section" aria-label="Sources">
                <CardHeader>
                  <CardTitle as="h2">Sources</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="order-list">
                    {detail.sources.map((source) => (
                      <li key={source.connectionId}>
                        <span className="orders-cell-stack">
                          <strong>
                            {source.label}
                            {source.selected ? ' · shown' : ''}
                          </strong>
                          <small>
                            Source ID {source.externalId ?? 'not mapped'}
                          </small>
                          <small>
                            {source.mappingMethod
                              ? `Linked by ${source.mappingMethod.replaceAll('-', ' ')}`
                              : 'Link method not recorded'}
                          </small>
                          <small>
                            Updated{' '}
                            {source.sourceUpdatedAt ? (
                              <WorkspaceDate value={source.sourceUpdatedAt} />
                            ) : (
                              'time not reported'
                            )}{' '}
                            · Read <WorkspaceDate value={source.observedAt} />
                          </small>
                        </span>
                        <Badge
                          tone={
                            source.deleted ||
                            source.connectionStatus !== 'active'
                              ? 'warning'
                              : 'neutral'
                          }
                        >
                          {source.deleted
                            ? 'Removed at source'
                            : source.connectionStatus}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
              <Disclosure>
                <summary>Luma identity</summary>
                <p className="order-note">
                  Luma ID <code>{detail.order.id}</code>. Sources are linked
                  only through confirmed source IDs, never by matching numbers
                  or SKU text.
                </p>
              </Disclosure>
            </aside>
          </div>
        </>
      )}
    </main>
  );
}
