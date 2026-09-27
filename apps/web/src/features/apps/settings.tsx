import { Button } from '@luma/ui/components/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';

import { ConnectionCard } from '../connections/connection-card';
import { connectionError, connectionsOptions } from '../connections/data';
import { contextOptions } from '../identity/data';
import { appsOptions, changeApp } from './data';
import { AppExtension } from './extension';

/** Lists an app's connections and hosts its setup and workspace settings contributions. */
export function AppSettings({
  organizationId,
  appId,
  appResult,
}: {
  organizationId: string;
  appId: string;
  appResult?: string | undefined;
}) {
  const apps = useQuery(appsOptions(organizationId));
  const connections = useQuery(connectionsOptions(organizationId));
  const access = useQuery(contextOptions(organizationId));
  const client = useQueryClient();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<'add' | 'uninstall' | null>(null);
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const [message, setMessage] = useState('');
  const canManage =
    access.data?.actor.role === 'owner' || access.data?.actor.role === 'admin';
  const refresh = async () => {
    await client.invalidateQueries({
      queryKey: connectionsOptions(organizationId).queryKey,
    });
  };
  const installation = apps.data?.installations.find(
    (item) => item.appId === appId,
  );
  const app = apps.data?.catalog.find((item) => item.id === appId);
  const installed = installation?.status === 'installed';
  const available = installed && !!app;
  const items = connections.data?.filter((item) => item.appId === appId) ?? [];

  async function uninstall() {
    if (lock.current || !installation) return;
    lock.current = true;
    setPending(true);
    setMessage('');
    try {
      await changeApp(organizationId, appId, 'uninstall', installation.version);
      await Promise.all([
        client.invalidateQueries({
          queryKey: appsOptions(organizationId).queryKey,
        }),
        refresh(),
      ]);
      await navigate({
        to: '/app/$organizationId/connections',
        params: { organizationId },
      });
    } catch (error) {
      setMessage(connectionError(error));
    } finally {
      lock.current = false;
      setPending(false);
    }
  }

  return (
    <div className="connections-page">
      <Link
        to="/app/$organizationId/connections"
        params={{ organizationId }}
        className="app-back"
      >
        ← Apps & connections
      </Link>
      {apps.isPending ? (
        <p role="status">Loading app…</p>
      ) : apps.error ? (
        <p role="alert">{connectionError(apps.error)}</p>
      ) : (
        <>
          <div className="connections-heading">
            <h1>{app?.name ?? appId}</h1>
            {installed && canManage ? (
              <Button variant="ghost" onClick={() => setDialog('uninstall')}>
                Uninstall
              </Button>
            ) : null}
          </div>
          <p className="desk-intro">
            {app?.description ??
              'This app is unavailable. Historical connections remain accessible.'}
          </p>
          {!installed ? (
            <p>
              This app is not installed. Install it from Apps & connections to
              connect an account.
            </p>
          ) : null}
          {appResult ? (
            <p role="status">
              {appResult === 'connected'
                ? 'Connection ready.'
                : 'Authorization needs attention. Add a connection to try again.'}
            </p>
          ) : null}
          {!canManage ? (
            <p>
              An owner or admin can add connections and change app settings.
            </p>
          ) : null}
          {app?.connectionTypes.length || items.length || !app ? (
            <section
              className="connections-section"
              aria-labelledby="app-connections"
            >
              <div className="connections-heading">
                <h2 id="app-connections">Connections</h2>
                <div className="connection-actions">
                  <Button
                    variant="outline"
                    disabled={connections.isFetching}
                    onClick={() => void refresh()}
                  >
                    {connections.isFetching ? 'Refreshing…' : 'Refresh list'}
                  </Button>
                  {available && canManage && app.ui.includes('connections') ? (
                    <Button onClick={() => setDialog('add')}>
                      Add connection
                    </Button>
                  ) : null}
                </div>
              </div>
              {connections.error ? (
                <p role="alert">{connectionError(connections.error)}</p>
              ) : connections.isPending ? (
                <p role="status">Loading connections…</p>
              ) : items.length ? (
                <div className="connection-list">
                  {items.map((connection) => (
                    <ConnectionCard
                      key={connection.id}
                      connection={connection}
                      organizationId={organizationId}
                      appAvailable={available}
                      canManage={canManage}
                      refresh={refresh}
                    />
                  ))}
                </div>
              ) : (
                <div className="connection-empty">
                  <h3>No connections yet</h3>
                  <p>
                    {canManage && available
                      ? 'Add your first connection to enable this app’s capabilities.'
                      : 'Connected accounts will appear here.'}
                  </p>
                </div>
              )}
            </section>
          ) : null}
          {available && canManage && app.ui.includes('app-settings') ? (
            <section className="connections-section">
              <h2>App settings</h2>
              <AppExtension
                appId={appId}
                organizationId={organizationId}
                slot="app-settings"
                done={refresh}
              />
            </section>
          ) : null}
          {available && app.ui.includes('page') ? (
            <section className="connections-section">
              <Link
                to="/app/$organizationId/apps/$appId"
                params={{ organizationId, appId }}
              >
                Open {app.name}
              </Link>
            </section>
          ) : null}
          <Dialog
            open={dialog === 'add' && available && canManage}
            onOpenChange={(open) => {
              if (!open) setDialog(null);
            }}
          >
            <DialogContent className="connection-dialog">
              <DialogTitle>Add {app?.name} connection</DialogTitle>
              <DialogDescription>
                Connect an account to enable the app’s capabilities.
              </DialogDescription>
              {dialog === 'add' ? (
                <AppExtension
                  appId={appId}
                  organizationId={organizationId}
                  slot="connections"
                  done={async () => {
                    setDialog(null);
                    await refresh();
                  }}
                />
              ) : null}
            </DialogContent>
          </Dialog>
          <Dialog
            open={dialog === 'uninstall'}
            onOpenChange={(open) => {
              if (!open && !pending) setDialog(null);
            }}
          >
            <DialogContent>
              <DialogTitle>Uninstall {app?.name ?? appId}?</DialogTitle>
              <DialogDescription>
                This stops new app operations and deletes credentials for all
                its connections. Historical records remain. Requests already
                sent may finish.
              </DialogDescription>
              <div className="connection-actions">
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => setDialog(null)}
                >
                  Cancel
                </Button>
                <Button disabled={pending} onClick={() => void uninstall()}>
                  {pending ? 'Uninstalling…' : 'Confirm uninstall'}
                </Button>
              </div>
              <p role="alert">{message}</p>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}
