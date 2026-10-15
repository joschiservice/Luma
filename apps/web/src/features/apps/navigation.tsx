import { m } from '@luma/i18n/messages';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import { appsOptions } from '../../kit/apps/data';
import { usePermissions } from '../../kit/identity/permissions';

/** Adds a sidebar section for installed apps that contribute workspace pages. */
export function AppNavigation({
  organizationId,
  close,
}: {
  organizationId: string;
  close?: (() => void) | undefined;
}) {
  const { data } = useQuery(appsOptions(organizationId));
  const { can } = usePermissions(organizationId);
  const installed = new Set(
    data?.installations
      .filter((app) => app.status === 'installed')
      .map((app) => app.appId),
  );
  const pages =
    data?.catalog.filter(
      (app) =>
        installed.has(app.id) &&
        app.ui.includes('page') &&
        !!app.slotAccess.page &&
        can(app.slotAccess.page),
    ) ?? [];
  if (!pages.length) return null;

  return (
    <section className="sidebar-section" aria-labelledby="nav-apps">
      <h2 className="sidebar-section-label" id="nav-apps">
        {m.identity_nav_installed_apps()}
      </h2>
      <ul className="sidebar-list">
        {pages.map((app) => (
          <li key={app.id}>
            <Link
              className="sidebar-link"
              data-label={app.name}
              to="/app/$organizationId/apps/$appId"
              params={{ organizationId, appId: app.id }}
              preload={false}
              activeOptions={{ exact: true }}
              onClick={close}
              activeProps={{ 'aria-current': 'page' }}
            >
              <span className="sidebar-app-icon" aria-hidden="true">
                {app.name.slice(0, 1)}
              </span>
              <span className="sidebar-link-label">{app.name}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
