import type { ReturnDetail } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Button } from '@luma/ui/components/primitives/button';
import { StatePill } from '@luma/ui/components/primitives/state';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRight, ChevronRight, ClipboardCheck } from 'lucide-react';
import { useState } from 'react';

import { IdentityError } from '../identity/data';
import { orderReturnCasesOptions } from './case-data';
import {
  caseStageLabels,
  caseStageStates,
  personName,
} from './case-presentation';
import { OpenCaseDialog } from './open-case-dialog';

/**
 * Lists an order's return cases and opens a new one. Readers without access to returns see
 * nothing; the order page stays complete without it.
 */
export function OrderReturnCases({
  organizationId,
  orderId,
  sourceLabel,
}: {
  organizationId: string;
  orderId: string;
  sourceLabel: (connectionId: string) => string;
}) {
  const query = useQuery(orderReturnCasesOptions(organizationId, orderId));
  const [opening, setOpening] = useState(false);
  if (query.error instanceof IdentityError && query.error.status === 403)
    return null;
  const data = query.data;
  if (!data) return null;
  const returnable = data.sources.some((source) =>
    source.lines.some((line) => line.returnable > 0),
  );

  return (
    <div className="returns-order-cases">
      <h3>{m.returns_case_order_title()}</h3>
      {data.cases.length ? (
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
      ) : (
        <p className="order-note">{m.returns_case_order_empty()}</p>
      )}
      {data.canManage ? (
        returnable ? (
          <Button variant="outline" size="sm" onClick={() => setOpening(true)}>
            <ClipboardCheck size={14} aria-hidden="true" />
            {m.returns_case_open_action()}
          </Button>
        ) : (
          <p className="order-note">{m.returns_case_order_nothing_left()}</p>
        )
      ) : null}
      {opening ? (
        <OpenCaseDialog
          organizationId={organizationId}
          orderId={orderId}
          cases={data}
          sourceLabel={sourceLabel}
          close={() => setOpening(false)}
        />
      ) : null}
    </div>
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
