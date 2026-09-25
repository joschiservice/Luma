import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Empty } from '@luma/ui/components/primitives/empty';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import { Plug, Plus, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { SignInRedirect } from '../identity/common';
import { contextOptions, IdentityError } from '../identity/data';
import { ConnectionCard } from './connection-card';
import { connectionError, connectionsOptions } from './data';
import { type Provider, providers } from './presentation';
import { ProviderIcon } from './provider-icon';
import { SetupForm } from './setup-form';
import { ShopifyForm } from './shopify';

/**
 * Reads the workspace and OAuth result from the route and resets connection state when the
 * workspace changes.
 */
export function ConnectionsPage() {
  const { organizationId } = useParams({ from: '/app/$organizationId' });
  const { shopify } = useSearch({ from: '/app/$organizationId/connections' });

  return (
    <Connections
      key={organizationId}
      organizationId={organizationId}
      shopifyResult={shopify}
    />
  );
}

/** Lists workspace connections and offers setup actions to owners and admins. */
export function Connections({
  organizationId,
  shopifyResult,
}: {
  organizationId: string;
  shopifyResult?: string | undefined;
}) {
  const access = useQuery(contextOptions(organizationId));
  const query = useQuery(connectionsOptions(organizationId));
  const client = useQueryClient();
  const [provider, setProvider] = useState<Provider | null>(null);
  const [message, setMessage] = useState('');
  const canManage =
    access.data?.actor.role === 'owner' || access.data?.actor.role === 'admin';
  const refresh = async () => {
    await client.invalidateQueries({
      queryKey: connectionsOptions(organizationId).queryKey,
    });
  };
  const error = access.error ?? query.error;
  if (error instanceof IdentityError && error.status === 401)
    return <SignInRedirect />;

  return (
    <div className="connections-page">
      <h1>Connections</h1>
      {shopifyResult ? (
        <p role="status">
          {shopifyResult === 'connected'
            ? 'Shopify connected. Read access is ready.'
            : shopifyResult === 'denied'
              ? 'Shopify access was not approved. Connect again when ready.'
              : shopifyResult === 'permissions'
                ? 'Shopify needs attention. Confirm the requested permissions and reconnect.'
                : 'Shopify authorization could not be completed. Connect again.'}
        </p>
      ) : null}
      <p className="desk-intro">
        Connect your commerce systems. See what Luma is permitted to read and
        change.
      </p>
      <section
        aria-labelledby="installed-title"
        className="connections-section"
      >
        <div className="connections-heading">
          <h2 id="installed-title">
            <Plug size={17} aria-hidden="true" /> Installed in this workspace
          </h2>
          <Button
            variant="outline"
            disabled={query.isFetching}
            onClick={() => void refresh()}
          >
            <RefreshCw size={14} aria-hidden="true" />
            {query.isFetching ? 'Refreshing…' : 'Refresh list'}
          </Button>
        </div>
        {error ? (
          <p role="alert">{connectionError(error)}</p>
        ) : query.isPending || access.isPending ? (
          <p role="status">Loading connections…</p>
        ) : (
          <>
            {!canManage ? (
              <Alert className="connection-notice">
                You can view connections. An owner or admin must manage setup
                and credentials.
              </Alert>
            ) : null}
            {query.data?.length === 0 ? (
              <Empty className="connection-empty">
                <h3>No connections yet</h3>
                <p>Choose a system below to start observing your operations.</p>
              </Empty>
            ) : (
              <div className="connection-list">
                {query.data?.map((connection) => (
                  <ConnectionCard
                    key={connection.id}
                    connection={connection}
                    organizationId={organizationId}
                    canManage={canManage}
                    refresh={refresh}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </section>
      {!error && !query.isPending && !access.isPending ? (
        <section aria-labelledby="setup-title" className="connections-section">
          <h2 id="setup-title">
            <Plus size={17} aria-hidden="true" /> Add a system
          </h2>
          <p className="connection-section-description">
            Choose a provider to connect to this workspace.
          </p>
          <div className="connection-providers">
            {(Object.keys(providers) as Provider[]).map((kind) => (
              <Card as="article" key={kind}>
                <CardHeader className="connection-provider-heading">
                  <CardTitle as="h3">
                    <ProviderIcon provider={kind} />
                    {providers[kind]}
                  </CardTitle>
                </CardHeader>
                <p>
                  {kind === 'shopify'
                    ? 'Read orders, products, inventory and fulfillment from your shop.'
                    : 'Read commerce data and optionally permit shipping-method corrections.'}
                </p>
                <Button
                  variant="outline"
                  disabled={!canManage}
                  onClick={() => setProvider(kind)}
                >
                  <Plus size={14} aria-hidden="true" />
                  {kind === 'shopify'
                    ? 'Connect Shopify'
                    : `Set up ${providers[kind]}`}
                </Button>
              </Card>
            ))}
          </div>
        </section>
      ) : null}
      <p role="status">{message}</p>
      <Dialog
        open={provider !== null && canManage && !error}
        onOpenChange={(open) => {
          if (!open) setProvider(null);
        }}
      >
        <DialogContent className="connection-dialog">
          <DialogTitle>
            Connect {provider ? providers[provider] : 'system'}
          </DialogTitle>
          <DialogDescription>
            {provider === 'shopify'
              ? 'Enter your shop hostname, then approve access in Shopify.'
              : 'Use credentials issued for this account. Luma stores them securely and never displays them again.'}
          </DialogDescription>
          {provider === 'shopify' ? (
            <ShopifyForm organizationId={organizationId} />
          ) : provider ? (
            <SetupForm
              key={provider}
              provider={provider}
              organizationId={organizationId}
              done={async () => {
                setProvider(null);
                setMessage(
                  'Connection saved. Validate access to enable its capabilities.',
                );
                await refresh();
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
