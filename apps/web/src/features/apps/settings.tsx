import './apps.css';

import { formatList } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Empty } from '@luma/ui/components/primitives/empty';
import { RefreshButton } from '@luma/ui/components/primitives/refresh-button';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
import { WorkspaceBreadcrumb } from '@luma/ui/components/workspace/workspace-breadcrumb';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ArrowRight,
  ChevronRight,
  KeyRound,
  Plug,
  Plus,
  ShieldCheck,
} from 'lucide-react';
import { useRef, useState } from 'react';

import {
  type AppResult,
  approveAppScopes,
  appsOptions,
  changeApp,
} from '../../kit/apps/data';
import {
  changeConnection,
  connectionError,
  connectionsOptions,
} from '../../kit/connections/data';
import { contextOptions } from '../../kit/identity/data';
import { roleName } from '../../kit/identity/permission-text';
import { isOwnerRole, usePermissions } from '../../kit/identity/permissions';
import { settingsOptions } from '../../kit/settings/data';
import { syncOptions } from '../sync/data';
import { AppAccessDialog, ScopeList } from './access';
import { ConnectionCard } from './connection-card';
import { AppExtension } from './extension';
import { appCategoryLabel, AppIcon } from './presentation';

const appResults = {
  connected: m.apps_settings_result_connected,
  permissions: m.apps_settings_result_permissions,
  denied: m.apps_settings_result_denied,
  failed: m.apps_settings_result_failed,
} satisfies Record<AppResult, () => string>;

