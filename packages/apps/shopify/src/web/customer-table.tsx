import { m } from '@luma/i18n/messages';
import { Button } from '@luma/ui/components/primitives/button';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import { Empty } from '@luma/ui/components/primitives/empty';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';

import type { ShopifyRecordRow } from '../domain/records.js';

function sourceState(value: ShopifyRecordRow['fields'][string] | undefined) {
  if (value == null) return m.common_unknown();
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
      caption={m.shopify_customers_table_caption()}
      rowKey={(row) => row.id}
      rows={rows}
      density="compact"
      variant="plain"
      empty={
        <Empty>
          <h3>{m.shopify_customers_empty_title()}</h3>
          <p>{m.shopify_customers_empty_body()}</p>
        </Empty>
      }
      columns={[
        {
          key: 'order',
          header: m.shopify_customers_column_order(),
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
          header: m.shopify_customers_column_placed(),
          cell: (row) => <WorkspaceDate value={String(row.fields.Created)} />,
          hideOnNarrow: true,
        },
        {
          key: 'payment',
          header: m.shopify_customers_column_payment(),
          cell: (row) => sourceState(row.fields.Payment),
        },
        {
          key: 'fulfillment',
          header: m.shopify_customers_column_fulfillment(),
          cell: (row) => sourceState(row.fields.Fulfillment),
        },
        {
          key: 'total',
          header: m.shopify_customers_column_total(),
          numeric: true,
          cell: (row) => String(row.fields.Total),
        },
      ]}
    />
  );
}
