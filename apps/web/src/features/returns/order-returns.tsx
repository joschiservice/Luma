import './returns.css';

import type { OrderDetail } from '@luma/api-contract';
import { StatePill } from '@luma/ui/components/primitives/state';
import { Link } from '@tanstack/react-router';
import { ArrowRight } from 'lucide-react';

import { OrderSection } from '../orders/order-section';
import {
  refundSummary,
  returnLabel,
  stageLabels,
  stageStates,
  units,
} from './presentation';

/** Lists an order's returns and refunds with their stage; each opens its return. */
export function OrderReturns({
  detail,
  organizationId,
  from,
}: {
  detail: OrderDetail;
  organizationId: string;
  from: string;
}) {
  const label = (connectionId: string) =>
    detail.sources.find((source) => source.connectionId === connectionId)
      ?.label ?? 'Connected source';

  return (
    <OrderSection
      title="Returns and refunds"
      description="Returns and refunds imported from each source. Only successful refund payments count as money returned."
    >
      {detail.returns.length ? (
        <ul className="order-list order-returns">
          {detail.returns.map((item) => (
            <li key={item.id}>
              <span className="returns-cell">
                <strong>
                  {returnLabel(item)}
                  {item.deleted ? ' · removed at source' : ''}
                </strong>
                <span>
                  <StatePill state={stageStates[item.stage]}>
                    {stageLabels[item.stage]}
                  </StatePill>
                </span>
                <small>
                  {label(item.connectionId)}
                  {item.kind === 'return'
                    ? ` · ${units(item.quantity)} ${item.quantity === '1' ? 'unit' : 'units'}`
                    : ''}
                  {' · '}
                  {refundSummary(item)}
                </small>
              </span>
              <Link
                to="/app/$organizationId/returns/$returnId"
                params={{ organizationId, returnId: item.id }}
                search={{ from }}
              >
                Open <ArrowRight size={13} aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="order-note">
          No return or refund is imported for this order.
        </p>
      )}
    </OrderSection>
  );
}
