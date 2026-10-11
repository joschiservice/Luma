import './apps.css';

import { formatList } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { RefreshButton } from '@luma/ui/components/primitives/refresh-button';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
import { WorkspaceBreadcrumb } from '@luma/ui/components/workspace/workspace-breadcrumb';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, ChevronRight, Plug } from 'lucide-react';
import { useRef, useState } from 'react';

import { ConnectionCard } from '../connections/connection-card';
import { connectionError, connectionsOptions } from '../connections/data';
import { contextOptions } from '../identity/data';
import { roleName } from '../identity/permission-text';
import { isOwnerRole, usePermissions } from '../identity/permissions';
import { settingsOptions } from '../settings/data';
import { syncOptions } from '../sync/data';
import { AppAccessDialog, ScopeList } from './access';
import {
  type AppResult,
  approveAppScopes,
  appsOptions,
  changeApp,
} from './data';
import { AppExtension } from './extension';

const appResults = {
  connected: m.apps_settings_result_connected,
  permissions: m.apps_settings_result_permissions,
  denied: m.apps_settings_result_denied,
  failed: m.apps_settings_result_failed,
} satisfies Record<AppResult, () => string>;

/** Lists an app's connections and hosts its setup and workspace settings contributions. */
export function AppSettings({
  organizationId,
  appId,
  appResult,
}: {
  organizationId: string;
  appId: string;
  appResult?: AppResult | undefined;
}) {
  const apps = useQuery(appsOptions(organizationId));
  const connections = useQuery(connectionsOptions(organizationId));
  const { can } = usePermissions(organizationId);
  const access = useQuery(contextOptions(organizationId));
  const settings = useQuery(settingsOptions(organizationId));
  const owner =
    isOwnerRole(access.data?.actor.role) && !access.data?.supportView;
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
  const name = app?.name ?? appId;

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
          {m.apps_title()}
        </Link>
        <ChevronRight size={14} aria-hidden="true" />
        <span aria-current="page">{name}</span>
      </WorkspaceBreadcrumb>
      <Link
        to="/app/$organizationId/apps"
        params={{ organizationId }}
        className="app-back"
      >
        <ArrowLeft size={15} aria-hidden="true" />
        {m.apps_settings_back()}
      </Link>
      {apps.isPending ? (
        <p role="status">{m.apps_loading_app()}</p>
      ) : apps.error ? (
        <p role="alert">{connectionError(apps.error)}</p>
      ) : (
        <>
          <PageHeader
            icon={
              <span className="app-tile-icon" data-size="lg" aria-hidden="true">
                {name.slice(0, 1)}
              </span>
            }
            title={name}
            description={
              app?.description ?? m.apps_settings_unavailable_description()
            }
            actions={
              installed && canManageApp ? (
                <Button
                  variant="outline"
                  onClick={() => setDialog('uninstall')}
                >
                  {m.apps_settings_uninstall()}
                </Button>
              ) : null
            }
          />
          {!installed ? (
            <p className="apps-note">
              {m.apps_settings_not_installed({ app: name })}
            </p>
          ) : null}
          {appResult ? (
            <Alert
              role="status"
              tone={appResult === 'connected' ? 'success' : 'warning'}
            >
              {appResults[appResult]()}
            </Alert>
          ) : null}
          {installation?.status === 'installed' &&
          installation.pendingScopes.length > 0 &&
          app ? (
            <Alert tone="warning">
              {m.apps_settings_pending_access({ app: app.name })}{' '}
              {canManageApp ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setMessage('');
                    setDialog('approve');
                  }}
                >
                  {m.apps_settings_review_access()}
                </Button>
              ) : null}
            </Alert>
          ) : null}
          {!canManage ? (
            <p className="apps-note">{m.apps_settings_manage_denied()}</p>
          ) : null}
          {app?.connectionTypes.length || items.length || !app ? (
            <section
              className="connections-section"
              aria-labelledby="app-connections"
            >
              <div className="connections-heading">
                <h2 id="app-connections">
                  {m.apps_settings_connections_title()}
                </h2>
                <div className="connection-actions">
                  <RefreshButton
                    label={m.apps_settings_refresh()}
                    refreshing={connections.isFetching}
                    onClick={() => void refresh()}
                  />
                  {available && canManage && app.ui.includes('connections') ? (
                    <Button onClick={() => setDialog('add')}>
                      {m.apps_settings_add_connection()}
                    </Button>
                  ) : null}
                </div>
              </div>
              {connections.error ? (
                <p role="alert">{connectionError(connections.error)}</p>
              ) : connections.isPending ? (
                <p role="status">{m.apps_connections_loading()}</p>
              ) : items.length ? (
                <div className="connection-list">
                  {items.map((connection) => (
                    <ConnectionCard
                      key={connection.id}
                      connection={connection}
                      organizationId={organizationId}
                      appAvailable={available}
                      canManage={canManage}
                      owner={owner}
                      workspaceWriteMode={settings.data?.workspace.writeMode}
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
                  <h3>{m.apps_settings_connections_empty_title()}</h3>
                  <p>
                    {canManage && available
                      ? m.apps_settings_connections_empty_manage({ app: name })
                      : m.apps_settings_connections_empty_read()}
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
              <h2 id="app-access">{m.apps_settings_access_title()}</h2>
              <p className="apps-note">
                {m.apps_settings_access_description({ app: name })}
              </p>
              {installation.grantedScopes.length ? (
                <ScopeList
                  organizationId={organizationId}
                  scopes={installation.grantedScopes}
                />
              ) : (
                <p className="apps-note">
                  {m.apps_settings_access_empty({ app: name })}
                </p>
              )}
            </section>
          ) : null}
          {available && canManageApp && app.ui.includes('app-settings') ? (
            <section className="connections-section">
              <h2>{m.apps_settings_app_settings_title()}</h2>
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
                {m.apps_settings_open_app({ app: app.name })}
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
              <DialogTitle>
                {m.apps_settings_add_title({ app: name })}
              </DialogTitle>
              <DialogDescription>
                {m.apps_settings_add_description({ app: name })}
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
              <DialogTitle>{m.apps_uninstall_title({ app: name })}</DialogTitle>
              <DialogDescription>
                {m.apps_uninstall_description({ app: name })}
              </DialogDescription>
              {installation?.roles.length ? (
                <Alert tone="warning">
                  {m.apps_uninstall_roles({
                    count: installation.roles.length,
                    roles: formatList(installation.roles.map(roleName)),
                  })}
                </Alert>
              ) : null}
              <div className="connection-actions">
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => setDialog(null)}
                >
                  {m.common_cancel()}
                </Button>
                <Button disabled={pending} onClick={() => void uninstall()}>
                  {pending
                    ? m.apps_uninstall_pending()
                    : m.apps_uninstall_confirm()}
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
