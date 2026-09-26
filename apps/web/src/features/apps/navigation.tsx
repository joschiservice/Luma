import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Puzzle } from 'lucide-react';

import { appsOptions } from './data';

/** Adds navigation entries for installed apps that contribute workspace pages. */
export function AppNavigation({
  organizationId,
  close,
}: {
  organizationId: string;
  close?: (() => void) | undefined;
}) {
  const { data } = useQuery(appsOptions(organizationId));
  const installed = new Set(
    data?.installations
      .filter((app) => app.status === 'installed')
      .map((app) => app.appId),
  );

  return data?.catalog
    .filter((app) => installed.has(app.id) && app.ui.includes('page'))
    .map((app) => (
      <Link
        key={app.id}
        to="/app/$organizationId/apps/$appId"
        params={{ organizationId, appId: app.id }}
        preload={false}
        onClick={close}
        activeProps={{ 'aria-current': 'page', className: 'active' }}
      >
        <Puzzle size={18} aria-hidden="true" />
        {app.name}
      </Link>
    ));
}
