import './access.css';

import { shopifyAccessSchema as accessSchema } from '@luma/api-contract';
import type { AppUiProps } from '@luma/app-host/web';
import { formatDateTime, formatList } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { useEffect, useState } from 'react';
import { z } from 'zod';

const scopeLabels: Record<string, () => string> = {
  read_orders: m.shopify_scope_orders,
  read_all_orders: m.shopify_scope_all_orders,
  read_products: m.shopify_scope_products,
  read_inventory: m.shopify_scope_inventory,
  write_inventory: m.shopify_scope_inventory_write,
  read_merchant_managed_fulfillment_orders: m.shopify_scope_fulfillment,
  read_assigned_fulfillment_orders: m.shopify_scope_fulfillment,
  read_third_party_fulfillment_orders: m.shopify_scope_fulfillment,
  write_merchant_managed_fulfillment_orders: m.shopify_scope_fulfillment_write,
  write_third_party_fulfillment_orders: m.shopify_scope_fulfillment_write,
  write_order_edits: m.shopify_scope_order_edits_write,
  read_returns: m.shopify_scope_returns,
  read_locations: m.shopify_scope_locations,
  read_customers: m.shopify_scope_customers,
};

/** Names missing Shopify scopes as the data they cover, once each; unknown scopes keep their name. */
function missingAccess(scopes: string[]) {
  return formatList([
    ...new Set(scopes.map((scope) => scopeLabels[scope]?.() ?? scope)),
  ]);
}

/** Shows approval limits and the last recorded Shopify grants before authorization. */
export function ShopifyAccess({
  services,
  connectionId,
}: {
  services: AppUiProps['services'];
  connectionId?: string | undefined;
}) {
  const [access, setAccess] = useState<z.infer<typeof accessSchema> | null>(
    null,
  );
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setAccess(null);
    setError('');
    void services
      .request('access', connectionId ? { connectionId } : {})
      .then((value) => {
        if (active) setAccess(accessSchema.parse(value));
      })
      .catch((reason) => {
        if (active) setError(services.error(reason));
      });

    return () => {
      active = false;
    };
  }, [services, connectionId]);
  if (error)
    return <p role="alert">{m.shopify_access_check_failed({ error })}</p>;
  if (!access) return <p role="status">{m.shopify_access_checking()}</p>;
  const history = connectionId
    ? access.grantedScopes?.includes('read_all_orders')
    : access.allOrdersApproved;
  const customer =
    access.customerDataApproved &&
    (!connectionId || access.grantedScopes?.includes('read_customers'));

  return (
    <div className="field-help">
      {connectionId ? (
        <Disclosure className="shopify-subscriptions">
          <summary>{m.shopify_subscriptions_title()}</summary>
          <p>{m.shopify_subscriptions_help()}</p>
          <ul>
            {access.subscriptions.map((subscription) => (
              <li key={subscription.topic}>
                <span>{subscription.topic}</span>
                {': '}
                {{
                  registered: m.shopify_subscriptions_registered,
                  missing: m.shopify_subscriptions_missing,
                  failed: m.shopify_subscriptions_failed,
                  unavailable: m.shopify_subscriptions_unavailable,
                }[subscription.status]()}
                {' · '}
                {subscription.lastReceivedAt
                  ? m.shopify_subscriptions_received({
                      time: formatDateTime(subscription.lastReceivedAt),
                    })
                  : m.shopify_subscriptions_no_delivery()}
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
      <p>
        {history
          ? m.shopify_access_history_full()
          : m.shopify_access_history_limited()}
      </p>
      {!customer ? <p>{m.shopify_access_customers_unavailable()}</p> : null}
      {access.missingScopes.length ? (
        <p role="status">
          {m.shopify_access_missing({
            permissions: missingAccess(access.missingScopes),
          })}
        </p>
      ) : null}
    </div>
  );
}
