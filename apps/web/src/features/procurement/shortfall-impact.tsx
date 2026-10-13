import type { Attention } from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { useQuery } from '@tanstack/react-query';

import { purchaseOrderRecordOptions } from './data';
import { purchasingOptions } from './purchasing-data';

/** Shows the stated demand assumption without inferring which customer orders depend on an arrival. */
export function ShortfallImpact({
  organizationId,
  orderId,
  attention,
}: {
  organizationId: string;
  orderId: string;
  attention: Attention;
}) {
  const record = useQuery(purchaseOrderRecordOptions(organizationId, orderId));
  const purchasing = useQuery(purchasingOptions(organizationId));
  const lines =
    record.data?.progress.lines.filter(
      (line) => !attention.lineId || line.lineId === attention.lineId,
    ) ?? [];

  return (
    <div className="procurement-hint">
      {lines.map((line) => {
        const input = purchasing.data?.items.find(
          (item) =>
            item.supplierId === record.data?.order.supplierId &&
            item.sku === line.sku,
        );
        const complete =
          input &&
          input.available !== null &&
          input.demand.complete &&
          input.demand.daily !== null &&
          input.demand.daily > 0 &&
          !input.missing.some((reason) =>
            [
              'stock_missing',
              'stock_authority',
              'stock_incomplete',
              'stock_stale',
            ].includes(reason),
          );
        const current = complete
          ? input.available! / input.demand.daily!
          : null;
        const after = complete
          ? (input.available! + line.outstanding) / input.demand.daily!
          : null;

        return (
          <p key={line.lineId}>
            {current !== null && after !== null
              ? m.procurement_shortfall_effect({
                  sku: line.sku,
                  current: formatNumber(current, { maximumFractionDigits: 1 }),
                  after: formatNumber(after, { maximumFractionDigits: 1 }),
                  quantity: formatNumber(line.outstanding, {
                    maximumFractionDigits: 6,
                  }),
                })
              : m.procurement_shortfall_cover_unknown()}
          </p>
        );
      })}
      <p>{m.procurement_shortfall_customer_unknown()}</p>
    </div>
  );
}
