import './customers.css';

import type { AppUiProps } from '@luma/app-host/web';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Pagination } from '@luma/ui/components/primitives/pagination';
import { useState } from 'react';

import { useCustomerRecord } from './customer-data.js';
import { CustomerOrder } from './customer-order.js';
import { CustomerTable } from './customer-table.js';

const pageSize = 20;

/**
 * Reads one source customer's order history live from their store. The host page shows the
 * imported profile; this slot adds the orders and the service context of a selected order.
 */
export function ShopifyCustomers({
  customer,
  organizationId,
  services,
}: AppUiProps) {
  if (!customer?.connectionId || !customer.id) return null;

  return (
    <CustomerOrders
      key={`${organizationId}/${customer.connectionId}/${customer.id}`}
      organizationId={organizationId}
      connectionId={customer.connectionId}
      id={customer.id}
      services={services}
    />
  );
}

function CustomerOrders({
  organizationId,
  connectionId,
  id,
  services,
}: {
  organizationId: string;
  connectionId: string;
  id: string;
  services: AppUiProps['services'];
}) {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [selectedOrder, setSelectedOrder] = useState('');
  const read = useCustomerRecord(services, {
    connectionId,
    kind: 'Customer',
    id,
    ...(cursors.at(-1) ? { cursor: cursors.at(-1) } : {}),
  });
  const orders = read.data?.sections.find(
    (section) => section.key === 'orders',
  );
  const rows = orders?.rows ?? [];
  const selected = rows.some((row) => row.id === selectedOrder)
    ? selectedOrder
    : '';

  return (
    <div className="customer-orders" aria-busy={read.pending}>
      <div className="customer-orders-toolbar">
        <span className="customer-orders-meta">
          {read.data ? `Read from ${read.data.shop}` : 'Reading from Shopify…'}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setSelectedOrder('');
            read.refresh();
          }}
          disabled={read.pending}
        >
          Refresh orders
        </Button>
      </div>
      {read.pending ? (
        <p role="status" className="customer-orders-meta">
          Loading order history…
        </p>
      ) : read.error ? (
        <Alert tone="danger" role="alert">
          {read.error}{' '}
          <Button variant="outline" onClick={read.refresh}>
            Retry
          </Button>
        </Alert>
      ) : orders?.status !== 'available' ? (
        <Alert role="status">
          {orders?.message ??
            'Shopify did not return this customer’s order history.'}
        </Alert>
      ) : (
        <>
          <CustomerTable
            rows={rows}
            selectedOrder={selected}
            setSelectedOrder={setSelectedOrder}
          />
          {cursors.length > 1 || read.data?.nextCursor ? (
            <Pagination
              count={rows.length}
              page={cursors.length}
              pageSize={pageSize}
              hasNext={!!read.data?.nextCursor}
              onPrevious={
                cursors.length > 1
                  ? () => {
                      setSelectedOrder('');
                      setCursors(cursors.slice(0, -1));
                    }
                  : undefined
              }
              onNext={() => {
                setSelectedOrder('');
                setCursors([...cursors, read.data?.nextCursor ?? undefined]);
              }}
              itemLabel="orders"
              label="Order history pages"
            />
          ) : null}
          {selected ? (
            <CustomerOrder
              key={selected}
              organizationId={organizationId}
              connectionId={connectionId}
              id={selected}
              services={services}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
