import type { AppUiProps } from '@luma/app-host/web';
import { formatDateTime } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Button } from '@luma/ui/components/primitives/button';
import { useState } from 'react';

import type { ShopifyRecordKind } from '../domain/records.js';
import { customerHref, useCustomerRecord } from './customer-data.js';
import { ShopifyFulfillmentRecovery } from './fulfillment-recovery.js';
import { ShopifyRecordSections } from './sections.js';

const orderId = /^gid:\/\/shopify\/Order\/(\d+)$/;

/** Reads live order context with current permissions and follows source records or the customer workspace. */
export function ShopifyOrderContext({
  record,
  services,
  organizationId,
}: {
  record: NonNullable<AppUiProps['record']>;
  services: AppUiProps['services'];
  organizationId?: string;
}) {
  const [trail, setTrail] = useState<{ kind: ShopifyRecordKind; id: string }[]>(
    [{ kind: 'Order', id: record.externalId }],
  );
  const current = trail.at(-1)!;
  const numeric = orderId.exec(record.externalId)?.[1];
  const read = useCustomerRecord(
    services,
    numeric
      ? {
          connectionId: record.connectionId,
          kind: current.kind,
          id: current.id,
        }
      : null,
  );
  const detail = read.data;
  const customers = new Map(
    detail?.sections.flatMap((section) =>
      section.rows.flatMap((row) =>
        row.links
          .filter((link) => link.kind === 'Customer')
          .map((link) => [link.id, link] as const),
      ),
    ),
  );
  if (!numeric)
    return <p className="field-help">{m.shopify_context_no_order_id()}</p>;

  return (
    <section
      className="shopify-order-context"
      aria-label={m.shopify_context_label()}
      aria-busy={read.pending}
    >
      <div className="shopify-order-context-head">
        {trail.length > 1 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setTrail(trail.slice(0, -1))}
          >
            {m.common_back()}
          </Button>
        ) : null}
        <p className="field-help">
          {detail
            ? m.shopify_context_read_at({
                shop: detail.shop,
                time: formatDateTime(detail.observedAt),
              })
            : m.shopify_context_live()}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={read.pending}
          onClick={read.refresh}
          aria-label={m.shopify_context_refresh_label()}
        >
          {m.common_refresh()}
        </Button>
        {detail ? (
          <a
            className="shopify-admin-link"
            href={`https://${detail.shop}/admin/orders/${numeric}`}
            target="_blank"
            rel="noreferrer"
          >
            {m.shopify_context_open_admin()}
          </a>
        ) : null}
      </div>
      {read.error ? <p role="alert">{read.error}</p> : null}
      {read.pending ? <p role="status">{m.shopify_context_loading()}</p> : null}
      {detail ? (
        <div aria-live="polite">
          {organizationId
            ? [...customers.values()].map((link) => (
                <a
                  key={link.id}
                  href={customerHref(
                    organizationId,
                    record.connectionId,
                    link.id,
                  )}
                >
                  {m.shopify_context_open_customer()}
                </a>
              ))
            : null}
          {current.kind === 'FulfillmentOrder' ? (
            <ShopifyFulfillmentRecovery
              key={`${record.connectionId}:${current.id}`}
              connectionId={record.connectionId}
              orderId={record.externalId}
              fulfillmentOrderId={current.id}
              services={services}
              headingLevel={4}
            />
          ) : null}
          <ShopifyRecordSections
            detail={detail}
            pending={read.pending}
            headingLevel={4}
            follow={(link) =>
              setTrail([...trail, { kind: link.kind, id: link.id }])
            }
          />
        </div>
      ) : null}
    </section>
  );
}
