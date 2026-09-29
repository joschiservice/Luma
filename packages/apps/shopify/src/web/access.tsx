import type { AppUiProps } from '@luma/app-host/web';
import { useEffect, useState } from 'react';
import { z } from 'zod';

const accessSchema = z.object({
  customerDataApproved: z.boolean(),
  allOrdersApproved: z.boolean(),
  grantedScopes: z.array(z.string()).nullable(),
  missingScopes: z.array(z.string()),
});

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
    return <p role="alert">Access coverage could not be checked. {error}</p>;
  if (!access) return <p role="status">Checking access coverage…</p>;
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
          ? 'Older-order access is enabled. Available records depend on the store’s retained history.'
          : 'Order history is limited to the last 60 days. Older orders need Shopify approval and renewed authorization.'}
      </p>
      {!customer ? (
        <p>
          Customer context is unavailable until Shopify approves access and the
          store grants permission.
        </p>
      ) : null}
      {access.missingScopes.length ? (
        <p role="status">
          Missing permissions: {access.missingScopes.join(', ')}. Reconnect to
          request access.
        </p>
      ) : null}
    </div>
  );
}
