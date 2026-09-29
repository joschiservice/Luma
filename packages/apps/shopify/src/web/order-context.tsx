import type { AppUiProps } from '@luma/app-host/web';
import { Button } from '@luma/ui/components/primitives/button';
import { useState } from 'react';

import type { ShopifyRecordKind } from '../domain/records.js';
import { customerHref, useCustomerRecord } from './customer-data.js';
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
    return (
      <p className="field-help">
        This order has no Shopify order ID, so live Shopify details are not
        available.
      </p>
    );

  return (
    <section
      className="shopify-order-context"
      aria-label="Shopify order details"
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
            Back
          </Button>
        ) : null}
        <p className="field-help">
          {detail
            ? `Read live from ${detail.shop} at ${new Date(detail.observedAt).toLocaleString()}`
            : 'Live Shopify details'}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={read.pending}
          onClick={read.refresh}
          aria-label="Refresh Shopify details"
        >
          Refresh
        </Button>
        {detail ? (
          <a
            className="shopify-admin-link"
            href={`https://${detail.shop}/admin/orders/${numeric}`}
            target="_blank"
            rel="noreferrer"
          >
            Open in Shopify admin
          </a>
        ) : null}
      </div>
      {read.error ? <p role="alert">{read.error}</p> : null}
      {read.pending ? <p role="status">Loading Shopify details…</p> : null}
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
                  Open customer workspace →
                </a>
              ))
            : null}
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
