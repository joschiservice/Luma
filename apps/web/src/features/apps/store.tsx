import type { AppManifest, InstalledConnection } from '@luma/api-contract';
import { formatList } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import { Empty } from '@luma/ui/components/primitives/empty';
import { StatePill } from '@luma/ui/components/primitives/state';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronRight, Plug } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { appsOptions, changeApp } from '../../kit/apps/data';
import {
  connectionError,
  connectionsOptions,
} from '../../kit/connections/data';
import { AppAccessDialog } from './access';
import {
  appCategoryLabel,
  appConnectionSummary,
  AppIcon,
} from './presentation';

// Rows name at most this many connections; the rest are counted.
const namedConnections = 3;

/**
 * Lists installed apps with the health of their connections, apps that can be installed, and
 * earlier apps whose connections Luma keeps. Installing asks for consent first and then opens
 * the app's page so the next step, adding a connection, is in view.
 */
export function AppStore({
  organizationId,
  canManage,
  install: requested,
  refresh,
}: {
  organizationId: string;
  canManage: boolean;
  /** An app to set up on arrival: its consent opens, or its page when already installed. */
  install?: string | undefined;
  refresh: () => Promise<void>;
}) {
  const query = useQuery(appsOptions(organizationId));
  const connections = useQuery(connectionsOptions(organizationId));
  const client = useQueryClient();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const [message, setMessage] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  // The requested app's consent shows until the person answers it or picks another app; it
  // outlives the search parameter, which is cleared on arrival.
  const [request, setRequest] = useState(requested);
  const reviewing =
    chosen ??
    (request &&
    canManage &&
    query.data?.catalog.some((app) => app.id === request)
      ? request
      : null);
  const setReviewing = (appId: string | null) => {
    setRequest(undefined);
    setChosen(appId);
  };
  useEffect(() => {
    if (!requested || !canManage || !query.data) return;
    const installed = query.data.installations.some(
      (item) => item.appId === requested && item.status === 'installed',
    );
    if (installed) {
      void navigate({
        to: '/app/$organizationId/apps/$appId/settings',
        params: { organizationId, appId: requested },
        replace: true,
      });

      return;
    }
    // Closing the consent must not reopen it on reload or back navigation.
    void navigate({
      to: '/app/$organizationId/apps',
      params: { organizationId },
      search: (search) => ({ ...search, install: undefined }),
      replace: true,
    });
  }, [requested, canManage, query.data, organizationId, navigate]);

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

  if (query.isPending)
    return (
      <div className="apps-loading" role="status">
        <span className="sr-only">{m.apps_store_loading()}</span>
        <span className="lu-skeleton" />
        <span className="lu-skeleton" />
        <span className="lu-skeleton" />
      </div>
    );
  if (query.error)
    return (
      <Alert tone="danger" role="alert">
        {connectionError(query.error)}{' '}
        <Button
          variant="outline"
          size="sm"
          onClick={() => void query.refetch()}
        >
          {m.common_retry()}
        </Button>
      </Alert>
    );
  const catalog = query.data.catalog;
  const installed = query.data.installations
    .filter((app) => app.status === 'installed')
    .map((installation) => ({
      installation,
      app: catalog.find((item) => item.id === installation.appId),
    }))
    .sort((a, b) =>
      (a.app?.name ?? a.installation.appId).localeCompare(
        b.app?.name ?? b.installation.appId,
      ),
    );
  const available = catalog.filter(
    (app) => !installed.some((item) => item.installation.appId === app.id),
  );
  const byApp = (appId: string) =>
    connections.data?.filter((item) => item.appId === appId) ?? [];
  // Retain access to historical connections after uninstall or removal from the catalog.
  const historical = [
    ...new Set(
      connections.data
        ?.map((item) => item.appId)
        .filter((id): id is string => !!id),
    ),
  ].filter((id) => !installed.some((item) => item.installation.appId === id));

  return (
    <>
      <section className="apps-section" aria-labelledby="installed-apps">
        <div className="apps-section-heading">
          <h2 id="installed-apps">{m.apps_store_installed_title()}</h2>
          {installed.length ? (
            <span className="apps-section-count">{installed.length}</span>
          ) : null}
        </div>
        {connections.error ? (
          <Alert tone="warning" role="alert">
            {connectionError(connections.error)}
          </Alert>
        ) : null}
        {installed.length ? (
          <ul className="apps-rows">
            {installed.map(({ installation, app }) => (
              <InstalledApp
                key={installation.appId}
                organizationId={organizationId}
                appId={installation.appId}
                app={app}
                pendingAccess={installation.pendingScopes.length > 0}
                connections={byApp(installation.appId)}
                connectionsState={
                  connections.isPending
                    ? 'loading'
                    : connections.error
                      ? 'failed'
                      : 'ready'
                }
              />
            ))}
          </ul>
        ) : (
          <Empty className="apps-empty">
            <Plug aria-hidden="true" />
            <h3>{m.apps_store_installed_empty_title()}</h3>
            <p>{m.apps_store_installed_empty()}</p>
          </Empty>
        )}
      </section>
      <section className="apps-section" aria-labelledby="available-apps">
        <div className="apps-section-heading">
          <h2 id="available-apps">{m.apps_store_available_title()}</h2>
        </div>
        {!canManage ? (
          <p className="apps-note">{m.apps_store_manage_denied()}</p>
        ) : null}
        {available.length ? (
          <div className="apps-catalog">
            {available.map((app) => (
              <CatalogApp
                key={app.id}
                app={app}
                disabled={!canManage || pending}
                install={() => {
                  setMessage('');
                  setReviewing(app.id);
                }}
              />
            ))}
          </div>
        ) : (
          <p className="apps-note">{m.apps_store_available_empty()}</p>
        )}
      </section>
      {historical.length ? (
        <section className="apps-section" aria-labelledby="past-apps">
          <div className="apps-section-heading">
            <h2 id="past-apps">{m.apps_store_history_title()}</h2>
          </div>
          <p className="apps-note">{m.apps_store_history_description()}</p>
          <ul className="apps-rows" data-variant="history">
            {historical.map((appId) => {
              const app = catalog.find((item) => item.id === appId);
              const count = byApp(appId).length;

              return (
                <li key={appId} className="app-row">
                  <AppIcon category={app?.category} />
                  <div className="app-row-main">
                    <h3>
                      <Link
                        className="app-row-link"
                        to="/app/$organizationId/apps/$appId/settings"
                        params={{ organizationId, appId }}
                      >
                        {app?.name ?? appId}
                      </Link>
                    </h3>
                    <p className="app-row-meta">
                      {m.apps_store_history_connections({ count })}
                    </p>
                  </div>
                  <div className="app-row-status">
                    <Badge>{m.apps_store_not_installed()}</Badge>
                  </div>
                  <ChevronRight
                    className="app-row-chevron"
                    size={16}
                    aria-hidden="true"
                  />
                </li>
              );
            })}
          </ul>
        </section>
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

/**
 * One installed app as a row: what it connects, which connections it has and whether any needs
 * someone. The row opens the app's page, at the first connection that needs attention.
 */
function InstalledApp({
  organizationId,
  appId,
  app,
  pendingAccess,
  connections,
  connectionsState,
}: {
  organizationId: string;
  appId: string;
  app: AppManifest | undefined;
  pendingAccess: boolean;
  connections: InstalledConnection[];
  connectionsState: 'loading' | 'failed' | 'ready';
}) {
  const connector = !app || app.connectionTypes.length > 0;
  const summary = appConnectionSummary(connections);
  const names = summary.live.map((item) => item.label);
  const shown = names.slice(0, namedConnections);
  const hidden = names.length - shown.length;
  const meta = !app
    ? m.apps_store_app_unavailable()
    : !connector
      ? app.description
      : connectionsState === 'loading'
        ? m.apps_connections_loading()
        : connectionsState === 'failed'
          ? m.apps_store_connections_unavailable()
          : names.length
            ? hidden
              ? m.apps_store_connections_more({
                  names: formatList(shown, { type: 'unit', style: 'short' }),
                  count: hidden,
                })
              : formatList(shown)
            : null;

  return (
    <li
      className="app-row"
      data-attention={
        (connectionsState === 'ready' && summary.attention.length > 0) ||
        pendingAccess ||
        undefined
      }
    >
      <AppIcon category={app?.category} />
      <div className="app-row-main">
        <h3>
          <Link
            className="app-row-link"
            to="/app/$organizationId/apps/$appId/settings"
            params={{ organizationId, appId }}
            hash={
              connectionsState === 'ready' && summary.attention[0]
                ? `connection-${summary.attention[0].id}`
                : ''
            }
          >
            {app?.name ?? appId}
          </Link>
        </h3>
        <p className="app-row-meta">
          {app ? <span>{appCategoryLabel(app.category)}</span> : null}
          {meta ? <span>{meta}</span> : null}
        </p>
      </div>
      <div className="app-row-status">
        {pendingAccess ? (
          <Badge tone="warning">{m.apps_store_access_review()}</Badge>
        ) : null}
        {connector && connectionsState === 'ready' ? (
          <>
            <StatePill state={summary.state}>{summary.label}</StatePill>
            {summary.live.length ? (
              <span className="app-row-count">
                {m.apps_store_connections_count({
                  count: summary.live.length,
                })}
              </span>
            ) : null}
          </>
        ) : null}
      </div>
      <ChevronRight className="app-row-chevron" size={16} aria-hidden="true" />
    </li>
  );
}

/** An app that can be installed, with what it connects and does. */
function CatalogApp({
  app,
  disabled,
  install,
}: {
  app: AppManifest;
  disabled: boolean;
  install: () => void;
}) {
  return (
    <Card as="article" className="app-tile" aria-labelledby={`app-${app.id}`}>
      <div className="app-tile-head">
        <AppIcon category={app.category} />
        <div>
          <h3 id={`app-${app.id}`}>{app.name}</h3>
          <p>{appCategoryLabel(app.category)}</p>
        </div>
      </div>
      <p className="app-tile-description">{app.description}</p>
      <Button
        variant="outline"
        disabled={disabled}
        onClick={install}
        aria-label={m.apps_store_install({ app: app.name })}
      >
        {m.apps_store_install_short()}
      </Button>
    </Card>
  );
}
