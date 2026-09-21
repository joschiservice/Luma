import { Cloud, Server, Store } from 'lucide-react';

import type { Provider } from './presentation';

/** Identifies the provider type with a decorative icon beside its name. */
export function ProviderIcon({ provider }: { provider: Provider }) {
  const Icon =
    provider === 'shopify' ? Store : provider === 'jtl-cloud' ? Cloud : Server;

  return (
    <span
      className={`connection-provider-icon connection-provider-${provider}`}
    >
      <Icon size={20} aria-hidden="true" />
    </span>
  );
}
