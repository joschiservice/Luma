import type { AppUiProps } from '@luma/app-host/web';
import { m } from '@luma/i18n/messages';
import { Button } from '@luma/ui/components/primitives/button';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { ShopifyRecords } from './records.js';

const connections = z.array(
  z.object({ id: z.string().uuid(), label: z.string() }),
);

/** Opens Shopify records for an active store in the current workspace. */
export function ShopifyRecordPage({
  services,
  organizationId,
  can,
}: AppUiProps) {
  const [stores, setStores] = useState<z.infer<typeof connections>>([]);
  const [selected, setSelected] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void services
      .request('record-connections', {})
      .then((value) => {
        if (!active) return;
        const list = connections.parse(value);
        setStores(list);
        setSelected(list[0]?.id ?? '');
        setMessage('');
      })
      .catch((error) => {
        if (active) {
          setStores([]);
          setSelected('');
          setMessage(services.error(error));
        }
      })
      .finally(() => {
        if (active) setPending(false);
      });

    return () => {
      active = false;
    };
  }, [services, organizationId, attempt]);

  return (
    <main className="shopify-record-page">
      <h1>Shopify</h1>
      <p className="field-help">{m.shopify_page_description()}</p>
      {pending ? (
        <p role="status">{m.shopify_page_loading()}</p>
      ) : message ? (
        <>
          <p role="alert">{message}</p>
          <Button
            onClick={() => {
              setPending(true);
              setAttempt((value) => value + 1);
            }}
          >
            {m.common_try_again()}
          </Button>
        </>
      ) : stores.length === 0 ? (
        <p>{m.shopify_page_empty()}</p>
      ) : (
        <>
          <div className="form-field">
            <label htmlFor="shopify-store">
              {m.shopify_page_store_label()}
            </label>
            <select
              id="shopify-store"
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
            >
              {stores.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.label}
                </option>
              ))}
            </select>
          </div>
          <ShopifyRecords
            key={`${organizationId}:${selected}`}
            connectionId={selected}
            services={services}
            canEdit={can('shopify:order_edits.apply')}
          />
        </>
      )}
    </main>
  );
}