/**
 * An app's page: its connections first, then its workspace settings, the access it holds and,
 * for people who manage apps, uninstalling it. Connections of an app that is uninstalled or
 * missing from the deployment stay visible without mounting the app's UI.
 */
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
  const live = items.filter((item) => item.status !== 'disconnected');
  const disconnected = items.filter((item) => item.status === 'disconnected');
  const name = app?.name ?? appId;
  const canAdd = available && canManage && app.ui.includes('connections');
  // Revoked connections need new access, not a check; apps may handle checks themselves.
  const checkable = available
    ? live.filter(
        (item) =>
          item.status !== 'revoked' &&
          (!item.management || item.management.includes('check')),
      )
    : [];
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState('');

  /**
   * Checks each connection in turn, so one failure doesn't stop the rest, then reads the list
   * again because every check changes a connection's version.
   */
  async function checkAll() {
    if (checking) return;
    setChecking(true);
    setChecked('');
    let confirmed = 0;
    for (const connection of checkable) {
      try {
        const result = await changeConnection(
          organizationId,
          connection,
          'check',
        );
        if (result.status === 'active') confirmed += 1;
      } catch {
        // Counted as not confirmed; the connection shows its own state after the refresh.
      }
    }
    await refresh();
    setChecked(
      confirmed === checkable.length
        ? m.apps_settings_validate_all_done({ count: confirmed })
        : m.apps_settings_validate_all_partial({
            confirmed,
            count: checkable.length,
          }),
    );
    setChecking(false);
  }

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

  const card = (connection: (typeof items)[number]) => (
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
      canReadHistory={can('activity.read_restricted')}
    />
  );

  return (
    <div className="apps-page">
      <WorkspaceBreadcrumb>
        <Link to="/app/$organizationId/apps" params={{ organizationId }}>
          {m.apps_title()}
        </Link>
        <ChevronRight size={14} aria-hidden="true" />
        <span aria-current="page">{name}</span>
      </WorkspaceBreadcrumb>
      {apps.isPending ? (
        <p role="status">{m.apps_loading_app()}</p>
      ) : apps.error ? (
        <Alert tone="danger" role="alert">
          {connectionError(apps.error)}{' '}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void apps.refetch()}
          >
            {m.common_retry()}
          </Button>
        </Alert>
      ) : (
        <>
          <PageHeader
            className="app-header"
            icon={<AppIcon category={app?.category} size="lg" />}
            title={name}
            description={
              <>
                {app?.description ?? m.apps_settings_unavailable_description()}
                <span className="app-header-meta">
                  {app ? <span>{appCategoryLabel(app.category)}</span> : null}
                  {app ? (
                    <span>
                      {m.apps_settings_version({ version: app.version })}
                    </span>
                  ) : null}
                  {!installed ? (
                    <Badge>{m.apps_store_not_installed()}</Badge>
                  ) : !app ? (
                    <Badge>{m.apps_settings_unavailable()}</Badge>
                  ) : null}
                </span>
              </>
            }
            actions={
              available && app.ui.includes('page') ? (
                <Link
                  className={buttonVariants({ variant: 'outline' })}
                  to="/app/$organizationId/apps/$appId"
                  params={{ organizationId, appId }}
                >
                  {m.apps_settings_open_app({ app: app.name })}
                  <ArrowRight aria-hidden="true" />
                </Link>
              ) : null
            }
          />
          {appResult ? (
            <Alert
              role="status"
              tone={appResult === 'connected' ? 'success' : 'warning'}
            >
              {appResults[appResult]()}
            </Alert>
          ) : null}
          {!installed ? (
            <Alert>{m.apps_settings_not_installed({ app: name })}</Alert>
          ) : null}
          {installed && installation.pendingScopes.length > 0 && app ? (
            <Alert tone="warning" className="app-pending-access">
              <span>{m.apps_settings_pending_access({ app: app.name })}</span>
              {canManageApp ? (
                <Button
                  variant="outline"
                  size="sm"
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
          {app?.connectionTypes.length || items.length || !app ? (
            <section className="apps-section" aria-labelledby="app-connections">
              <div className="apps-section-heading">
                <h2 id="app-connections">
                  {m.apps_settings_connections_title()}
                </h2>
                {live.length ? (
                  <span className="apps-section-count">{live.length}</span>
                ) : null}
                <div className="apps-section-actions">
                  <RefreshButton
                    label={m.apps_settings_refresh()}
                    refreshing={connections.isFetching}
                    onClick={() => void refresh()}
                  />
                  {canManage && checkable.length > 1 ? (
                    <Button
                      variant="outline"
                      disabled={checking}
                      onClick={() => void checkAll()}
                    >
                      <ShieldCheck aria-hidden="true" />
                      {checking
                        ? m.apps_settings_validating_all()
                        : m.apps_settings_validate_all()}
                    </Button>
                  ) : null}
                  {canAdd ? (
                    <Button onClick={() => setDialog('add')}>
                      <Plus aria-hidden="true" />
                      {m.apps_settings_add_connection()}
                    </Button>
                  ) : null}
                </div>
              </div>
              {!canManage ? (
                <p className="apps-note">{m.apps_settings_manage_denied()}</p>
              ) : null}
              <p role="status" className="connection-feedback">
                {checked}
              </p>
              {connections.error ? (
                <Alert tone="danger" role="alert">
                  {connectionError(connections.error)}
                </Alert>
              ) : connections.isPending ? (
                <div className="apps-loading" role="status">
                  <span className="sr-only">
                    {m.apps_connections_loading()}
                  </span>
                  <span className="lu-skeleton" data-size="lg" />
                </div>
              ) : live.length ? (
                <div className="connection-list">{live.map(card)}</div>
              ) : (
                <Empty className="apps-empty">
                  <Plug aria-hidden="true" />
                  <h3>{m.apps_settings_connections_empty_title()}</h3>
                  <p>
                    {canAdd
                      ? m.apps_settings_connections_empty_manage({ app: name })
                      : m.apps_settings_connections_empty_read()}
                  </p>
                </Empty>
              )}
              {!connections.error && disconnected.length ? (
                <div className="connection-history">
                  <h3>
                    {m.apps_settings_disconnected_title({
                      count: disconnected.length,
                    })}
                  </h3>
                  <div className="connection-list">
                    {disconnected.map(card)}
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}
          {available && canManageApp && app.ui.includes('app-settings') ? (
            <section className="apps-section" aria-labelledby="app-settings">
              <div className="apps-section-heading">
                <h2 id="app-settings">
                  {m.apps_settings_app_settings_title()}
                </h2>
              </div>
              <AppExtension
                appId={appId}
                organizationId={organizationId}
                slot="app-settings"
                done={refresh}
              />
            </section>
          ) : null}
          {installed ? (
            <section className="apps-section" aria-labelledby="app-access">
              <div className="apps-section-heading">
                <h2 id="app-access">{m.apps_settings_access_title()}</h2>
              </div>
              <p className="apps-note">
                {m.apps_settings_access_description({ app: name })}
              </p>
              <div className="app-access">
                <div className="app-access-column">
                  <h3>{m.apps_settings_access_scopes_title()}</h3>
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
                </div>
                {app?.permissions.length ? (
                  <div className="app-access-column">
                    <h3>{m.apps_settings_permissions_title()}</h3>
                    <ul className="app-scopes">
                      {app.permissions.map((permission) => (
                        <li key={permission.key}>
                          <KeyRound size={14} aria-hidden="true" />
                          <span>
                            <strong>
                              {permission.label}
                              {permission.consequential ? (
                                <Badge tone="warning">
                                  {m.apps_access_sensitive()}
                                </Badge>
                              ) : null}
                            </strong>
                            <span>{permission.description}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                    <p className="apps-note">
                      {installation.roles.length
                        ? m.apps_settings_permissions_roles({
                            roles: formatList(installation.roles.map(roleName)),
                          })
                        : m.apps_settings_permissions_no_roles()}{' '}
                      <Link
                        to="/app/$organizationId/settings/$section"
                        params={{ organizationId, section: 'roles' }}
                      >
                        {m.apps_settings_permissions_manage()}
                      </Link>
                    </p>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}
          {installed && canManageApp ? (
            <section
              className="apps-section app-uninstall"
              aria-labelledby="app-uninstall"
            >
              <div>
                <h2 id="app-uninstall">
                  {m.apps_settings_uninstall_title({ app: name })}
                </h2>
                <p className="apps-note">
                  {m.apps_settings_uninstall_description({ app: name })}
                </p>
              </div>
              <Button variant="outline" onClick={() => setDialog('uninstall')}>
                {m.apps_settings_uninstall()}
              </Button>
            </section>
          ) : null}
          <Dialog
            open={dialog === 'add' && canAdd}
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
              {message ? (
                <Alert tone="danger" role="alert">
                  {message}
                </Alert>
              ) : null}
              <DialogFooter>
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => setDialog(null)}
                >
                  {m.common_cancel()}
                </Button>
                <Button
                  variant="destructive"
                  disabled={pending}
                  onClick={() => void uninstall()}
                >
                  {pending
                    ? m.apps_uninstall_pending()
                    : m.apps_uninstall_confirm()}
                </Button>
              </DialogFooter>
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
