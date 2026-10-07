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
import { usePermissions } from '../identity/permissions';
import { syncOptions } from '../sync/data';
import { AppAccessDialog, ScopeList } from './access';
import { approveAppScopes, appsOptions, changeApp } from './data';
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
  const { can } = usePermissions(organizationId);
  const sync = useQuery(syncOptions(organizationId));
  const client = useQueryClient();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<'add' | 'uninstall' | 'approve' | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const [message, setMessage] = useState('');
  // Connections and app lifecycle are separate permissions.
  const canManage = can('connections.manage');
  const canManageApp = can('apps.manage');
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

  async function approve() {
    if (lock.current || !installation) return;
    lock.current = true;
    setPending(true);
    setMessage('');
    try {
      await approveAppScopes(
        organizationId,
        appId,
        installation.version,
        installation.pendingScopes,
      );
      await client.invalidateQueries({
        queryKey: appsOptions(organizationId).queryKey,
      });
      setDialog(null);
    } catch (error) {
      setMessage(connectionError(error));
    } finally {
      lock.current = false;
      setPending(false);
    }
  }

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
              installed && canManageApp ? (
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
          {installation?.status === 'installed' &&
          installation.pendingScopes.length > 0 &&
          app ? (
            <Alert tone="warning">
              {app.name} was updated and asks for more access. It keeps working
              with its current access until someone approves.{' '}
              {canManageApp ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setMessage('');
                    setDialog('approve');
                  }}
                >
                  Review access
                </Button>
              ) : null}
            </Alert>
          ) : null}
          {!canManage ? (
            <p className="apps-note">
              Adding connections and changing app settings requires permission
              to manage connections, which your role doesn’t include.
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
          {installation?.status === 'installed' ? (
            <section
              className="connections-section"
              aria-labelledby="app-access"
            >
              <h2 id="app-access">Access</h2>
              <p className="apps-note">
                What {app?.name ?? appId} may use in this workspace. When it
                acts for someone, it can never do more than their role allows.
              </p>
              {installation.grantedScopes.length ? (
                <ScopeList
                  organizationId={organizationId}
                  scopes={installation.grantedScopes}
                />
              ) : (
                <p className="apps-note">No workspace data granted.</p>
              )}
            </section>
          ) : null}
          {available && canManageApp && app.ui.includes('app-settings') ? (
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
              {installation?.roles.length ? (
                <Alert tone="warning">
                  These roles lose {app?.name ?? appId} permissions:{' '}
                  {installation.roles.map((role) => role.name).join(', ')}.
                  Reinstalling doesn’t restore them.
                </Alert>
              ) : null}
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
          {app && installation ? (
            <AppAccessDialog
              organizationId={organizationId}
              app={app}
              scopes={installation.pendingScopes}
              mode="approve"
              open={dialog === 'approve'}
              pending={pending}
              error={message}
              close={() => setDialog(null)}
              confirm={() => void approve()}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
