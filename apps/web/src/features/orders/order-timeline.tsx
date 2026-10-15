import type { ActivityEvent, OrderDetail } from '@luma/api-contract';
import { formatList, formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { Badge } from '@luma/ui/components/primitives/badge';
import { StateDot } from '@luma/ui/components/primitives/state';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@luma/ui/components/primitives/tabs';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { actorLabel } from '@luma/ui/lib/actor';
import { Link } from '@tanstack/react-router';
import { ChevronRight, History, Truck } from 'lucide-react';
import { useState } from 'react';

import { OrderSection } from '../../shared/orders/order-section';
import {
  formatQuantity,
  paymentLabels,
  returnLabels,
  shipmentLabels,
  statusLabels,
} from '../../shared/orders/presentation';
import { activityLabel, activityState } from '../activity/presentation';
import { OrderJourney } from './journey';

function sourceLabel(detail: OrderDetail, connectionId: string) {
  return (
    detail.sources.find((source) => source.connectionId === connectionId)
      ?.label ?? m.orders_source_fallback()
  );
}

type HistoryEntry = OrderDetail['history']['entries'][number];

function historyLabel(entry: HistoryEntry) {
  if (entry.entityKind === 'order') {
    const status = statusLabels[entry.status] ?? entry.status;

    return entry.paymentStatus
      ? m.orders_history_order_payment({
          status,
          payment: paymentLabels[entry.paymentStatus] ?? entry.paymentStatus,
        })
      : m.orders_history_order({ status });
  }
  if (entry.entityKind === 'fulfillment')
    return m.orders_history_fulfillment({
      status: shipmentLabels[entry.status] ?? entry.status,
    });
  if (entry.entityKind === 'return')
    return m.orders_history_return({
      status: returnLabels[entry.status] ?? entry.status,
    });

  return m.orders_history_refund();
}

/**
 * Lists fulfillment work each source reports, linking each to its record; `from` is the order
 * path. Without any, the section is its header with a badge that says whether no source
 * reported fulfillment work or the reader can't view it.
 */
export function OrderFulfillments({
  detail,
  organizationId,
  from,
}: {
  detail: OrderDetail;
  organizationId: string;
  from: string;
}) {
  if (!detail.fulfillments.length)
    return (
      <OrderSection
        title={m.orders_fulfillments_title()}
        icon={Truck}
        status={
          <Badge>
            {detail.hidden.includes('fulfillments')
              ? m.orders_section_no_access()
              : m.orders_section_none_reported()}
          </Badge>
        }
      />
    );

  return (
    <OrderSection title={m.orders_fulfillments_title()} icon={Truck}>
      {
        <ul className="order-list">
          {detail.fulfillments.map((item) => {
            const status = shipmentLabels[item.status] ?? item.status;

            return (
              <li key={`${item.id}:${item.connectionId}`}>
                <Link
                  className="order-row-link"
                  to="/app/$organizationId/fulfillment/$fulfillmentId"
                  params={{ organizationId, fulfillmentId: item.id }}
                  search={{ from }}
                >
                  <span className="orders-cell-stack">
                    <strong>
                      {item.deleted
                        ? m.orders_fulfillments_removed({ status })
                        : status}
                    </strong>
                    <small>
                      {[
                        sourceLabel(detail, item.connectionId),
                        m.orders_fulfillments_quantities({
                          quantities: formatList(
                            item.lines.map((line) =>
                              formatQuantity(line.quantity, line.unit),
                            ),
                            { type: 'unit' },
                          ),
                        }),
                        item.failureCode
                          ? m.orders_fulfillments_failure_code({
                              code: item.failureCode,
                            })
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </small>
                    <small>
                      {item.lastProgressAt
                        ? rich(m.orders_fulfillments_progress, {
                            date: <WorkspaceDate value={item.lastProgressAt} />,
                          })
                        : m.orders_fulfillments_no_progress()}
                    </small>
                  </span>
                  <ChevronRight
                    className="order-row-chevron"
                    aria-hidden="true"
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      }
    </OrderSection>
  );
}

/** Lists the order, fulfillment, return and refund states Luma read from each source, newest first. */
function ObservedHistory({ detail }: { detail: OrderDetail }) {
  return (
    <div className="order-timeline-panel">
      <ol className="order-history">
        {detail.history.entries.map((entry) => (
          <li key={entry.snapshotId}>
            <span className="orders-cell-stack">
              <strong>
                {entry.deleted
                  ? m.orders_history_removed({ entry: historyLabel(entry) })
                  : historyLabel(entry)}
              </strong>
              <small>
                {entry.sourceUpdatedAt
                  ? rich(m.orders_history_times, {
                      source: sourceLabel(detail, entry.connectionId),
                      updated: <WorkspaceDate value={entry.sourceUpdatedAt} />,
                      read: <WorkspaceDate value={entry.observedAt} />,
                    })
                  : rich(m.orders_history_times_unreported, {
                      source: sourceLabel(detail, entry.connectionId),
                      read: <WorkspaceDate value={entry.observedAt} />,
                    })}
              </small>
            </span>
            {entry.current ? <Badge>{m.orders_history_current()}</Badge> : null}
          </li>
        ))}
      </ol>
      {detail.history.truncated ? (
        <p className="order-note">
          {m.orders_history_truncated({ count: 100 })}
        </p>
      ) : null}
    </div>
  );
}

/** Lists what Luma decided and did for this order, its issues and workflow runs. */
function LumaActivity({
  detail,
  organizationId,
}: {
  detail: OrderDetail;
  organizationId: string;
}) {
  return (
    <div className="order-timeline-panel">
      {detail.activity.entries.length ? (
        <ol className="order-activity">
          {detail.activity.entries.map((entry) => (
            <li key={entry.id}>
              <StateDot
                state={activityState(entry.outcome as ActivityEvent['outcome'])}
              />
              <span className="orders-cell-stack">
                <strong>{activityLabel(entry.action)}</strong>
                <small>
                  <WorkspaceDate value={entry.recordedAt} />
                  {` · ${actorLabel(entry.actor)}`}
                  {entry.summary ? ` · ${entry.summary}` : ''}
                </small>
              </span>
              {entry.exceptionId ? (
                <Link
                  to="/app/$organizationId/exceptions/$exceptionId"
                  params={{ organizationId, exceptionId: entry.exceptionId }}
                  search={{ view: 'active' }}
                >
                  {m.orders_activity_open_issue()}
                </Link>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="order-note">{m.orders_activity_empty()}</p>
      )}
      {detail.activity.truncated ? (
        <p className="order-note">
          {m.orders_activity_truncated({ count: 25 })}
        </p>
      ) : null}
    </div>
  );
}

type TimelineTab = 'activity' | 'journey' | 'history';

/**
 * The order's history in one section: what Luma did, the source-backed journey and the states
 * Luma read from each source, one tab each. It opens on the journey when a journey check needs
 * investigation or Luma recorded no activity. `from` is the order path that part links return to.
 */
export function OrderTimeline({
  detail,
  organizationId,
  from,
}: {
  detail: OrderDetail;
  organizationId: string;
  from: string;
}) {
  // Journey checks that need investigation come first; otherwise what Luma did.
  const [tab, setTab] = useState<TimelineTab>(
    detail.journey?.candidates.length || !detail.activity.entries.length
      ? 'journey'
      : 'activity',
  );
  const tabs: { value: TimelineTab; label: string; count?: number }[] = [
    {
      value: 'activity',
      label: m.orders_activity_title(),
      count: detail.activity.entries.length,
    },
    {
      value: 'journey',
      label: m.orders_journey_title(),
      ...(detail.journey ? { count: detail.journey.events.length } : {}),
    },
    {
      value: 'history',
      label: m.orders_history_title(),
      count: detail.history.entries.length,
    },
  ];

  return (
    <OrderSection title={m.orders_timeline_title()} icon={History}>
      <Tabs
        value={tab}
        onValueChange={(value: TimelineTab) => setTab(value)}
        className="order-timeline"
      >
        <TabsList aria-label={m.orders_timeline_title()}>
          {tabs.map((item) => (
            <TabsTrigger key={item.value} value={item.value}>
              {item.label}
              {item.count ? (
                <span className="order-tab-count">
                  {formatNumber(item.count)}
                </span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="activity">
          <LumaActivity detail={detail} organizationId={organizationId} />
        </TabsContent>
        <TabsContent value="journey">
          <OrderJourney
            detail={detail}
            organizationId={organizationId}
            from={from}
          />
        </TabsContent>
        <TabsContent value="history">
          <ObservedHistory detail={detail} />
        </TabsContent>
      </Tabs>
    </OrderSection>
  );
}
