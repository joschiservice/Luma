import './returns.css';

import type { OrderDetail } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { StatePill } from '@luma/ui/components/primitives/state';
import { Link } from '@tanstack/react-router';
import { ChevronRight, Undo2 } from 'lucide-react';

import { OrderSection } from '../orders/order-section';
import {
  refundSummary,
  returnLabel,
  stageLabels,
  stageStates,
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
      ?.label ?? m.returns_source_fallback();

  return (
    <OrderSection title={m.returns_order_section_title()} icon={Undo2}>
      {detail.returns.length ? (
        <ul className="order-list order-returns">
          {detail.returns.map((item) => (
            <li key={item.id}>
              <Link
                className="order-row-link"
                to="/app/$organizationId/returns/$returnId"
                params={{ organizationId, returnId: item.id }}
                search={{ from }}
              >
                <span className="returns-cell">
                  <strong>
                    {item.deleted
                      ? m.returns_order_section_removed({
                          label: returnLabel(item),
                        })
                      : returnLabel(item)}
                  </strong>
                  <span>
                    <StatePill state={stageStates[item.stage]}>
                      {stageLabels[item.stage]}
                    </StatePill>
                  </span>
                  <small>
                    {item.kind === 'return'
                      ? m.returns_order_section_units({
                          source: label(item.connectionId),
                          units: Number(item.quantity),
                          refund: refundSummary(item),
                        })
                      : m.returns_order_section_refund({
                          source: label(item.connectionId),
                          refund: refundSummary(item),
                        })}
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
        <p className="order-note">{m.returns_order_section_empty()}</p>
      )}
    </OrderSection>
  );
}
