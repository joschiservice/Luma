import type { AppUiProps } from '@luma/app-host/web';
import { Button } from '@luma/ui/components/primitives/button';
import { useEffect, useRef, useState } from 'react';

import {
  recordDetail,
  type ShopifyRecordDetail,
  type ShopifyRecordKind,
} from '../domain/records.js';
import { recordError } from './record-error.js';
import { ShopifyRecordSections } from './sections.js';

const orderId = /^gid:\/\/shopify\/Order\/(\d+)$/;

/**
 * Reads one order live from Shopify with the connection's current scopes, then follows its
 * customer, fulfillment, return and refund links in place.
 */
export function ShopifyOrderContext({
  record,
  services,
}: {
  record: NonNullable<AppUiProps['record']>;
  services: AppUiProps['services'];
}) {
  const [trail, setTrail] = useState<{ kind: ShopifyRecordKind; id: string }[]>(
    [{ kind: 'Order', id: record.externalId }],
  );
  const [detail, setDetail] = useState<ShopifyRecordDetail | null>(null);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const current = trail.at(-1)!;
  const numeric = orderId.exec(record.externalId)?.[1];

  useEffect(() => {
    if (!numeric) return;
    const request = ++generation.current;
    setPending(true);
    setMessage('');
    services
      .request('records', {
        connectionId: record.connectionId,
        kind: current.kind,
        id: current.id,
      })
      .then((value) => {
        if (generation.current === request)
          setDetail(recordDetail.parse(value));
      })
      .catch((error) => {
        if (generation.current === request) {
          setDetail(null);
          setMessage(recordError(error, services.error));
        }
      })
      .finally(() => {
        if (generation.current === request) setPending(false);
      });
  }, [
    services,
    record.connectionId,
    current.kind,
    current.id,
    numeric,
    attempt,
  ]);

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
      aria-busy={pending}
    >
      <div className="shopify-order-context-head">
        {trail.length > 1 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => setTrail(trail.slice(0, -1))}
          >
            Back
          </Button>
        ) : null}
        <p className="field-help">
          {detail
            ? `Read live from ${detail.shop} at ${new Date(detail.observedAt).toLocaleString()}`
            : 'Reading live from Shopify…'}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => setAttempt((value) => value + 1)}
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
      {message ? <p role="alert">{message}</p> : null}
      {pending && !detail ? (
        <p role="status">Loading Shopify details…</p>
      ) : null}
      {detail ? (
        <div aria-live="polite">
          <ShopifyRecordSections
            detail={detail}
            pending={pending}
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
