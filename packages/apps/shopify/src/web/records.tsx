import type { AppUiProps } from '@luma/app-host/web';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { useRef, useState } from 'react';

import {
  recordDetail,
  recordKinds,
  type ShopifyRecordDetail,
  type ShopifyRecordKind,
} from '../domain/records.js';
import { recordError } from './record-error.js';

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
      aria-label="Shopify records"
      aria-busy={pending}
    >
      <h2>Shopify records</h2>
      <p className="field-help">
        Read a record from this store, then follow its linked orders, variants,
        inventory, returns and refunds.
      </p>
      <div className="shopify-record-links">
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => void load('Order')}
        >
          Browse orders
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => void load('Product')}
        >
          Browse products
        </Button>
      </div>
      <details className="shopify-record-lookup">
        <summary>Find by Shopify ID</summary>
        <form
          className="connection-setup-form"
          onSubmit={(event) => {
            event.preventDefault();
            void load(kind, id.trim());
          }}
        >
          <div className="form-field">
            <label htmlFor="shopify-record-kind">Record type</label>
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
                  {value.replace(/([a-z])([A-Z])/g, '$1 $2')}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <label htmlFor="shopify-record-id">Shopify record ID</label>
            <Input
              id="shopify-record-id"
              required
              value={id}
              onChange={(event) => setId(event.target.value)}
              placeholder="Record ID from Shopify"
              disabled={pending}
            />
          </div>
          <Button type="submit" disabled={pending}>
            {pending ? 'Loading record…' : 'Load record'}
          </Button>
        </form>
      </details>
      {message ? <p role="alert">{message}</p> : null}
      {detail ? (
        <div aria-live="polite">
          <p className="field-help">
            {detail.shop} · Read {new Date(detail.observedAt).toLocaleString()}
          </p>
          {detail.sections.map((section) => (
            <section
              key={section.key}
              className="shopify-record-section"
              aria-label={section.title}
            >
              <h3>{section.title}</h3>
              {section.message ? (
                <p className="shopify-coverage-message" role="status">
                  {section.message}
                </p>
              ) : null}
              {section.status === 'available' && section.rows.length === 0 ? (
                <p className="field-help">No records returned by Shopify.</p>
              ) : null}
              {section.rows.map((row) => (
                <article key={row.id} className="shopify-source-record">
                  <p className="shopify-source-id">{row.id}</p>
                  <dl>
                    {Object.entries(row.fields).map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>
                          {value === null
                            ? 'Not provided'
                            : typeof value === 'boolean'
                              ? value
                                ? 'Yes'
                                : 'No'
                              : String(value)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {row.sourceUpdatedAt ? (
                    <p className="field-help">
                      Updated in Shopify{' '}
                      {new Date(row.sourceUpdatedAt).toLocaleString()}
                    </p>
                  ) : null}
                  <div className="shopify-record-links">
                    {row.links
                      .filter((link) => link.id !== detail.id)
                      .map((link) => (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          key={`${link.kind}:${link.id}`}
                          onClick={() => void load(link.kind, link.id)}
                          disabled={pending}
                        >
                          {link.label}
                        </Button>
                      ))}
                  </div>
                </article>
              ))}
            </section>
          ))}
          {detail.nextCursor ? (
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() =>
                void load(detail.kind, '', detail.nextCursor ?? undefined)
              }
            >
              Next page
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
