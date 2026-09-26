import { Plug } from 'lucide-react';

/** Displays the shared connection icon. */
export function ProviderIcon({ provider }: { provider: string }) {
  return <Plug size={20} aria-hidden="true" data-provider={provider} />;
}
