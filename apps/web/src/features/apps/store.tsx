import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import { StateDot } from '@luma/ui/components/primitives/state';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';

import { connectionError, connectionsOptions } from '../connections/data';
import { appsOptions, changeApp } from './data';

/** Shows installed apps with connection summaries and a separate catalog for discovery. */
export function AppStore({
  organizationId,
  canManage,
  refresh,
}: {
  organizationId: string;
  canManage: boolean;
  refresh: () => Promise<void>;
}) {
  const query = useQuery(appsOptions(organizationId));
  const connections = useQuery(connectionsOptions(organizationId));
  const client = useQueryClient();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const [message, setMessage] = useState('');

  async function install(id: string) {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setMessage('');
    try {
      const current = query.data?.installations.find(
        (item) => item.appId === id,
      );
      await changeApp(organizationId, id, 'install', current?.version ?? null);
      await Promise.all([
        client.invalidateQueries({
          queryKey: appsOptions(organizationId).queryKey,
        }),
        refresh(),
      ]);
      await navigate({
        to: '/app/$organizationId/apps/$appId/settings',
        params: { organizationId, appId: id },
      });
    } catch (error) {
      setMessage(connectionError(error));
    } finally {
      lock.current = false;
      setPending(false);
    }
  }

  if (query.isPending) return <p role="status">Loading apps…</p>;
  if (query.error) return <p role="alert">{connectionError(query.error)}</p>;
  const installed = query.data.installations.filter(
    (app) => app.status === 'installed',
  );
  const available = query.data.catalog.filter(
    (app) => !installed.some((item) => item.appId === app.id),
  );
  // Retain access to historical connections after uninstall or removal from the catalog.
  const historical = [
    ...new Set(
      connections.data
        ?.map((item) => item.appId)
        .filter((id): id is string => !!id),
    ),
  ].filter((id) => !installed.some((app) => app.appId === id));

  return (
    <>
      {!canManage ? (
        <p className="apps-note">
          An owner or admin can install and configure apps.
        </p>
      ) : null}
      <section className="connections-section" aria-labelledby="installed-apps">
        <h2 id="installed-apps">Installed apps</h2>
        {!installed.length ? (
          <p className="apps-note">
            No apps installed yet. Choose an app below to get started.
          </p>
        ) : null}
        <div className="connection-providers">
          {installed.map((installation) => {
            const app = query.data.catalog.find(
              (item) => item.id === installation.appId,
            );
            const items =
              connections.data?.filter(
                (item) => item.appId === installation.appId,
              ) ?? [];
            const live = items.filter(
              (item) => !['disconnected', 'revoked'].includes(item.status),
            );
            const attention = items.filter((item) =>
              ['pending', 'degraded', 'revoked'].includes(item.status),
            );
            const params = { organizationId, appId: installation.appId };

            return (
              <Card as="article" key={installation.appId} className="app-tile">
                <CardHeader>
                  <span className="app-tile-icon" aria-hidden="true">
                    {(app?.name ?? installation.appId).slice(0, 1)}
                  </span>
                  <CardTitle as="h3">
                    {app?.name ?? installation.appId}
                  </CardTitle>
                </CardHeader>
                <p className="app-tile-description">
                  {app?.description ??
                    'App unavailable. Historical records remain accessible.'}
                </p>
                {app?.connectionTypes.length ? (
                  <p className="app-tile-status">
                    <StateDot
                      state={
                        connections.error
                          ? 'idle'
                          : attention.length
                            ? 'attention'
                            : live.length
                              ? 'verified'
                              : 'waiting'
                      }
                    />
                    {connections.isPending
                      ? 'Loading connections…'
                      : connections.error
                        ? 'Connection status unavailable'
                        : live.length
                          ? `${live.length} ${live.length === 1 ? 'connection' : 'connections'}`
                          : 'No connected accounts'}
                  </p>
                ) : null}
                {!connections.error && attention.length ? (
                  <Link
                    to="/app/$organizationId/apps/$appId/settings"
                    params={params}
                    hash={`connection-${attention[0]!.id}`}
                    className="app-attention"
                  >
                    {attention.length}{' '}
                    {attention.length === 1
                      ? 'connection needs'
                      : 'connections need'}{' '}
                    attention
                  </Link>
                ) : null}
                <Link
                  className={buttonVariants({ variant: 'outline' })}
                  to="/app/$organizationId/apps/$appId/settings"
                  params={params}
                >
                  Manage app
                </Link>
              </Card>
            );
          })}
        </div>
      </section>
      <section className="connections-section" aria-labelledby="available-apps">
        <h2 id="available-apps">Available apps</h2>
        <div className="connection-providers">
          {available.map((app) => (
            <Card as="article" key={app.id} className="app-tile">
              <CardHeader>
                <span className="app-tile-icon" aria-hidden="true">
                  {app.name.slice(0, 1)}
                </span>
                <CardTitle as="h3">{app.name}</CardTitle>
              </CardHeader>
              <p className="app-tile-description">{app.description}</p>
              <Button
                disabled={!canManage || pending}
                onClick={() => void install(app.id)}
              >
                Install {app.name}
              </Button>
            </Card>
          ))}
        </div>
        {!available.length ? (
          <p className="apps-note">No additional apps available.</p>
        ) : null}
      </section>
      {historical.length ? (
        <section className="connections-section">
          <h2>Connection history</h2>
          <ul className="apps-history">
            {historical.map((appId) => (
              <li key={appId}>
                <Link
                  to="/app/$organizationId/apps/$appId/settings"
                  params={{ organizationId, appId }}
                >
                  {query.data.catalog.find((app) => app.id === appId)?.name ??
                    appId}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {connections.error ? (
        <p role="alert">{connectionError(connections.error)}</p>
      ) : null}
      <p role="status">{message}</p>
    </>
  );
}
