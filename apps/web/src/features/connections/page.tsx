import { Button } from '@luma/ui/components/primitives/button';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';

import { appsOptions } from '../apps/data';
import { AppStore } from '../apps/store';
import { contextOptions } from '../identity/data';
import { ConnectionCard } from './connection-card';
import { connectionError, connectionsOptions } from './data';

/** Lists workspace connections and available app installations. */
export function ConnectionsPage() {
  const { organizationId } = useParams({ from: '/app/$organizationId' });
  const { appResult } = useSearch({ from: '/app/$organizationId/connections' });

  return (
    <Connections
      key={organizationId}
      organizationId={organizationId}
      appResult={appResult}
    />
  );
}

/** Shows connection health and workspace app management. */
export function Connections({
  organizationId,
  appResult,
}: {
  organizationId: string;
  appResult?: string | undefined;
}) {
  const access = useQuery(contextOptions(organizationId));
  const query = useQuery(connectionsOptions(organizationId));
  const apps = useQuery(appsOptions(organizationId));
  const client = useQueryClient();
  const refresh = async () => {
    await client.invalidateQueries({
      queryKey: connectionsOptions(organizationId).queryKey,
    });
  };
  const canManage =
    access.data?.actor.role === 'owner' || access.data?.actor.role === 'admin';

  return (
    <div className="connections-page">
      <h1>Apps & connections</h1>
      <p className="desk-intro">
        Install apps to connect your systems and extend your workspace.
      </p>
      {appResult ? (
        <p role="status">
          {appResult === 'connected'
            ? 'Connection ready.'
            : 'Authorization needs attention. Open app settings to try again.'}
        </p>
      ) : null}
      <AppStore
        organizationId={organizationId}
        canManage={canManage}
        refresh={refresh}
      />
      <section className="connections-section">
        <h2>Connections</h2>
        <Button
          variant="outline"
          disabled={query.isFetching}
          onClick={() => void refresh()}
        >
          {query.isFetching ? 'Refreshing…' : 'Refresh list'}
        </Button>
        {query.error ? (
          <p role="alert">{connectionError(query.error)}</p>
        ) : query.isPending ? (
          <p role="status">Loading connections…</p>
        ) : (
          <div className="connection-list">
            {query.data.length ? (
              query.data.map((connection) => (
                <ConnectionCard
                  key={connection.id}
                  connection={connection}
                  appAvailable={
                    !!apps.data?.catalog.some(
                      (app) => app.id === connection.appId,
                    ) &&
                    !!apps.data.installations.some(
                      (app) =>
                        app.appId === connection.appId &&
                        app.status === 'installed',
                    )
                  }
                  organizationId={organizationId}
                  canManage={canManage}
                  refresh={refresh}
                />
              ))
            ) : (
              <p>No connections yet. Install an app to get started.</p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
