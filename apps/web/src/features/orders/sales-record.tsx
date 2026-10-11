import type { OrderDetail, SalesAddress, SalesOrder } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardList } from 'lucide-react';
import { useState } from 'react';

import { contextOptions } from '../../kit/identity/data';
import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { OrderSection } from '../../shared/orders/order-section';

const api = createWebApiClient();

/** Shows released sales intake and records only to people with sales and import permission. */
export function SalesRecord({
  organizationId,
  detail,
}: {
  organizationId: string;
  detail: OrderDetail;
}) {
  const context = useQuery(contextOptions(organizationId));
  const availability = useQuery({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'sales-availability'],
    queryFn: ({ signal }) =>
      api.sales.availability({ params: { organizationId } }, { signal }),
  });
  const permitted =
    context.data?.permissions.includes('sales.manage') &&
    context.data.permissions.includes('sync.manage');
  if (!availability.data?.enabled || !permitted) return null;

  return (
    <ReleasedSalesRecord organizationId={organizationId} detail={detail} />
  );
}

function ReleasedSalesRecord({
  organizationId,
  detail,
}: {
  organizationId: string;
  detail: OrderDetail;
}) {
  const orderId = detail.order.id;
  const params = { organizationId, orderId };
  const client = useQueryClient();
  const query = useQuery({
    ...privateQueryDefaults,
    queryKey: [
      'private',
      'organization',
      organizationId,
      'sales-order',
      orderId,
    ],
    queryFn: ({ signal }) => api.sales.get({ params }, { signal }),
  });
  const accept = useMutation({
    mutationFn: (connectionId: string) =>
      api.sales.accept({ params, body: { connectionId } }),
    onSuccess: async () => {
      await client.invalidateQueries({
        queryKey: ['private', 'organization', organizationId],
      });
    },
  });
  const source = detail.sources.find((source) => source.system === 'shopify');
  if (query.isPending) return <Alert>{m.orders_sales_loading()}</Alert>;
  if (query.isError)
    return (
      <Alert tone="warning">
        {m.orders_sales_unavailable()}
        <Button variant="outline" onClick={() => void query.refetch()}>
          {m.records_refresh()}
        </Button>
      </Alert>
    );
  if (!query.data)
    return source ? (
      <OrderSection
        title={m.orders_sales_title()}
        icon={ClipboardList}
        description={m.orders_sales_intro()}
      >
        <Button
          disabled={accept.isPending}
          onClick={() => accept.mutate(source.connectionId)}
        >
          {m.orders_sales_accept()}
        </Button>
        {accept.isError ? (
          <Alert tone="warning">{m.orders_sales_error()}</Alert>
        ) : null}
      </OrderSection>
    ) : null;
  const record = query.data;
  const editable = ['order_lifecycle', 'order_lines'].every((group) =>
    detail.authority.groups.some(
      (fact) =>
        fact.group === group &&
        fact.basis === 'override' &&
        fact.connectionId === record.connectionId &&
        fact.state === 'resolved',
    ),
  );

  return (
    <SalesEditor
      key={`${record.id}:${record.version}`}
      record={record}
      editable={editable}
      organizationId={organizationId}
    />
  );
}

function SalesEditor({
  record,
  editable,
  organizationId,
}: {
  record: SalesOrder;
  editable: boolean;
  organizationId: string;
}) {
  const [status, setStatus] = useState(record.status);
  const [lines, setLines] = useState(
    record.lines.map((line) => ({
      id: line.id,
      currentQuantity: line.currentQuantity,
    })),
  );
  const [billing, setBilling] = useState(record.billingAddress);
  const [shipping, setShipping] = useState(record.shippingAddress);
  const [commandId, setCommandId] = useState(() => crypto.randomUUID());
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: () =>
      api.sales.edit({
        params: { organizationId, orderId: record.orderId },
        body: {
          commandId,
          version: record.version,
          status,
          lines,
          billingAddress: billing,
          shippingAddress: shipping,
        },
      }),
    onSuccess: async () => {
      setCommandId(crypto.randomUUID());
      await client.invalidateQueries({
        queryKey: ['private', 'organization', organizationId],
      });
    },
  });

  return (
    <OrderSection title={m.orders_sales_title()} icon={ClipboardList}>
      {!editable ? <Alert>{m.orders_sales_authority()}</Alert> : null}
      <form
        className="sales-record-form"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <fieldset disabled={!editable || save.isPending}>
          <label>
            {m.orders_sales_status()}
            <Select
              value={status}
              onValueChange={(value) => {
                if (value) setStatus(value);
              }}
              options={[
                { value: 'open', label: m.orders_status_open() },
                { value: 'completed', label: m.orders_status_completed() },
                { value: 'cancelled', label: m.orders_status_cancelled() },
              ]}
            />
          </label>
          {record.lines.map((line, index) => (
            <label key={line.id}>
              {line.skuCode ?? line.title ?? line.id} ·{' '}
              {m.orders_sales_quantity()}
              <Input
                inputMode="decimal"
                required
                pattern="[0-9]+([.][0-9]{1,6})?"
                value={lines[index]?.currentQuantity ?? ''}
                onChange={(event) =>
                  setLines((current) =>
                    current.map((item) =>
                      item.id === line.id
                        ? { ...item, currentQuantity: event.target.value }
                        : item,
                    ),
                  )
                }
              />
            </label>
          ))}
          <AddressEditor
            title={m.orders_sales_billing()}
            value={billing}
            change={setBilling}
          />
          <AddressEditor
            title={m.orders_sales_shipping()}
            value={shipping}
            change={setShipping}
          />
          <Button type="submit">{m.orders_sales_save()}</Button>
        </fieldset>
        {save.isError ? (
          <Alert tone="warning">{m.orders_sales_error()}</Alert>
        ) : null}
        {save.isSuccess ? <Alert>{m.orders_sales_saved()}</Alert> : null}
      </form>
    </OrderSection>
  );
}

const emptyAddress: SalesAddress = {
  name: '',
  company: '',
  street: '',
  city: '',
  postalCode: '',
  country: '',
};

function AddressEditor({
  title,
  value,
  change,
}: {
  title: string;
  value: SalesAddress | null;
  change(value: SalesAddress): void;
}) {
  const labels: Record<keyof SalesAddress, () => string> = {
    name: m.orders_sales_name,
    company: m.orders_sales_company,
    street: m.orders_sales_street,
    city: m.orders_sales_city,
    postalCode: m.orders_sales_postal,
    country: m.orders_sales_country,
  };

  return (
    <Disclosure>
      <summary>{title}</summary>
      <fieldset>
        <legend className="sr-only">{title}</legend>
        {(Object.keys(labels) as (keyof SalesAddress)[]).map((field) => (
          <label key={field}>
            {labels[field]()}
            <Input
              value={value?.[field] ?? ''}
              maxLength={field === 'country' ? 2 : 200}
              required={field === 'country' && value !== null}
              pattern={field === 'country' ? '[A-Z]{2}' : undefined}
              onChange={(event) =>
                change({
                  ...(value ?? emptyAddress),
                  [field]:
                    field === 'country'
                      ? event.target.value.toUpperCase()
                      : event.target.value,
                })
              }
            />
          </label>
        ))}
      </fieldset>
    </Disclosure>
  );
}
