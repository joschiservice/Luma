import type { ActivityEvent, OrderDetail } from '@luma/api-contract';
import { Badge } from '@luma/ui/components/primitives/badge';
import { StateDot } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { Link } from '@tanstack/react-router';
import { ArrowRight } from 'lucide-react';

import { activityLabel, activityState } from '../activity/presentation';
import { OrderSection } from './order-section';
import {
  formatQuantity,
  paymentLabels,
  shipmentLabels,
  statusLabels,
} from './presentation';

function sourceLabel(detail: OrderDetail, connectionId: string) {
  return (
    detail.sources.find((source) => source.connectionId === connectionId)
      ?.label ?? 'Connected source'
  );
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
    <OrderSection
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
                  {sourceLabel(detail, item.connectionId)}
                  {' · '}
                  {item.lines
                    .map((line) => formatQuantity(line.quantity, line.unit))
                    .join(' + ')}{' '}
                  units
                  {item.failureCode ? ` · Failure ${item.failureCode}` : ''}
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
                  {item.externalId ? ` · Source ID ${item.externalId}` : ''}
                </small>
              </span>
              <Link
                to="/app/$organizationId/fulfillment/$fulfillmentId"
                params={{ organizationId, fulfillmentId: item.id }}
                search={{ from }}
                aria-label={`Open ${shipmentLabels[item.status] ?? item.status} fulfillment`}
              >
                Open <ArrowRight size={13} aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="order-note">
          No source has reported fulfillment work for this order.
        </p>
      )}
    </OrderSection>
  );
}

/** Lists the order and fulfillment states Luma read from each source, newest first. */
export function ObservedHistory({ detail }: { detail: OrderDetail }) {
  return (
    <OrderSection
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
                {sourceLabel(detail, entry.connectionId)}
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
    <OrderSection
      title="Luma activity"
      description="Decisions, actions and results Luma recorded for this order, its issues and workflow runs."
    >
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
                  Issue
                </Link>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="order-note">
          No Luma activity is recorded for this order in the last year.
        </p>
      )}
      {detail.activity.truncated ? (
        <p className="order-note">Showing the latest 25 events.</p>
      ) : null}
    </OrderSection>
  );
}
