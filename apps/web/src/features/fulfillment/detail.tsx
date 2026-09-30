import './fulfillment.css';

import type { ActivityEvent, FulfillmentDetail } from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import { DomainIcon } from '@luma/ui/components/primitives/domain-icon';
import { Empty } from '@luma/ui/components/primitives/empty';
import { StateDot, StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
import { onlineManager, useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { ArrowLeft, ExternalLink, PackageX, RefreshCw } from 'lucide-react';
import { type ReactNode, useSyncExternalStore } from 'react';

import { activityLabel, activityState } from '../activity/presentation';
import { appsOptions } from '../apps/data';
import { AppExtension } from '../apps/extension';
import { SignInRedirect } from '../identity/common';
import { IdentityError } from '../identity/data';
import {
  fulfillmentLabels as orderFulfillmentLabels,
  paymentLabels,
  statusLabels as orderStatusLabels,
} from '../orders/presentation';
import { recordReturnPath } from '../records/data';
import { ago } from '../sync/presentation';
import {
  fulfillmentFilters,
  fulfillmentOptions,
  type FulfillmentSearch,
} from './data';
import {
  deliveryLabels,
  diagnosis,
  fulfillmentState,
  holdText,
  kindLabels,
  lastChange,
  methodLabels,
  nextStep,
  orderLabel,
  otherSignals,
  signalLabels,
  statusLabels,
  timelineGroups,
} from './presentation';

const subscribe = (changed: () => void) => onlineManager.subscribe(changed);
const onlineSnapshot = () => onlineManager.isOnline();
const serverSnapshot = () => true;

export type FulfillmentError = 'missing' | 'access' | 'unavailable';

/** Loads one fulfillment and mounts source actions from an installed app that supports them. */
export function FulfillmentDetailPage() {
  const { organizationId, fulfillmentId } = useParams({
    from: '/app/$organizationId/fulfillment/$fulfillmentId',
  });
  const search = useSearch({
    from: '/app/$organizationId/fulfillment/$fulfillmentId',
  });
  const query = useQuery(fulfillmentOptions(organizationId, fulfillmentId));
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
  const appId = detail?.source.appId;
  const actionable =
    !!detail &&
    !!appId &&
    detail.item.kind === 'fulfillment_order' &&
    detail.item.open &&
    !!detail.item.externalId &&
    !!detail.order.externalId &&
    (apps.data?.catalog ?? []).some(
      (app) =>
        app.id === appId &&
        app.ui.includes('fulfillment') &&
        apps.data?.installations.some(
          (item) => item.appId === app.id && item.status === 'installed',
        ),
    );

  return (
    <FulfillmentDetailView
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
      actions={
        actionable && appId ? (
          <AppExtension
            appId={appId}
            organizationId={organizationId}
            slot="fulfillment"
            fulfillment={{
              connectionId: detail.item.connectionId,
              orderId: detail.order.externalId!,
              fulfillmentId: detail.item.externalId!,
            }}
            done={async () => void (await query.refetch())}
          />
        ) : null
      }
    />
  );
}

/** A labelled fact; unknown values say so rather than disappearing. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fulfillment-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Missing({ children = 'Not reported' }: { children?: ReactNode }) {
  return <span className="fulfillment-muted">{children}</span>;
}

/** The facts a source reports about the fulfillment, including what it does not report. */
function Facts({ detail }: { detail: FulfillmentDetail }) {
  const { item, source } = detail;

  return (
    <Card className="fulfillment-section">
      <h2>Source facts</h2>
      <dl className="fulfillment-facts">
        <Fact label="Type">{kindLabels[item.kind]}</Fact>
        <Fact label="Status">{statusLabels[item.status] ?? item.status}</Fact>
        <Fact label="Holds">
          {item.holds === null ? (
            <Missing>Not reported by this source</Missing>
          ) : item.holds.length ? (
            holdText(item.holds)
          ) : (
            'None'
          )}
        </Fact>
        <Fact label="Location">
          {item.location?.name ?? <Missing />}
          {item.location && !item.location.id ? (
            <small>Not linked to a Luma location</small>
          ) : null}
        </Fact>
        <Fact label="Delivery method">
          {item.method ? (
            (item.method.name ?? methodLabels[item.method.type] ?? 'Delivery')
          ) : (
            <Missing />
          )}
        </Fact>
        {item.kind !== 'shipment' ? (
          <>
            <Fact label="Fulfill by">
              {item.fulfillBy ? (
                <WorkspaceDate value={item.fulfillBy} />
              ) : (
                <Missing>No deadline reported</Missing>
              )}
            </Fact>
            {item.fulfillAt ? (
              <Fact label="Scheduled for">
                <WorkspaceDate value={item.fulfillAt} />
              </Fact>
            ) : null}
          </>
        ) : (
          <>
            <Fact label="Carrier status">
              {item.delivery ? (
                (deliveryLabels[item.delivery] ?? item.delivery)
              ) : (
                <Missing />
              )}
            </Fact>
            <Fact label="Estimated delivery">
              {item.estimatedDeliveryAt ? (
                <WorkspaceDate value={item.estimatedDeliveryAt} />
              ) : (
                <Missing />
              )}
            </Fact>
            <Fact label="Tracking">
              {item.tracking.length ? (
                <ul className="fulfillment-tracking">
                  {item.tracking.map((entry, index) => (
                    <li key={`${entry.number ?? ''}:${index}`}>
                      {entry.url ? (
                        <a href={entry.url} target="_blank" rel="noreferrer">
                          {[entry.carrier, entry.number]
                            .filter(Boolean)
                            .join(' ') || 'Tracking page'}
                          <ExternalLink size={12} aria-hidden="true" />
                          <span className="sr-only"> (opens in a new tab)</span>
                        </a>
                      ) : (
                        [entry.carrier, entry.number].filter(Boolean).join(' ')
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <Missing>No tracking reported</Missing>
              )}
            </Fact>
          </>
        )}
        <Fact label="Source">
          {source.label}
          {item.externalId ? <small>{item.externalId}</small> : null}
        </Fact>
        <Fact label="Read">
          <WorkspaceDate value={item.observedAt} />
          <small>
            Source updated{' '}
            {item.sourceUpdatedAt ? (
              <WorkspaceDate value={item.sourceUpdatedAt} />
            ) : (
              'time not reported'
            )}
          </small>
        </Fact>
      </dl>
    </Card>
  );
}

/**
 * What Luma observed about progress, kept apart from accepted requests and method corrections.
 */
function ProgressEvidence({
  detail,
  organizationId,
}: {
  detail: FulfillmentDetail;
  organizationId: string;
}) {
  const { item } = detail;
  const change = lastChange(detail);
  const now = Date.parse(detail.asOf);

  return (
    <Card className="fulfillment-section">
      <h2>Progress evidence</h2>
      <p className="fulfillment-note">
        Luma counts progress only from what a source reports in a fresh read. A
        request the source accepted, or a corrected shipping method, is not
        progress until a later read shows work completed or shipped.
      </p>
      <dl className="fulfillment-facts fulfillment-facts-inline">
        <Fact label="Last progress reported">
          {item.lastProgressAt ? (
            <>
              <WorkspaceDate value={item.lastProgressAt} />
              <small>{ago(item.lastProgressAt, now)}</small>
            </>
          ) : (
            <Missing>The source does not report progress times</Missing>
          )}
        </Fact>
        <Fact label="Last change Luma saw">
          {change ? (
            <>
              {change.changes.join(' · ')}
              <small>
                <WorkspaceDate value={change.at} />
              </small>
            </>
          ) : (
            <Missing>No change observed yet</Missing>
          )}
        </Fact>
        <Fact label="Luma last read">
          <WorkspaceDate value={item.observedAt} />
          <small>{ago(item.observedAt, now)}</small>
        </Fact>
      </dl>
      {detail.workflows.length ? (
        <>
          <h3>Workflow runs for this order</h3>
          <ul className="fulfillment-related">
            {detail.workflows.map((run) => (
              <li key={run.id}>
                <span className="fulfillment-cell">
                  <Link
                    to="/app/$organizationId/workflows/$definitionId"
                    params={{ organizationId, definitionId: run.definitionId }}
                  >
                    {run.name ?? run.definitionId}
                  </Link>
                  <small>
                    {run.state.replaceAll('_', ' ')}
                    {run.createdAt ? (
                      <>
                        {' · started '}
                        <WorkspaceDate value={run.createdAt} />
                      </>
                    ) : null}
                  </small>
                  {run.purpose === 'method_correction' ? (
                    <small>
                      Changes the shipping method. It does not ship the order.
                    </small>
                  ) : null}
                </span>
                {run.progressObservedAt ? (
                  <StatePill state="verified">
                    Progress seen{' '}
                    <WorkspaceDate value={run.progressObservedAt} />
                  </StatePill>
                ) : (
                  <StatePill state="waiting">No progress seen since</StatePill>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Card>
  );
}

/** Lists each observed source state with what changed, collapsing reads without a change. */
function Timeline({ detail }: { detail: FulfillmentDetail }) {
  const groups = timelineGroups(
    detail.timeline.entries,
    detail.timeline.truncated,
  );

  return (
    <section
      className="fulfillment-section"
      aria-labelledby="fulfillment-timeline"
    >
      <h2 id="fulfillment-timeline">Source timeline</h2>
      <p className="fulfillment-note">
        States Luma read from {detail.source.label}, newest first, with what
        changed since the read before.
      </p>
      <ol className="fulfillment-timeline">
        {groups.map(({ entry, changes, repeats }) => {
          const oldest = repeats.at(-1) ?? entry;

          return (
            <li key={entry.snapshotId} data-changed={changes.length > 0}>
              <StateDot
                state={
                  entry.deleted
                    ? 'idle'
                    : entry.holds?.length
                      ? 'attention'
                      : ['completed', 'shipped', 'delivered'].includes(
                            entry.status,
                          )
                        ? 'verified'
                        : 'waiting'
                }
              />
              <span className="fulfillment-cell">
                <strong>
                  {changes.length
                    ? changes.join(' · ')
                    : repeats.length > 1
                      ? `Read ${repeats.length} times, no change`
                      : 'Read again, no change'}
                </strong>
                <small>
                  {entry.current ? 'Current · ' : ''}
                  Source time{' '}
                  {entry.sourceUpdatedAt ? (
                    <WorkspaceDate value={entry.sourceUpdatedAt} />
                  ) : (
                    'not reported'
                  )}
                  {' · Read '}
                  {repeats.length > 1 ? (
                    <>
                      <WorkspaceDate value={oldest.observedAt} />
                      {' to '}
                    </>
                  ) : null}
                  <WorkspaceDate value={entry.observedAt} />
                </small>
              </span>
            </li>
          );
        })}
      </ol>
      {detail.timeline.truncated ? (
        <p className="fulfillment-note">Showing the 50 most recent reads.</p>
      ) : null}
    </section>
  );
}

/** Shows one fulfillment's diagnosis, next safe step, evidence and linked records. */
export function FulfillmentDetailView({
  organizationId,
  search = {},
  detail,
  loading = false,
  refreshing = false,
  offline = false,
  error,
  refresh,
  actions,
}: {
  organizationId: string;
  search?: FulfillmentSearch;
  detail?: FulfillmentDetail | undefined;
  loading?: boolean;
  refreshing?: boolean;
  offline?: boolean;
  error?: FulfillmentError | undefined;
  refresh: () => void;
  /** Source actions for this fulfillment from an installed app. */
  actions?: ReactNode;
}) {
  const from = recordReturnPath(organizationId, search.from);
  const item = detail?.item;
  const state = item ? fulfillmentState(item) : null;
  const step = detail ? nextStep(detail, !!actions) : null;
  const summary = detail ? diagnosis(detail.item, detail.asOf) : null;
  const here = detail
    ? `/app/${encodeURIComponent(organizationId)}/fulfillment/${detail.item.id}`
    : '';
  const carrier = item?.tracking.find((entry) => entry.url);

  return (
    <main className="fulfillment-page">
      {from ? (
        <Link className="fulfillment-back" to={from}>
          <ArrowLeft size={14} aria-hidden="true" />
          Back to context
        </Link>
      ) : (
        <Link
          className="fulfillment-back"
          to="/app/$organizationId/fulfillment"
          params={{ organizationId }}
          search={fulfillmentFilters(search)}
        >
          <ArrowLeft size={14} aria-hidden="true" />
          Back to fulfillment
        </Link>
      )}
      <PageHeader
        title={item ? orderLabel(item) : 'Fulfillment'}
        icon={<DomainIcon domain="fulfillment" size="md" />}
        description={
          detail && item
            ? `${kindLabels[item.kind]} from ${detail.source.label}${item.units !== '0' ? ` · ${item.units} ${item.unit ?? 'units'}` : ''}`
            : 'Where this fulfillment stands, what blocks it and the next safe step.'
        }
      />
      <div className="fulfillment-detail-toolbar">
        <span className="fulfillment-flags">
          {state ? (
            <StatePill state={state.state}>{state.label}</StatePill>
          ) : null}
          {item
            ? otherSignals(item).map((signal) => (
                <Badge key={signal} tone="warning">
                  {signalLabels[signal]}
                </Badge>
              ))
            : null}
        </span>
        <Button variant="outline" disabled={refreshing} onClick={refresh}>
          <RefreshCw size={14} aria-hidden="true" />
          Refresh
        </Button>
      </div>
      {offline ? (
        <Alert role="status">
          You are offline. Reconnect to refresh this fulfillment.
        </Alert>
      ) : null}
      {error === 'missing' ? (
        <Empty>
          <PackageX size={30} aria-hidden="true" />
          <h2>Fulfillment not found</h2>
          <p>
            This fulfillment is not in this workspace, or no source reports it
            anymore.
          </p>
          <Link
            to="/app/$organizationId/fulfillment"
            params={{ organizationId }}
          >
            Browse fulfillment
          </Link>
        </Empty>
      ) : error === 'access' ? (
        <Alert tone="danger" role="alert">
          You no longer have access to fulfillment in this workspace.
        </Alert>
      ) : error ? (
        <Alert tone="danger" role="alert">
          {detail
            ? 'This fulfillment could not be refreshed. The details below may be out of date.'
            : 'This fulfillment could not be loaded.'}{' '}
          <Button variant="outline" onClick={refresh}>
            Retry
          </Button>
        </Alert>
      ) : null}
      {!detail && loading && !error ? (
        <div className="fulfillment-loading" role="status">
          <span className="sr-only">Loading fulfillment…</span>
          {Array.from({ length: 3 }, (_, i) => (
            <span className="lu-skeleton" key={i} />
          ))}
        </div>
      ) : null}
      {detail && item && state && step && summary && error !== 'missing' ? (
        <div className="fulfillment-layout">
          <div className="fulfillment-main">
            <section
              className="fulfillment-diagnosis"
              data-state={state.state}
              aria-labelledby="fulfillment-diagnosis"
            >
              <h2 id="fulfillment-diagnosis">{summary.title}</h2>
              <p>{summary.body}</p>
            </section>
            <Card className="fulfillment-section fulfillment-step">
              <p className="fulfillment-eyebrow">Next safe step</p>
              <h2>{step.title}</h2>
              <p className="fulfillment-note">{step.body}</p>
              {step.action === 'carrier' && carrier?.url ? (
                <a
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  href={carrier.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open carrier tracking
                  <ExternalLink size={14} aria-hidden="true" />
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              ) : null}
              {actions ? (
                <div className="fulfillment-actions">{actions}</div>
              ) : null}
            </Card>
            <ProgressEvidence detail={detail} organizationId={organizationId} />
            <section
              className="fulfillment-section"
              aria-labelledby="fulfillment-items"
            >
              <h2 id="fulfillment-items">Items</h2>
              <DataTable
                caption="Items in this fulfillment"
                density="compact"
                rows={detail.lines}
                rowKey={(line) => line.orderLineId}
                columns={[
                  {
                    key: 'item',
                    header: 'Item',
                    cell: (line) => (
                      <span className="fulfillment-cell">
                        {line.skuId ? (
                          <Link
                            to="/app/$organizationId/products/$skuId"
                            params={{ organizationId, skuId: line.skuId }}
                            search={{ from: here }}
                          >
                            {line.skuCode ?? line.title ?? 'Mapped SKU'}
                          </Link>
                        ) : (
                          <span>
                            {line.skuCode ?? line.title ?? 'Unmapped item'}
                          </span>
                        )}
                        {line.skuCode && line.title ? (
                          <small>{line.title}</small>
                        ) : null}
                      </span>
                    ),
                  },
                  {
                    key: 'quantity',
                    header: 'In this fulfillment',
                    numeric: true,
                    cell: (line) => `${line.quantity} ${line.unit}`,
                  },
                  {
                    key: 'ordered',
                    header: 'Ordered',
                    numeric: true,
                    hideOnNarrow: true,
                    cell: (line) =>
                      line.ordered ? `${line.ordered} ${line.unit}` : '—',
                  },
                ]}
                empty={<p className="fulfillment-note">No lines reported.</p>}
              />
            </section>
            <Timeline detail={detail} />
            <section
              className="fulfillment-section"
              aria-labelledby="fulfillment-activity"
            >
              <h2 id="fulfillment-activity">Luma activity</h2>
              {detail.activity.entries.length ? (
                <ol className="fulfillment-related">
                  {detail.activity.entries.map((entry) => (
                    <li key={entry.id}>
                      <StateDot
                        state={activityState(
                          entry.outcome as ActivityEvent['outcome'],
                        )}
                      />
                      <span className="fulfillment-cell">
                        <span>{activityLabel(entry.action)}</span>
                        <small>
                          <WorkspaceDate value={entry.recordedAt} />
                          {entry.summary ? ` · ${entry.summary}` : ''}
                        </small>
                      </span>
                      {entry.exceptionId ? (
                        <Link
                          to="/app/$organizationId/exceptions/$exceptionId"
                          params={{
                            organizationId,
                            exceptionId: entry.exceptionId,
                          }}
                          search={{ view: 'active' }}
                        >
                          Issue
                        </Link>
                      ) : null}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="fulfillment-note">
                  Luma has not acted on this order or its issues yet.
                </p>
              )}
            </section>
          </div>
          <aside className="fulfillment-aside" aria-label="Related records">
            <Facts detail={detail} />
            <Card className="fulfillment-section">
              <h2>Order</h2>
              <Link
                to="/app/$organizationId/orders/$orderId"
                params={{ organizationId, orderId: detail.order.id }}
                search={{ from: here }}
              >
                {detail.order.number ?? orderLabel(item)}
              </Link>
              <dl className="fulfillment-facts">
                <Fact label="Status">
                  {detail.order.status ? (
                    (orderStatusLabels[detail.order.status] ??
                    detail.order.status)
                  ) : (
                    <Missing>Order not read from this source</Missing>
                  )}
                </Fact>
                <Fact label="Payment">
                  {detail.order.paymentStatus ? (
                    (paymentLabels[detail.order.paymentStatus] ??
                    detail.order.paymentStatus)
                  ) : (
                    <Missing />
                  )}
                </Fact>
                <Fact label="Fulfillment">
                  {detail.order.fulfillment ? (
                    (orderFulfillmentLabels[detail.order.fulfillment] ??
                    detail.order.fulfillment)
                  ) : (
                    <Missing />
                  )}
                </Fact>
                {detail.order.placedAt ? (
                  <Fact label="Placed">
                    <WorkspaceDate value={detail.order.placedAt} />
                  </Fact>
                ) : null}
              </dl>
              <p className="fulfillment-note">
                Customer, payment and address details are on the order, read
                live from {detail.source.label}.
              </p>
            </Card>
            <Card className="fulfillment-section">
              <h2>Other fulfillments of this order</h2>
              {detail.related.length ? (
                <ul className="fulfillment-related">
                  {detail.related.map((other) => {
                    const otherState = fulfillmentState(other);

                    return (
                      <li key={`${other.id}:${other.connectionId}`}>
                        <span className="fulfillment-cell">
                          <Link
                            to="/app/$organizationId/fulfillment/$fulfillmentId"
                            params={{
                              organizationId,
                              fulfillmentId: other.id,
                            }}
                            search={search}
                          >
                            {kindLabels[other.kind]}
                          </Link>
                          <small>
                            {other.connectionId === item.connectionId
                              ? detail.source.label
                              : 'Another source'}
                            {' · '}
                            {other.units} {other.unit ?? 'units'}
                          </small>
                        </span>
                        <StatePill state={otherState.state}>
                          {otherState.label}
                        </StatePill>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="fulfillment-note">
                  No other fulfillment work or shipments are reported for this
                  order.
                </p>
              )}
            </Card>
            <Card className="fulfillment-section">
              <h2>Issues</h2>
              {detail.issues.length ? (
                <ul className="fulfillment-related">
                  {detail.issues.map((issue) => (
                    <li key={issue.id}>
                      <span className="fulfillment-cell">
                        <Link
                          to="/app/$organizationId/exceptions/$exceptionId"
                          params={{ organizationId, exceptionId: issue.id }}
                          search={{ view: 'needs_you' }}
                        >
                          {issue.class.replaceAll('_', ' ')}
                        </Link>
                        <small>
                          {issue.relationship === 'fulfillment'
                            ? 'On this fulfillment'
                            : 'On the order'}
                          {issue.lastDetectedAt
                            ? ` · detected ${ago(issue.lastDetectedAt, Date.parse(detail.asOf))}`
                            : ''}
                        </small>
                      </span>
                      {issue.needsYou ? (
                        <StatePill state="approval">Needs you</StatePill>
                      ) : (
                        <Badge>{issue.state}</Badge>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="fulfillment-note">
                  No recorded issues for this fulfillment or its order.
                </p>
              )}
            </Card>
          </aside>
        </div>
      ) : null}
    </main>
  );
}
