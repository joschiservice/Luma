import './records.css';

import type { AppUiProps } from '@luma/app-host/web';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { useForm } from '@tanstack/react-form';
import { useRef, useState } from 'react';
import { z } from 'zod';

import { ShopifyAccess } from './access.js';
import { ShopifyCustomers } from './customers.js';
import { ShopifyInventoryCorrection } from './inventory-correction.js';
import { ShopifyOrderContext } from './order-context.js';
import { ShopifyRecordPage } from './record-page.js';
import { ShopifyRecords } from './records.js';

/** Renders Shopify authorization, the record browser page or live context for a host record. */
export default function ShopifySettings(props: AppUiProps) {
  if (props.slot === 'inventory')
    return props.inventory ? (
      <ShopifyInventoryCorrection
        key={props.inventory.positionId}
        positionId={props.inventory.positionId}
        services={props.services}
      />
    ) : null;
  if (props.slot === 'customers') return <ShopifyCustomers {...props} />;
  if (props.slot === 'record')
    return props.record ? (
      <ShopifyOrderContext
        record={props.record}
        services={props.services}
        organizationId={props.organizationId}
      />
    ) : null;

  return props.slot === 'page' ? (
    <ShopifyRecordPage {...props} />
  ) : (
    <ShopifyAuthorization {...props} />
  );
}

function ShopifyAuthorization(props: AppUiProps) {
  const { connection, services } = props;
  const shop = connection?.target.shop ?? '';
  const label = connection?.label ?? '';
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const form = useForm({
    defaultValues: { shop, label },
    onSubmit: async ({ value }) => {
      if (lock.current) return;
      lock.current = true;
      setPending(true);
      setMessage('');
      try {
        const result = z.object({ authorizationUrl: z.string().url() }).parse(
          await services.request('authorize', {
            shop: value.shop.trim().toLowerCase(),
            label: value.label.trim(),
          }),
        );
        const url = new URL(result.authorizationUrl);
        if (
          url.protocol !== 'https:' ||
          url.hostname !== value.shop.trim().toLowerCase() ||
          url.pathname !== '/admin/oauth/authorize'
        )
          throw new Error('Invalid authorization URL');
        window.location.assign(url.href);
      } catch (error) {
        setMessage(services.error(error));
        setPending(false);
        lock.current = false;
      }
    },
  });

  return (
    <>
      <form
        className="connection-setup-form"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
        aria-busy={pending}
      >
        <p className="field-help">
          Approve read access to orders, products, inventory, returns and
          fulfillment in Shopify. You can cancel before approving.
        </p>
        <ShopifyAccess services={services} connectionId={connection?.id} />
        {(['label', 'shop'] as const).map((name) => (
          <form.Field key={name} name={name}>
            {(field) => (
              <div className="form-field">
                <label htmlFor={`shopify-${name}`}>
                  {name === 'shop' ? 'Shop hostname' : 'Connection name'}
                </label>
                <Input
                  id={`shopify-${name}`}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  onBlur={field.handleBlur}
                  required
                  maxLength={name === 'shop' ? 253 : 120}
                  disabled={pending || (name === 'shop' && !!shop)}
                  placeholder={
                    name === 'shop' ? 'your-store.myshopify.com' : undefined
                  }
                />
              </div>
            )}
          </form.Field>
        ))}
        <p role="alert">{message}</p>
        <Button type="submit" disabled={pending}>
          {pending ? 'Opening Shopify…' : 'Continue to Shopify'}
        </Button>
      </form>
      {connection?.status === 'active' ? (
        <ShopifyRecords
          key={connection.id}
          connectionId={connection.id}
          services={services}
        />
      ) : null}
    </>
  );
}
