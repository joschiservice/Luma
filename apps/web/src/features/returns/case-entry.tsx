import type { OrderDetail, ReturnDetail } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Button } from '@luma/ui/components/primitives/button';
import { StatePill } from '@luma/ui/components/primitives/state';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRight, ChevronRight, ClipboardCheck } from 'lucide-react';
import { useState } from 'react';

import { IdentityError } from '../../kit/identity/data';
import { orderReturnCasesOptions } from './case-data';
import {
  caseStageLabels,
  caseStageStates,
  personName,
} from './case-presentation';
import { OpenCaseDialog } from './open-case-dialog';
import { OrderReturns } from './order-returns';

/**
 * Shows the order's returns and refunds with Luma's return cases beneath them, and puts
 * opening a new case in the section header. Readers without access to return cases see the
 * store's records alone; the order page stays complete without them.
 */
export function OrderReturnsWithCases({
  organizationId,
  detail,
  from,
  sourceLabel,
}: {
  organizationId: string;
  detail: OrderDetail;
  from: string;
  sourceLabel: (connectionId: string) => string;
}) {
  const orderId = detail.order.id;
  const query = useQuery(orderReturnCasesOptions(organizationId, orderId));
  const [opening, setOpening] = useState(false);
  const data =
    query.error instanceof IdentityError && query.error.status === 403
      ? undefined
      : query.data;
  const returnable = data?.sources.some((source) =>
    source.lines.some((line) => line.returnable > 0),
  );
  // Only an order with returns can have every unit in one; otherwise the note would mislead.
  const nothingLeft =
    data?.canManage &&
    !returnable &&
    (data.cases.length > 0 || detail.returns.length > 0);

  return (
    <>
      <OrderReturns
        detail={detail}
        organizationId={organizationId}
        from={from}
        cases={
          data?.cases.length || nothingLeft ? (
            <div className="returns-order-cases">
              {data?.cases.length ? (
                <>
                  <h3>{m.returns_case_order_title()}</h3>
                  <ul className="order-list">
                    {data.cases.map((item) => (
                      <li key={item.id}>
                        <Link
                          className="order-row-link"
                          to="/app/$organizationId/returns/cases/$caseId"
                          params={{ organizationId, caseId: item.id }}
                        >
                          <span className="returns-cell">
                            <strong>
                              {m.returns_case_order_item({ units: item.units })}
                            </strong>
                            <span>
                              <StatePill state={caseStageStates[item.stage]}>
                                {caseStageLabels[item.stage]}
                              </StatePill>
                            </span>
                            <small>
                              {sourceLabel(item.connectionId)}
                              {item.assignee
                                ? ` · ${m.returns_case_order_assignee({ name: personName(item.assignee) })}`
                                : ''}
                            </small>
                          </span>
                          <ChevronRight
                            className="order-row-chevron"
                            aria-hidden="true"
                          />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {nothingLeft ? (
                <p className="order-note">
                  {m.returns_case_order_nothing_left()}
                </p>
              ) : null}
            </div>
          ) : null
        }
        action={
          data?.canManage && returnable ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOpening(true)}
            >
              <ClipboardCheck size={14} aria-hidden="true" />
              {m.returns_case_open_action()}
            </Button>
          ) : null
        }
      />
      {opening && data ? (
        <OpenCaseDialog
          organizationId={organizationId}
          orderId={orderId}
          cases={data}
          sourceLabel={sourceLabel}
          close={() => setOpening(false)}
        />
      ) : null}
    </>
  );
}

/**
 * Links a store return to the case that works it, or opens one prefilled with the return's
 * lines. Refunds and returns without a known order have no case.
 */
export function StoreReturnCase({
  organizationId,
  detail,
}: {
  organizationId: string;
  detail: ReturnDetail;
}) {
  const orderId = detail.order?.id ?? '';
  const query = useQuery({
    ...orderReturnCasesOptions(organizationId, orderId),
    enabled: !!orderId && detail.item.kind === 'return',
  });
  const [opening, setOpening] = useState(false);
  const data = query.data;
  if (!data || detail.item.kind !== 'return') return null;
  const own = data.sources
    .flatMap((source) => source.storeReturns)
    .find((item) => item.id === detail.item.id);
  const closed =
    detail.item.status === 'declined' || detail.item.status === 'cancelled';

  return (
    <div className="returns-case-entry">
      {own?.caseId ? (
        <p>
          {m.returns_case_store_worked()}{' '}
          <Link
            to="/app/$organizationId/returns/cases/$caseId"
            params={{ organizationId, caseId: own.caseId }}
          >
            {m.returns_case_store_open_case()}{' '}
            <ArrowRight size={13} aria-hidden="true" />
          </Link>
        </p>
      ) : (
        <>
          <p className="returns-note">
            {closed
              ? m.returns_case_store_closed()
              : m.returns_case_store_description()}
          </p>
          {data.canManage && !closed && own ? (
            <Button variant="outline" onClick={() => setOpening(true)}>
              <ClipboardCheck size={14} aria-hidden="true" />
              {m.returns_case_store_action()}
            </Button>
          ) : null}
        </>
      )}
      {opening ? (
        <OpenCaseDialog
          organizationId={organizationId}
          orderId={orderId}
          cases={data}
          sourceLabel={() =>
            detail.source?.label ?? m.returns_source_fallback()
          }
          storeReturn={{
            id: detail.item.id,
            connectionId: detail.item.connectionId,
            lines: detail.lines.flatMap((line) =>
              line.orderLineId
                ? [
                    {
                      orderLineId: line.orderLineId,
                      quantity: Math.floor(Number(line.quantity)),
                      reason: line.reason,
                    },
                  ]
                : [],
            ),
          }}
          close={() => setOpening(false)}
        />
      ) : null}
    </div>
  );
}
