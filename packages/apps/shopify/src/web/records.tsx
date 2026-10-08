import type { AppUiProps } from '@luma/app-host/web';
import { formatDateTime } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { useRef, useState } from 'react';

import {
  recordDetail,
  recordKinds,
  type ShopifyRecordDetail,
  type ShopifyRecordKind,
} from '../domain/records.js';
import { ShopifyFulfillmentRecovery } from './fulfillment-recovery.js';
import { recordError } from './record-error.js';
import { ShopifyRecordSections } from './sections.js';

const kindLabels = {
  Order: m.shopify_kind_order,
  Customer: m.shopify_kind_customer,
  Product: m.shopify_kind_product,
  ProductVariant: m.shopify_kind_product_variant,
  InventoryItem: m.shopify_kind_inventory_item,
  FulfillmentOrder: m.shopify_kind_fulfillment_order,
  Return: m.shopify_kind_return,
  Refund: m.shopify_kind_refund,
} satisfies Record<ShopifyRecordKind, () => string>;

/** Shows live Shopify records and follows source links within the selected connection. */
export function ShopifyRecords({
  connectionId,
  services,
}: {
  connectionId: string;
  services: AppUiProps['services'];
}) {
  const [kind, setKind] = useState<ShopifyRecordKind>('Order');
  const [id, setId] = useState('');
  const [detail, setDetail] = useState<ShopifyRecordDetail | null>(null);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const generation = useRef(0);

  async function load(
    nextKind: ShopifyRecordKind,
    nextId = '',
    cursor?: string,
  ) {
    const request = ++generation.current;
    setPending(true);
    setMessage('');
    setDetail(null);
    setKind(nextKind);
    setId(nextId);
    try {
      const data = recordDetail.parse(
        await services.request('records', {
          connectionId,
          kind: nextKind,
          ...(nextId
            ? {
                id: /^\d+$/.test(nextId)
                  ? `gid://shopify/${nextKind}/${nextId}`
                  : nextId,
              }
            : {}),
          ...(cursor ? { cursor } : {}),
        }),
      );
      if (generation.current === request) setDetail(data);
    } catch (error) {
      if (generation.current === request)
        setMessage(recordError(error, services.error));
    } finally {
      if (generation.current === request) setPending(false);
    }
  }

  return (
    <section
      className="shopify-records"
      aria-label={m.shopify_records_title()}
      aria-busy={pending}
    >
      <h2>{m.shopify_records_title()}</h2>
      <p className="field-help">{m.shopify_records_help()}</p>
      <div className="shopify-record-links">
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => void load('Order')}
        >
          {m.shopify_records_browse_orders()}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => void load('Product')}
        >
          {m.shopify_records_browse_products()}
        </Button>
      </div>
      <details className="shopify-record-lookup">
        <summary>{m.shopify_records_lookup()}</summary>
        <form
          className="connection-setup-form"
          onSubmit={(event) => {
            event.preventDefault();
            void load(kind, id.trim());
          }}
        >
          <div className="form-field">
            <label htmlFor="shopify-record-kind">
              {m.shopify_records_kind_label()}
            </label>
            <select
              id="shopify-record-kind"
              value={kind}
              disabled={pending}
              onChange={(event) =>
                setKind(event.target.value as ShopifyRecordKind)
              }
            >
              {recordKinds.map((value) => (
                <option key={value} value={value}>
                  {kindLabels[value]()}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <label htmlFor="shopify-record-id">
              {m.shopify_records_id_label()}
            </label>
            <Input
              id="shopify-record-id"
              required
              value={id}
              onChange={(event) => setId(event.target.value)}
              placeholder={m.shopify_records_id_placeholder()}
              disabled={pending}
            />
          </div>
          <Button type="submit" disabled={pending}>
            {pending ? m.shopify_records_loading() : m.shopify_records_load()}
          </Button>
        </form>
      </details>
      {message ? <p role="alert">{message}</p> : null}
      {detail ? (
        <div aria-live="polite">
          <p className="field-help">
            {m.shopify_records_read_at({
              shop: detail.shop,
              time: formatDateTime(detail.observedAt),
            })}
          </p>
          {detail.kind === 'FulfillmentOrder'
            ? detail.sections
                .flatMap((section) => section.rows.flatMap((row) => row.links))
                .filter((link) => link.kind === 'Order')
                .slice(0, 1)
                .map((link) => (
                  <ShopifyFulfillmentRecovery
                    key={`${connectionId}:${detail.id}`}
                    connectionId={connectionId}
                    orderId={link.id}
                    fulfillmentOrderId={detail.id}
                    services={services}
                    headingLevel={3}
                  />
                ))
            : null}
          <ShopifyRecordSections
            detail={detail}
            pending={pending}
            follow={(link) => void load(link.kind, link.id)}
          />
          {detail.nextCursor ? (
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() =>
                void load(detail.kind, '', detail.nextCursor ?? undefined)
              }
            >
              {m.shopify_records_next_page()}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
