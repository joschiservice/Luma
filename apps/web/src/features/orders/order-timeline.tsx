import type { ActivityEvent, OrderDetail } from '@luma/api-contract';
import { formatList } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { Badge } from '@luma/ui/components/primitives/badge';
import { StateDot } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { Link } from '@tanstack/react-router';
import { Activity, ArrowRight, History, Truck } from 'lucide-react';

import { activityLabel, activityState } from '../activity/presentation';
import { OrderSection } from './order-section';
import {
  formatQuantity,
  paymentLabels,
  returnLabels,
  shipmentLabels,
  statusLabels,
} from './presentation';

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

/** Lists fulfillment work each source reports, linking each to its record; `from` is the order path. */
export function OrderFulfillments({
  detail,
  organizationId,
  from,
}: {
  detail: OrderDetail;
  organizationId: string;
  from: string;
}) {
  return (
    <OrderSection title={m.orders_fulfillments_title()} icon={Truck}>
      {detail.fulfillments.length ? (
        <ul className="order-list">
          {detail.fulfillments.map((item) => {
            const status = shipmentLabels[item.status] ?? item.status;

            return (
              <li key={`${item.id}:${item.connectionId}`}>
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
                    {item.externalId
                      ? ` · ${m.orders_fulfillments_source_id({ id: item.externalId })}`
                      : ''}
                  </small>
                </span>
                <Link
                  to="/app/$organizationId/fulfillment/$fulfillmentId"
                  params={{ organizationId, fulfillmentId: item.id }}
                  search={{ from }}
                  aria-label={m.orders_fulfillments_open({ status })}
                >
                  {m.common_open()} <ArrowRight size={13} aria-hidden="true" />
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="order-note">{m.orders_fulfillments_empty()}</p>
      )}
    </OrderSection>
  );
}

/** Lists the order, fulfillment, return and refund states Luma read from each source, newest first. */
export function ObservedHistory({ detail }: { detail: OrderDetail }) {
  return (
    <OrderSection title={m.orders_history_title()} icon={History}>
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
    </OrderSection>
  );
}

/** Lists what Luma decided and did for this order, its issues and workflow runs. */
export function LumaActivity({
  detail,
  organizationId,
}: {
  detail: OrderDetail;
  organizationId: string;
}) {
  return (
    <OrderSection title={m.orders_activity_title()} icon={Activity}>
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
    </OrderSection>
  );
}
