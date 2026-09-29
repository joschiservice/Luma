import './customers.css';

import type { AppUiProps } from '@luma/app-host/web';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Empty } from '@luma/ui/components/primitives/empty';
import { Input } from '@luma/ui/components/primitives/input';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import type {
  CustomerSearch,
  ShopifyRecordSection,
} from '../domain/records.js';
import { useCustomerRecord } from './customer-data.js';
import { CustomerOrder } from './customer-order.js';
import { CustomerSummary } from './customer-summary.js';
import { CustomerTable } from './customer-table.js';

const storesSchema = z.array(
  z.object({ id: z.string().uuid(), label: z.string() }),
);

/** Presents authorized customer identities from one store and their linked operational history. */
export function ShopifyCustomers(props: AppUiProps) {
  const [stores, setStores] = useState<z.infer<typeof storesSchema>>([]);
  const [chosen, setChosen] = useState(props.customer?.connectionId ?? '');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    props.services
      .request('record-connections', {})
      .then((value) => {
        if (active) {
          setStores(storesSchema.parse(value));
          setPending(false);
        }
      })
      .catch((cause) => {
        if (active) {
          setError(props.services.error(cause));
          setPending(false);
        }
      });

    return () => {
      active = false;
    };
  }, [props.services, attempt]);
  const selected = chosen || stores[0]?.id;
  if (pending) return <p role="status">Loading stores…</p>;
  if (error)
    return (
      <Alert role="alert">
        {error}{' '}
        <Button
          variant="outline"
          onClick={() => {
            setError('');
            setPending(true);
            setAttempt((value) => value + 1);
          }}
        >
          Retry
        </Button>
      </Alert>
    );
  if (!stores.length)
    return (
      <Empty>
        <h2>No active customer source</h2>
        <p>Connect a Shopify store and authorize customer access to start.</p>
        <a href={`/app/${props.organizationId}/apps/shopify`}>Open Shopify</a>
      </Empty>
    );
  if (!stores.some((store) => store.id === selected))
    return (
      <Alert>
        This customer’s source is no longer available.{' '}
        <a href={`/app/${props.organizationId}/customers`}>
          Browse available sources
        </a>
      </Alert>
    );
  const id =
    chosen === props.customer?.connectionId ? props.customer?.id : undefined;

  return (
    <div className="customer-workspace">
      <div className="customer-toolbar">
        <div className="form-field">
          <label htmlFor="customer-store">Source</label>
          <select
            id="customer-store"
            value={selected}
            onChange={(event) => setChosen(event.target.value)}
          >
            {stores.map((store) => (
              <option value={store.id} key={store.id}>
                {store.label}
              </option>
            ))}
          </select>
        </div>
        <p className="field-help">
          Customer identities stay separate across stores.
        </p>
      </div>
      <CustomerRecords
        key={`${props.organizationId}/${selected}/${id ?? ''}`}
        {...props}
        connectionId={selected!}
        id={id}
      />
    </div>
  );
}

function Coverage({ sections }: { sections: ShopifyRecordSection[] }) {
  return sections
    .filter((section) => section.message)
    .map((section) => (
      <Alert key={section.key} role="status">
        <strong>{section.title}</strong>
        <p>{section.message}</p>
      </Alert>
    ));
}

