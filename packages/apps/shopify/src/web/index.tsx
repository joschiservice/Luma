import './records.css';

import type { AppUiProps } from '@luma/app-host/web';
import { m } from '@luma/i18n/messages';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { useForm } from '@tanstack/react-form';
import { useRef, useState } from 'react';
import { z } from 'zod';

import { ShopifyAccess } from './access.js';
import { ShopifyFulfillmentRecovery } from './fulfillment-recovery.js';
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
  if (props.slot === 'fulfillment')
    return props.fulfillment ? (
      <ShopifyFulfillmentRecovery
        key={`${props.fulfillment.connectionId}:${props.fulfillment.fulfillmentId}`}
        connectionId={props.fulfillment.connectionId}
        orderId={props.fulfillment.orderId}
        fulfillmentOrderId={props.fulfillment.fulfillmentId}
        services={props.services}
        headingLevel={3}
      />
    ) : null;
  if (props.slot === 'record')
    return props.record ? (
      <ShopifyOrderContext
        record={props.record}
        services={props.services}
        organizationId={props.organizationId}
        canEdit={props.can('shopify:order_edits.apply')}
      />
    ) : null;

  if (props.slot === 'page') return <ShopifyRecordPage {...props} />;

  // Without OAuth, such as in the simulator, a store reconnects with a new access token.
  return props.connection?.management?.includes('rotate') &&
    props.connection.status !== 'disconnected' ? (
    <ShopifyToken {...props} />
  ) : (
    <ShopifyAuthorization {...props} />
  );
}

/** Replaces a token-based store's access token, which also reconnects a revoked store. */
function ShopifyToken({ connection, services, done }: AppUiProps) {
  const [token, setToken] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  if (!connection) return null;

  return (
    <form
      className="connection-setup-form"
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending || !token.trim()) return;
        setPending(true);
        setMessage('');
        services
          .rotate(connection, { token: token.trim() })
          .then(done)
          .catch((error: unknown) => setMessage(services.error(error)))
          .finally(() => {
            setToken('');
            setPending(false);
          });
      }}
    >
      <p className="field-help">
        {m.shopify_token_help({ shop: connection.target.shop ?? '' })}
      </p>
      <div className="form-field">
        <label htmlFor="shopify-token">{m.shopify_token_label()}</label>
        <Input
          id="shopify-token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          required
          disabled={pending}
        />
      </div>
      <p role="alert">{message}</p>
      <Button type="submit" disabled={pending || !token.trim()}>
        {pending ? m.common_saving() : m.shopify_token_save()}
      </Button>
    </form>
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
        <p className="field-help">{m.shopify_authorize_help()}</p>
        <ShopifyAccess services={services} connectionId={connection?.id} />
        {(['label', 'shop'] as const).map((name) => (
          <form.Field key={name} name={name}>
            {(field) => (
              <div className="form-field">
                <label htmlFor={`shopify-${name}`}>
                  {name === 'shop'
                    ? m.shopify_authorize_label_shop()
                    : m.shopify_authorize_label_name()}
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
                    name === 'shop'
                      ? m.shopify_authorize_shop_placeholder()
                      : undefined
                  }
                />
              </div>
            )}
          </form.Field>
        ))}
        <p role="alert">{message}</p>
        <Button type="submit" disabled={pending}>
          {pending
            ? m.shopify_authorize_opening()
            : m.shopify_authorize_continue()}
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
