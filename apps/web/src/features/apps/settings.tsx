import './apps.css';

import { Alert } from '@luma/ui/components/primitives/alert';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
import { WorkspaceBreadcrumb } from '@luma/ui/components/workspace/workspace-breadcrumb';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, ChevronRight, Plug } from 'lucide-react';
import { useRef, useState } from 'react';

import { ConnectionCard } from '../connections/connection-card';
import { connectionError, connectionsOptions } from '../connections/data';
import { contextOptions } from '../identity/data';
import { syncOptions } from '../sync/data';
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
  const sync = useQuery(syncOptions(organizationId));
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
        to: '/app/$organizationId/apps',
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
    <div className="connections-page apps-page">
      <WorkspaceBreadcrumb>
        <Link to="/app/$organizationId/apps" params={{ organizationId }}>
          Apps
        </Link>
        <ChevronRight size={14} aria-hidden="true" />
        <span aria-current="page">{app?.name ?? appId}</span>
      </WorkspaceBreadcrumb>
      <Link
        to="/app/$organizationId/apps"
        params={{ organizationId }}
        className="app-back"
      >
        <ArrowLeft size={15} aria-hidden="true" />
        All apps
      </Link>
      {apps.isPending ? (
        <p role="status">Loading app…</p>
      ) : apps.error ? (
        <p role="alert">{connectionError(apps.error)}</p>
      ) : (
        <>
          <PageHeader
            icon={
              <span className="app-tile-icon" data-size="lg" aria-hidden="true">
                {(app?.name ?? appId).slice(0, 1)}
              </span>
            }
            title={app?.name ?? appId}
            description={
              app?.description ??
              'This app is unavailable. Historical connections remain accessible.'
            }
            actions={
              installed && canManage ? (
                <Button
                  variant="outline"
                  onClick={() => setDialog('uninstall')}
                >
                  Uninstall
                </Button>
              ) : null
            }
          />
          {!installed ? (
            <p className="apps-note">
              This app is not installed. Install it from Apps to connect an
              account.
            </p>
          ) : null}
          {appResult ? (
            <Alert
              role="status"
              tone={appResult === 'connected' ? 'success' : 'warning'}
            >
              {appResult === 'connected'
                ? 'Connection ready.'
                : 'Authorization needs attention. Add a connection to try again.'}
            </Alert>
          ) : null}
          {!canManage ? (
            <p className="apps-note">
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
                      sync={sync.data?.connections.find(
                        (item) => item.connectionId === connection.id,
                      )}
                      syncAsOf={sync.data?.asOf}
                    />
                  ))}
                </div>
              ) : (
                <div className="connection-empty">
                  <Plug size={18} aria-hidden="true" />
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
                className={buttonVariants({ variant: 'outline' })}
                to="/app/$organizationId/apps/$appId"
                params={{ organizationId, appId }}
              >
                Open {app.name}
                <ArrowRight aria-hidden="true" />
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