function CustomerRecords({
  connectionId,
  id,
  organizationId,
  services,
}: AppUiProps & { connectionId: string; id: string | undefined }) {
  const [field, setField] = useState<CustomerSearch['field']>('name');
  const [value, setValue] = useState('');
  const [search, setSearch] = useState<CustomerSearch>();
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [selectedOrder, setSelectedOrder] = useState('');
  const read = useCustomerRecord(services, {
    connectionId,
    kind: 'Customer',
    ...(id ? { id } : {}),
    ...(search ? { search } : {}),
    ...(cursors.at(-1) ? { cursor: cursors.at(-1) } : {}),
  });
  const data = read.data;
  const contactUnavailable = data?.sections.some(
    (section) => section.key === 'contact' && section.status !== 'available',
  );
  const searchField = contactUnavailable ? 'order' : field;
  const records = data?.sections.find(
    (section) => section.key === (id ? 'orders' : 'records'),
  );
  const rows = records?.rows ?? [];

  return (
    <section
      className="customer-workspace"
      aria-busy={read.pending}
      aria-label={id ? 'Customer detail' : 'Customer list'}
    >
      {id ? (
        <div className="customer-toolbar">
          <a
            href={`/app/${organizationId}/customers?${new URLSearchParams({ appId: 'shopify', connectionId })}`}
          >
            ← All customers
          </a>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setSelectedOrder('');
              read.refresh();
            }}
            disabled={read.pending}
          >
            Refresh
          </Button>
        </div>
      ) : (
        <form
          className="customer-toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(
              value.trim()
                ? { field: searchField, value: value.trim() }
                : undefined,
            );
            setCursors([undefined]);
            read.refresh();
          }}
        >
          <div className="form-field">
            <label htmlFor="customer-search-field">Search by</label>
            <select
              id="customer-search-field"
              value={searchField}
              onChange={(event) =>
                setField(event.target.value as CustomerSearch['field'])
              }
            >
              <option value="name" disabled={contactUnavailable}>
                Name
              </option>
              <option value="email" disabled={contactUnavailable}>
                Email
              </option>
              <option value="order">Order number</option>
            </select>
          </div>
          <div className="form-field customer-search">
            <label htmlFor="customer-search">
              {searchField === 'order'
                ? 'Order number'
                : searchField === 'email'
                  ? 'Customer email'
                  : 'Customer name'}
            </label>
            <Input
              id="customer-search"
              value={value}
              maxLength={120}
              autoComplete="off"
              placeholder={
                searchField === 'order'
                  ? '#1001'
                  : searchField === 'email'
                    ? 'name@example.com'
                    : 'Find a customer…'
              }
              onChange={(event) => setValue(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={read.pending}>
            Search
          </Button>
          {search ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setValue('');
                setSearch(undefined);
                setCursors([undefined]);
              }}
            >
              Clear
            </Button>
          ) : null}
        </form>
      )}
      {read.pending ? (
        <p role="status">
          {id ? 'Loading customer and order history…' : 'Loading customers…'}
        </p>
      ) : read.error ? (
        <Alert tone="danger" role="alert">
          {read.error}{' '}
          <Button variant="outline" onClick={read.refresh}>
            Retry
          </Button>
        </Alert>
      ) : data ? (
        <>
          {id ? <CustomerSummary data={data} /> : null}
          <Coverage sections={data.sections} />
          {!id && search && rows.length > 1 ? (
            <Alert role="status">
              Multiple customer identities match. Choose the source ID and
              contact details that belong to the customer; these records have
              not been merged.
            </Alert>
          ) : null}
          <div className="customer-section-heading">
            <h2>
              {id
                ? 'Order history'
                : search
                  ? 'Matching customers'
                  : 'Recent customers'}
            </h2>
            <span className="field-help">
              {data.shop} · Page {cursors.length}
            </span>
          </div>
          {records?.status === 'available' ? (
            <CustomerTable
              id={id}
              organizationId={organizationId}
              connectionId={connectionId}
              rows={rows}
              selectedOrder={selectedOrder}
              setSelectedOrder={setSelectedOrder}
            />
          ) : null}
          {cursors.length > 1 || data.nextCursor ? (
            <nav className="customer-toolbar" aria-label="Customer pagination">
              <Button
                variant="outline"
                disabled={cursors.length === 1}
                onClick={() => {
                  setSelectedOrder('');
                  setCursors(cursors.slice(0, -1));
                }}
              >
                Previous
              </Button>
              <span>Page {cursors.length}</span>
              <Button
                variant="outline"
                disabled={!data.nextCursor}
                onClick={() => {
                  setSelectedOrder('');
                  setCursors([...cursors, data.nextCursor ?? undefined]);
                }}
              >
                Next
              </Button>
            </nav>
          ) : null}
          {id &&
          selectedOrder &&
          rows.some((row) => row.id === selectedOrder) ? (
            <CustomerOrder
              key={selectedOrder}
              organizationId={organizationId}
              connectionId={connectionId}
              id={selectedOrder}
              services={services}
            />
          ) : id && rows.length ? (
            <p className="field-help">
              Select an order to inspect fulfillment, returns, refunds, open
              issues and Luma actions.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
