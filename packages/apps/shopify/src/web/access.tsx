import type { AppUiProps } from '@luma/app-host/web';
import { formatList } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { useEffect, useState } from 'react';
import { z } from 'zod';

const accessSchema = z.object({
  customerDataApproved: z.boolean(),
  allOrdersApproved: z.boolean(),
  grantedScopes: z.array(z.string()).nullable(),
  missingScopes: z.array(z.string()),
});

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
