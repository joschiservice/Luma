import type { ReplenishmentApprovalContext } from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { Link } from '@tanstack/react-router';

import { formatMoney } from '../orders/presentation';

/** Shows frozen commercial and demand evidence beside the owner's governed approval. */
export function ApprovalContext({
  context,
  organizationId,
}: {
  context: ReplenishmentApprovalContext | null | undefined;
  organizationId: string;
}) {
  if (!context) return <p>{m.workflows_review_context_unavailable()}</p>;
  const number = (value: number | null) =>
    value === null
      ? m.workflows_review_not_reported()
      : formatNumber(value, { maximumFractionDigits: 2 });
  const days = (value: number | null) =>
    value === null
      ? m.workflows_review_not_reported()
      : m.workflows_review_days({ value: number(value) });

  return (
    <section aria-label={m.workflows_review_business_context()}>
      <h4>{m.workflows_review_business_context()}</h4>
      <dl className="replenishment-metrics">
        <div>
          <dt>{m.workflows_review_unit_cost()}</dt>
          <dd>
            {formatMoney(context.unitPrice) ??
              m.workflows_review_not_reported()}
          </dd>
        </div>
        <div>
          <dt>{m.workflows_review_total_value()}</dt>
          <dd>
            {formatMoney(context.totalValue) ??
              m.workflows_review_not_reported()}
          </dd>
        </div>
        <div>
          <dt>{m.workflows_review_lead_time()}</dt>
          <dd>{days(context.leadTimeDays)}</dd>
        </div>
        <div>
          <dt>
            {m.workflows_review_sales_rate({
              days: formatNumber(context.demandPeriodDays),
            })}
          </dt>
          <dd>
            {context.dailySales === null
              ? m.workflows_review_not_reported()
              : m.workflows_review_units_day({
                  value: number(context.dailySales),
                })}
          </dd>
        </div>
        <div>
          <dt>{m.workflows_review_cover_before()}</dt>
          <dd>{days(context.coverBeforeDays)}</dd>
        </div>
        <div>
          <dt>{m.workflows_review_cover_after()}</dt>
          <dd>{days(context.coverAfterDays)}</dd>
        </div>
      </dl>
      <h4>{m.workflows_review_open_orders()}</h4>
      {context.unavailable.includes('open_orders') ? (
        <p>{m.workflows_review_not_reported()}</p>
      ) : context.openOrders.length ? (
        <ul>
          {context.openOrders.map((order) => (
            <li key={order.id}>
              <Link
                to="/app/$organizationId/procurement/$purchaseOrderId"
                params={{ organizationId, purchaseOrderId: order.id }}
              >
                {order.reference}
              </Link>
              {' · '}
              {formatNumber(order.quantity)}
              {' · '}
              {order.status === 'draft'
                ? m.procurement_status_draft()
                : m.procurement_status_open()}
            </li>
          ))}
        </ul>
      ) : (
        <p>{m.workflows_review_open_orders_none()}</p>
      )}
      {context.unavailable.includes('open_orders_truncated') ? (
        <p>{m.workflows_review_open_orders_truncated()}</p>
      ) : null}
      {context.termsObservedAt ? (
        <p>
          {m.workflows_review_terms_recorded()}{' '}
          <WorkspaceDate value={context.termsObservedAt} />
        </p>
      ) : null}
      {context.demandObservedAt ? (
        <p>
          {m.workflows_review_demand_recorded()}{' '}
          <WorkspaceDate value={context.demandObservedAt} />
        </p>
      ) : null}
      <p>
        {m.workflows_review_context_recorded()}{' '}
        <WorkspaceDate value={context.recordedAt} />
      </p>
      <p>{m.workflows_review_context_note()}</p>
    </section>
  );
}
