import type { PurchaseOrderStatus } from '@luma/api-contract';
import { Badge } from '@luma/ui/components/primitives/badge';

export const statusLabels: Record<PurchaseOrderStatus, string> = {
  draft: 'Draft',
  open: 'Open',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

/** Presents order state with a readable label and semantic color. */
export function OrderStatus({ status }: { status: PurchaseOrderStatus }) {
  return (
    <Badge
      tone={
        status === 'open' ? 'info' : status === 'closed' ? 'success' : 'neutral'
      }
    >
      <span className="procurement-status-dot" />
      {statusLabels[status]}
    </Badge>
  );
}
