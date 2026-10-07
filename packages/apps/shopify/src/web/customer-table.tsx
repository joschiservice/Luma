import { Button } from '@luma/ui/components/primitives/button';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import { Empty } from '@luma/ui/components/primitives/empty';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';

import type { ShopifyRecordRow } from '../domain/records.js';

function sourceState(value: ShopifyRecordRow['fields'][string] | undefined) {
  if (value == null) return 'Unknown';
  const text = String(value).toLowerCase().replaceAll('_', ' ');

  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Lists a source customer's orders; choosing an order opens its service context below. */
export function CustomerTable({
  rows,
  selectedOrder,
  setSelectedOrder,
}: {
  rows: ShopifyRecordRow[];
  selectedOrder: string;
  setSelectedOrder: (id: string) => void;
}) {
  return (
    <DataTable
      caption="Customer order history"
      rowKey={(row) => row.id}
      rows={rows}
      density="compact"
      variant="plain"
      empty={
        <Empty>
          <h3>No orders in the available history</h3>
          <p>Shopify returned no orders for this customer.</p>
        </Empty>
      }
      columns={[
        {
          key: 'order',
          header: 'Order',
          cell: (row) => (
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={selectedOrder === row.id}
              onClick={() =>
                setSelectedOrder(selectedOrder === row.id ? '' : row.id)
              }
            >
              {String(row.fields.Name)}
            </Button>
          ),
        },
        {
          key: 'placed',
          header: 'Placed',
          cell: (row) => <WorkspaceDate value={String(row.fields.Created)} />,
          hideOnNarrow: true,
        },
        {
          key: 'payment',
          header: 'Payment',
          cell: (row) => sourceState(row.fields.Payment),
        },
        {
          key: 'fulfillment',
          header: 'Fulfillment',
          cell: (row) => sourceState(row.fields.Fulfillment),
        },
        {
          key: 'total',
          header: 'Total',
          numeric: true,
          cell: (row) => String(row.fields.Total),
        },
      ]}
    />
  );
}
