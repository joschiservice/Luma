import { useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { Button } from '@luma/ui/button';
import { Input } from '@luma/ui/components/input';
import { createWebApiClient } from '../../lib/api-client';
import { IdentityError } from '../identity/data';
import { connectionError } from './data';

const api = createWebApiClient();
export function ShopifyForm({
  organizationId,
  shop = '',
  label = '',
}: {
  organizationId: string;
  shop?: string;
  label?: string;
}) {
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
        const result = await api.connections.shopifyStart({
          params: { organizationId },
          body: {
            shop: value.shop.trim().toLowerCase(),
            label: value.label.trim(),
          },
        });
        if (result.status !== 200) throw new IdentityError(result.status);
        const url = new URL(result.body.authorizationUrl);
        if (
          url.protocol !== 'https:' ||
          url.hostname !== value.shop.trim().toLowerCase() ||
          url.pathname !== '/admin/oauth/authorize'
        )
          throw new Error('Invalid authorization URL');
        window.location.assign(url.href);
      } catch (error) {
        setMessage(
          error instanceof IdentityError &&
            (error.status === 422 || error.status === 400)
            ? 'Enter a connection name and a valid myshopify.com hostname.'
            : connectionError(error),
        );
        setPending(false);
        lock.current = false;
      }
    },
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
      aria-busy={pending}
    >
      <p className="field-help">
        Approve read access to orders, products, inventory and fulfillment in
        Shopify. You can cancel before approving.
      </p>
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
  );
}
