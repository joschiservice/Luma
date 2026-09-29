import { Button } from '@luma/ui/components/primitives/button';
import {
  DataTable,
  DataTableRowLink,
} from '@luma/ui/components/primitives/data-table';
import { Empty } from '@luma/ui/components/primitives/empty';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';

import type { ShopifyRecordRow } from '../domain/records.js';
import { customerHref } from './customer-data.js';

function sourceState(value: ShopifyRecordRow['fields'][string] | undefined) {
  if (value == null) return 'Unknown';
  const text = String(value).toLowerCase().replaceAll('_', ' ');

  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Lists source customers or their orders, preserving identity links and the selected order. */
export function CustomerTable({
  id,
  organizationId,
  connectionId,
  rows,
  selectedOrder,
  setSelectedOrder,
}: {
  id: string | undefined;
  organizationId: string;
  connectionId: string;
  rows: ShopifyRecordRow[];
  selectedOrder: string;
  setSelectedOrder: (id: string) => void;
}) {
  return (
    <DataTable
      caption={id ? 'Customer order history' : 'Customers in this source'}
      rowKey={(row) => row.id}
      rows={rows}
      empty={
        <Empty>
          <h3>
            {id ? 'No orders in the available history' : 'No customers found'}
          </h3>
          <p>
            {id
              ? 'The connected source returned no orders for this customer.'
              : 'Try another search or source.'}
          </p>
        </Empty>
      }
      columns={
        id
          ? [
              {
                key: 'order',
                header: 'Order',
                cell: (row) => (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-pressed={selectedOrder === row.id}
                    onClick={() => setSelectedOrder(row.id)}
                  >
                    {String(row.fields.Name)}
                  </Button>
                ),
              },
              {
                key: 'placed',
                header: 'Placed',
                cell: (row) => (
                  <WorkspaceDate value={String(row.fields.Created)} />
                ),
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
            ]
          : [
              {
                key: 'name',
                header: 'Customer',
                cell: (row) => (
                  <div>
                    <DataTableRowLink
                      render={
                        <a
                          href={customerHref(
                            organizationId,
                            connectionId,
                            row.id,
                          )}
                        />
                      }
                    >
                      {String(row.fields.Name || 'Customer')}
                    </DataTableRowLink>
                    <div className="field-help">{row.id.split('/').at(-1)}</div>
                  </div>
                ),
              },
              {
                key: 'email',
                header: 'Email',
                cell: (row) =>
                  String(
                    row.fields.Email === undefined
                      ? 'Access unavailable'
                      : (row.fields.Email ?? 'Not provided'),
                  ),
              },
              {
                key: 'orders',
                header: 'Orders',
                numeric: true,
                cell: (row) => String(row.fields.Orders),
              },
              {
                key: 'spent',
                header: 'Spent',
                numeric: true,
                cell: (row) => String(row.fields.Spent),
                hideOnNarrow: true,
              },
            ]
      }
    />
  );
}
