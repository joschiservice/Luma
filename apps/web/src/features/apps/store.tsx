import { m } from '@luma/i18n/messages';
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
import { AppAccessDialog } from './access';
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
  const [reviewing, setReviewing] = useState<string | null>(null);

  async function install(id: string, scopes: readonly string[]) {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setMessage('');
    try {
      const current = query.data?.installations.find(
        (item) => item.appId === id,
      );
      await changeApp(
        organizationId,
        id,
        'install',
        current?.version ?? null,
        scopes,
      );
      setReviewing(null);
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

  if (query.isPending) return <p role="status">{m.apps_store_loading()}</p>;
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
        <p className="apps-note">{m.apps_store_manage_denied()}</p>
      ) : null}
      <section className="connections-section" aria-labelledby="installed-apps">
        <h2 id="installed-apps">{m.apps_store_installed_title()}</h2>
        {!installed.length ? (
          <p className="apps-note">{m.apps_store_installed_empty()}</p>
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
                  {app?.description ?? m.apps_store_app_unavailable()}
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
                      ? m.apps_connections_loading()
                      : connections.error
                        ? m.apps_store_connections_unavailable()
                        : live.length
                          ? m.apps_store_connections_count({
                              count: live.length,
                            })
                          : m.apps_store_connections_empty()}
                  </p>
                ) : null}
                {!connections.error && attention.length ? (
                  <Link
                    to="/app/$organizationId/apps/$appId/settings"
                    params={params}
                    hash={`connection-${attention[0]!.id}`}
                    className="app-attention"
                  >
                    {m.apps_store_connections_attention({
                      count: attention.length,
                    })}
                  </Link>
                ) : null}
                <Link
                  className={buttonVariants({ variant: 'outline' })}
                  to="/app/$organizationId/apps/$appId/settings"
                  params={params}
                >
                  {m.apps_store_manage()}
                </Link>
              </Card>
            );
          })}
        </div>
      </section>
      <section className="connections-section" aria-labelledby="available-apps">
        <h2 id="available-apps">{m.apps_store_available_title()}</h2>
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
                onClick={() => {
                  setMessage('');
                  setReviewing(app.id);
                }}
              >
                {m.apps_store_install({ app: app.name })}
              </Button>
            </Card>
          ))}
        </div>
        {!available.length ? (
          <p className="apps-note">{m.apps_store_available_empty()}</p>
        ) : null}
      </section>
      {historical.length ? (
        <section className="connections-section" aria-labelledby="past-apps">
          <h2 id="past-apps">{m.apps_store_history_title()}</h2>
          <p className="apps-note">{m.apps_store_history_description()}</p>
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
      {reviewing ? null : <p role="status">{message}</p>}
      {available.map((app) => (
        <AppAccessDialog
          key={app.id}
          organizationId={organizationId}
          app={app}
          scopes={app.scopes}
          mode="install"
          open={reviewing === app.id}
          pending={pending}
          error={reviewing === app.id ? message : ''}
          close={() => setReviewing(null)}
          confirm={() => void install(app.id, app.scopes)}
        />
      ))}
    </>
  );
}
