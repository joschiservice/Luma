import './fulfillment.css';

import type { ActivityEvent, FulfillmentDetail } from '@luma/api-contract';
import { formatRelativeTime } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import { Empty } from '@luma/ui/components/primitives/empty';
import { RefreshButton } from '@luma/ui/components/primitives/refresh-button';
import { StateDot, StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { RecordHeader } from '@luma/ui/components/workspace/record-header';
import { actorLabel } from '@luma/ui/lib/actor';
import { onlineManager, useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { ExternalLink, PackageX } from 'lucide-react';
import { type ReactNode, useSyncExternalStore } from 'react';

import { appsOptions } from '../../kit/apps/data';
import { SignInRedirect } from '../../kit/identity/common';
import { IdentityError } from '../../kit/identity/data';
import { RecordAssistance } from '../../kit/record-assistance';
import {
  fulfillmentLabels as orderFulfillmentLabels,
  paymentLabels,
  statusLabels as orderStatusLabels,
} from '../../shared/orders/presentation';
import { activityLabel, activityState } from '../activity/presentation';
import { AppExtension } from '../apps/extension';
import { recordReturnPath } from '../records/data';
import {
  fulfillmentFilters,
  fulfillmentOptions,
  type FulfillmentSearch,
} from './data';
import {
  deliveryLabels,
  diagnosis,
  fulfillmentState,
  handoffLabels,
  holdText,
  kindLabels,
  lastChange,
  methodLabels,
  nextStep,
  orderLabel,
  otherSignals,
  quantity,
  shippingFreshness,
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
    ((detail.item.kind === 'fulfillment_order' && detail.item.open) ||
      (appId === 'shopify' &&
        detail.item.kind === 'shipment' &&
        !detail.item.deleted)) &&
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
      contextualAssistance
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

function Missing({ children }: { children?: ReactNode }) {
  return (
    <span className="fulfillment-muted">
      {children ?? m.common_not_reported()}
    </span>
  );
}

/** Screen-reader note for links that open outside Luma. */
function NewTab() {
  return <span className="sr-only"> {m.fulfillment_opens_new_tab()}</span>;
}

/** The facts a source reports about the fulfillment, including what it does not report. */
function Facts({ detail }: { detail: FulfillmentDetail }) {
  const { item, source } = detail;
  const freshness = shippingFreshness(item, detail.asOf);

  return (
    <Card className="fulfillment-section">
      <h2>{m.fulfillment_facts_title()}</h2>
      {freshness.staleRead ? (
        <Alert role="status">{m.fulfillment_read_stale()}</Alert>
      ) : null}
      {freshness.quietTracking ? (
        <Alert role="status">{m.fulfillment_tracking_stale()}</Alert>
      ) : null}
      <dl className="fulfillment-facts">
        <Fact label={m.fulfillment_fact_type()}>{kindLabels[item.kind]}</Fact>
        <Fact label={m.fulfillment_fact_status()}>
          {statusLabels[item.status] ?? item.status}
        </Fact>
        {item.shipping ? (
          <>
            <Fact label={m.fulfillment_fact_handoff()}>
              {handoffLabels[item.shipping.stage]}
              {item.shipping.stage === 'unknown' ? (
                <small>{m.fulfillment_handoff_unknown_note()}</small>
              ) : null}
            </Fact>
            <Fact label={m.fulfillment_fact_tracking_update()}>
              {item.shipping.trackingUpdatedAt ? (
                <WorkspaceDate value={item.shipping.trackingUpdatedAt} />
              ) : (
                <Missing />
              )}
            </Fact>
          </>
        ) : null}
        <Fact label={m.fulfillment_fact_holds()}>
          {item.holds === null ? (
            <Missing>{m.fulfillment_fact_holds_unreported()}</Missing>
          ) : item.holds.length ? (
            holdText(item.holds)
          ) : (
            m.common_none()
          )}
        </Fact>
        <Fact label={m.fulfillment_fact_location()}>
          {item.location?.name ?? <Missing />}
          {item.location && !item.location.id ? (
            <small>{m.fulfillment_fact_location_unlinked()}</small>
          ) : null}
        </Fact>
        <Fact label={m.fulfillment_fact_method()}>
          {item.method ? (
            (item.method.name ??
            methodLabels[item.method.type] ??
            m.fulfillment_method_unknown())
          ) : (
            <Missing />
          )}
        </Fact>
        {item.kind !== 'shipment' ? (
          <>
            <Fact label={m.fulfillment_fact_fulfill_by()}>
              {item.fulfillBy ? (
                <WorkspaceDate value={item.fulfillBy} />
              ) : (
                <Missing>{m.fulfillment_fact_no_deadline()}</Missing>
              )}
            </Fact>
            {item.fulfillAt ? (
              <Fact label={m.fulfillment_fact_scheduled()}>
                <WorkspaceDate value={item.fulfillAt} />
              </Fact>
            ) : null}
          </>
        ) : (
          <>
            <Fact label={m.fulfillment_fact_carrier_status()}>
              {item.delivery ? (
                (deliveryLabels[item.delivery] ?? item.delivery)
              ) : (
                <Missing />
              )}
            </Fact>
            <Fact label={m.fulfillment_fact_estimated_delivery()}>
              {item.estimatedDeliveryAt ? (
                <WorkspaceDate value={item.estimatedDeliveryAt} />
              ) : (
                <Missing />
              )}
            </Fact>
            <Fact label={m.fulfillment_fact_tracking()}>
              {item.tracking.length ? (
                <ul className="fulfillment-tracking">
                  {item.tracking.map((entry, index) => (
                    <li key={`${entry.number ?? ''}:${index}`}>
                      {entry.url ? (
                        <a href={entry.url} target="_blank" rel="noreferrer">
                          {[entry.carrier, entry.number]
                            .filter(Boolean)
                            .join(' ') || m.fulfillment_fact_tracking_page()}
                          <ExternalLink size={12} aria-hidden="true" />
                          <NewTab />
                        </a>
                      ) : (
                        [entry.carrier, entry.number].filter(Boolean).join(' ')
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <Missing>{m.fulfillment_fact_no_tracking()}</Missing>
              )}
            </Fact>
          </>
        )}
        <Fact label={m.fulfillment_fact_source()}>
          {source.label}
          {item.externalId ? <small>{item.externalId}</small> : null}
          {item.shipping?.sourceUrl ? (
            <a
              className="fulfillment-source-link"
              href={item.shipping.sourceUrl}
              target="_blank"
              rel="noreferrer"
            >
              {m.fulfillment_source_open()}{' '}
              <ExternalLink size={12} aria-hidden="true" />
              <NewTab />
            </a>
          ) : null}
        </Fact>
        <Fact label={m.fulfillment_fact_read()}>
          <WorkspaceDate value={item.observedAt} />
          <small>
            {item.sourceUpdatedAt
              ? rich(m.fulfillment_fact_source_updated, {
                  date: <WorkspaceDate value={item.sourceUpdatedAt} />,
                })
              : m.fulfillment_fact_source_updated_unreported()}
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
      <h2>{m.fulfillment_evidence_title()}</h2>
      <p className="fulfillment-note">{m.fulfillment_evidence_note()}</p>
      <dl className="fulfillment-facts fulfillment-facts-inline">
        <Fact label={m.fulfillment_evidence_last_progress()}>
          {item.lastProgressAt ? (
            <>
              <WorkspaceDate value={item.lastProgressAt} />
              <small>{formatRelativeTime(item.lastProgressAt, now)}</small>
            </>
          ) : (
            <Missing>{m.fulfillment_evidence_no_progress_times()}</Missing>
          )}
        </Fact>
        <Fact label={m.fulfillment_evidence_last_change()}>
          {change ? (
            <>
              {change.changes.join(' · ')}
              <small>
                <WorkspaceDate value={change.at} />
              </small>
            </>
          ) : (
            <Missing>{m.fulfillment_evidence_no_change()}</Missing>
          )}
        </Fact>
        <Fact label={m.fulfillment_evidence_last_read()}>
          <WorkspaceDate value={item.observedAt} />
          <small>{formatRelativeTime(item.observedAt, now)}</small>
        </Fact>
      </dl>
      {detail.workflows.length ? (
        <>
          <h3>{m.fulfillment_workflows_title()}</h3>
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
                    {run.createdAt
                      ? rich(m.fulfillment_workflow_started, {
                          state: run.state.replaceAll('_', ' '),
                          date: <WorkspaceDate value={run.createdAt} />,
                        })
                      : run.state.replaceAll('_', ' ')}
                  </small>
                  {run.purpose === 'method_correction' ? (
                    <small>{m.fulfillment_workflow_method_note()}</small>
                  ) : null}
                </span>
                {run.progressObservedAt ? (
                  <StatePill state="verified">
                    {rich(m.fulfillment_workflow_progress_seen, {
                      date: <WorkspaceDate value={run.progressObservedAt} />,
                    })}
                  </StatePill>
                ) : (
                  <StatePill state="waiting">
                    {m.fulfillment_workflow_no_progress()}
                  </StatePill>
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
      <h2 id="fulfillment-timeline">{m.fulfillment_timeline_title()}</h2>
      <p className="fulfillment-note">
        {m.fulfillment_timeline_note({ source: detail.source.label })}
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
                      ? m.fulfillment_timeline_repeated({
                          count: repeats.length,
                        })
                      : m.fulfillment_timeline_read_again()}
                </strong>
                <small>
                  {entry.current
                    ? `${m.fulfillment_timeline_current()} · `
                    : ''}
                  {entry.sourceUpdatedAt
                    ? rich(m.fulfillment_timeline_source_time, {
                        date: <WorkspaceDate value={entry.sourceUpdatedAt} />,
                      })
                    : m.fulfillment_timeline_source_time_unreported()}
                  {' · '}
                  {repeats.length > 1
                    ? rich(m.fulfillment_timeline_read_range, {
                        from: <WorkspaceDate value={oldest.observedAt} />,
                        to: <WorkspaceDate value={entry.observedAt} />,
                      })
                    : rich(m.fulfillment_timeline_read, {
                        date: <WorkspaceDate value={entry.observedAt} />,
                      })}
                </small>
              </span>
            </li>
          );
        })}
      </ol>
      {detail.timeline.truncated ? (
        <p className="fulfillment-note">{m.fulfillment_timeline_truncated()}</p>
      ) : null}
    </section>
  );
}

/** Shows one fulfillment's diagnosis, next safe step, evidence and linked records. */
export function FulfillmentDetailView({
  contextualAssistance = false,
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
  /** The connected page supplies the authorized assistant control. */
  contextualAssistance?: boolean;
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
    <div className="fulfillment-page">
      <RecordHeader
        section={{
          label: m.fulfillment_page_title(),
          domain: 'fulfillment',
          link: (
            <Link
              to="/app/$organizationId/fulfillment"
              params={{ organizationId }}
              search={fulfillmentFilters(search)}
            />
          ),
        }}
        title={item ? orderLabel(item) : m.fulfillment_detail_title_fallback()}
        back={from ? <Link to={from} /> : undefined}
        actions={
          <>
            {item ? (
              contextualAssistance ? (
                <RecordAssistance
                  organizationId={organizationId}
                  context={{ record: { kind: 'fulfillment', id: item.id } }}
                  label={orderLabel(item)}
                />
              ) : null
            ) : null}
            <RefreshButton
              refreshing={refreshing}
              onClick={refresh}
              label={m.fulfillment_detail_refresh()}
            />
          </>
        }
        status={
          <>
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
          </>
        }
        description={
          detail && item
            ? item.units !== '0'
              ? m.fulfillment_detail_description_units({
                  kind: kindLabels[item.kind],
                  source: detail.source.label,
                  units: quantity(item.units, item.unit),
                })
              : m.fulfillment_detail_description({
                  kind: kindLabels[item.kind],
                  source: detail.source.label,
                })
            : null
        }
      />
      {offline ? (
        <Alert role="status">{m.fulfillment_detail_offline()}</Alert>
      ) : null}
      {error === 'missing' ? (
        <Empty>
          <PackageX size={30} aria-hidden="true" />
          <h2>{m.fulfillment_detail_missing_title()}</h2>
          <p>{m.fulfillment_detail_missing_body()}</p>
          <Link
            to="/app/$organizationId/fulfillment"
            params={{ organizationId }}
          >
            {m.fulfillment_detail_browse()}
          </Link>
        </Empty>
      ) : error === 'access' ? (
        <Alert tone="danger" role="alert">
          {m.fulfillment_detail_no_access()}
        </Alert>
      ) : error ? (
        <Alert tone="danger" role="alert">
          {detail
            ? m.fulfillment_detail_refresh_failed()
            : m.fulfillment_detail_load_failed()}{' '}
          <Button variant="outline" onClick={refresh}>
            {m.common_retry()}
          </Button>
        </Alert>
      ) : null}
      {!detail && loading && !error ? (
        <div className="fulfillment-loading" role="status">
          <span className="sr-only">{m.fulfillment_detail_loading()}</span>
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
              <p className="fulfillment-eyebrow">
                {m.fulfillment_step_eyebrow()}
              </p>
              <h2>{step.title}</h2>
              <p className="fulfillment-note">{step.body}</p>
              {step.action === 'carrier' && carrier?.url ? (
                <a
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  href={carrier.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {m.fulfillment_open_carrier_tracking()}
                  <ExternalLink size={14} aria-hidden="true" />
                  <NewTab />
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
              <h2 id="fulfillment-items">{m.fulfillment_items_title()}</h2>
              <DataTable
                caption={m.fulfillment_items_caption()}
                density="compact"
                rows={detail.lines}
                rowKey={(line) => line.orderLineId}
                columns={[
                  {
                    key: 'item',
                    header: m.fulfillment_items_column_item(),
                    cell: (line) => (
                      <span className="fulfillment-cell">
                        {line.skuId ? (
                          <Link
                            to="/app/$organizationId/products/$skuId"
                            params={{ organizationId, skuId: line.skuId }}
                            search={{ from: here }}
                          >
                            {line.skuCode ??
                              line.title ??
                              m.fulfillment_items_linked_sku()}
                          </Link>
                        ) : (
                          <span>
                            {line.skuCode ??
                              line.title ??
                              m.fulfillment_items_unlinked()}
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
                    header: m.fulfillment_items_column_quantity(),
                    numeric: true,
                    cell: (line) => quantity(line.quantity, line.unit),
                  },
                  {
                    key: 'ordered',
                    header: m.fulfillment_items_column_ordered(),
                    numeric: true,
                    hideOnNarrow: true,
                    cell: (line) =>
                      line.ordered
                        ? quantity(line.ordered, line.unit)
                        : m.common_empty_value(),
                  },
                ]}
                empty={
                  <p className="fulfillment-note">
                    {m.fulfillment_items_empty()}
                  </p>
                }
              />
            </section>
            <Timeline detail={detail} />
            <section
              className="fulfillment-section"
              aria-labelledby="fulfillment-activity"
            >
              <h2 id="fulfillment-activity">
                {m.fulfillment_activity_title()}
              </h2>
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
                          {` · ${actorLabel(entry.actor)}`}
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
                          {m.fulfillment_activity_issue()}
                        </Link>
                      ) : null}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="fulfillment-note">
                  {m.fulfillment_activity_empty()}
                </p>
              )}
            </section>
          </div>
          <aside
            className="fulfillment-aside"
            aria-label={m.fulfillment_related_label()}
          >
            <Facts detail={detail} />
            <Card className="fulfillment-section">
              <h2>{m.fulfillment_order_title()}</h2>
              <Link
                to="/app/$organizationId/orders/$orderId"
                params={{ organizationId, orderId: detail.order.id }}
                search={{ from: here }}
              >
                {detail.order.number ?? orderLabel(item)}
              </Link>
              <dl className="fulfillment-facts">
                <Fact label={m.fulfillment_order_status()}>
                  {detail.order.status ? (
                    (orderStatusLabels[detail.order.status] ??
                    detail.order.status)
                  ) : (
                    <Missing>{m.fulfillment_order_not_read()}</Missing>
                  )}
                </Fact>
                <Fact label={m.fulfillment_order_payment()}>
                  {detail.order.paymentStatus ? (
                    (paymentLabels[detail.order.paymentStatus] ??
                    detail.order.paymentStatus)
                  ) : (
                    <Missing />
                  )}
                </Fact>
                <Fact label={m.fulfillment_order_fulfillment()}>
                  {detail.order.fulfillment ? (
                    (orderFulfillmentLabels[detail.order.fulfillment] ??
                    detail.order.fulfillment)
                  ) : (
                    <Missing />
                  )}
                </Fact>
                {detail.order.placedAt ? (
                  <Fact label={m.fulfillment_order_placed()}>
                    <WorkspaceDate value={detail.order.placedAt} />
                  </Fact>
                ) : null}
              </dl>
              <p className="fulfillment-note">
                {m.fulfillment_order_note({ source: detail.source.label })}
              </p>
            </Card>
            <Card className="fulfillment-section">
              <h2>{m.fulfillment_others_title()}</h2>
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
                            {m.fulfillment_others_context({
                              source:
                                other.connectionId === item.connectionId
                                  ? detail.source.label
                                  : m.fulfillment_others_another_source(),
                              units: quantity(other.units, other.unit),
                            })}
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
                  {m.fulfillment_others_empty()}
                </p>
              )}
            </Card>
            <Card className="fulfillment-section">
              <h2>{m.fulfillment_issues_title()}</h2>
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
                          {issue.lastDetectedAt
                            ? (issue.relationship === 'fulfillment'
                                ? m.fulfillment_issue_on_fulfillment_detected
                                : m.fulfillment_issue_on_order_detected)({
                                time: formatRelativeTime(
                                  issue.lastDetectedAt,
                                  detail.asOf,
                                ),
                              })
                            : issue.relationship === 'fulfillment'
                              ? m.fulfillment_issue_on_fulfillment()
                              : m.fulfillment_issue_on_order()}
                        </small>
                      </span>
                      {issue.needsYou ? (
                        <StatePill state="approval">
                          {m.fulfillment_issue_needs_you()}
                        </StatePill>
                      ) : (
                        <Badge>{issue.state}</Badge>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="fulfillment-note">
                  {m.fulfillment_issues_empty()}
                </p>
              )}
            </Card>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
