import { Alert } from '@luma/ui/components/primitives/alert';
import { WorkspaceTimezone } from '@luma/ui/components/primitives/workspace-date';
import { WorkspaceAccountMenu } from '@luma/ui/components/workspace/workspace-account-menu';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useParams } from '@tanstack/react-router';

import { AppNavigation } from '../apps/navigation';
import { ContextHelp } from '../help/context-help';
import { settingsOptions } from '../settings/data';
import { Brand, Failure, Pending } from './common';
import { contextOptions, organizationsOptions, sessionOptions } from './data';
import { workspaceDestinations } from './workspace-destinations';
import { WorkspaceLayout } from './workspace-layout';
import { WorkspaceSearch } from './workspace-search';

function Navigation({
  organizationId,
  close,
}: {
  organizationId: string;
  close?: (() => void) | undefined;
}) {
  return (
    <nav aria-label="Workspace navigation">
      {workspaceDestinations.map(({ path, label, Icon }) => (
        <Link
          key={path}
          className={
            path === 'settings' ? 'workspace-settings-link' : undefined
          }
          to={`/app/$organizationId/${path}`}
          params={{ organizationId }}
          activeProps={{ 'aria-current': 'page', className: 'active' }}
          onClick={close}
        >
          <Icon size={18} aria-hidden="true" />
          {label}
        </Link>
      ))}
      <AppNavigation organizationId={organizationId} close={close} />
    </nav>
  );
}

/** Provides workspace navigation and tenant context for nested application routes. */
export function WorkspaceShell() {
  const { organizationId } = useParams({ from: '/app/$organizationId' });

  return <TenantShell key={organizationId} organizationId={organizationId} />;
}

function TenantShell({ organizationId }: { organizationId: string }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const page =
    workspaceDestinations.find(({ path }) => pathname.split('/')[3] === path) ??
    workspaceDestinations[0];
  const client = useQueryClient();
  const access = useQuery(contextOptions(organizationId));
  const organizations = useQuery(organizationsOptions());
  const settings = useQuery({
    ...settingsOptions(organizationId),
    refetchInterval: false,
  });
  const session = client.getQueryData(sessionOptions().queryKey);
  if (access.isError)
    return <Failure error={access.error} retry={() => void access.refetch()} />;
  if (organizations.isError)
    return (
      <Failure
        error={organizations.error}
        retry={() => void organizations.refetch()}
      />
    );
  if (access.isPending || organizations.isPending || settings.isPending)
    return <Pending />;
  const organization = organizations.data.find(
    (org) => org.id === organizationId,
  );

  return (
    <WorkspaceLayout
      brand={<Brand />}
      navigation={(close) => (
        <Navigation organizationId={organizationId} close={close} />
      )}
      context={
        <>
          <page.Icon size={16} aria-hidden="true" />
          <span aria-current="page">{page.label}</span>
        </>
      }
      search={<WorkspaceSearch organizationId={organizationId} />}
      help={<ContextHelp />}
      accountMenu={
        <WorkspaceAccountMenu
          name={session?.user.name ?? 'Account'}
          workspace={organization?.name ?? 'Workspace'}
          workspaceId={organizationId}
          workspaces={organizations.data.map((org) => ({
            id: org.id,
            name: org.name,
            link: (
              <Link
                to="/app/$organizationId/overview"
                params={{ organizationId: org.id }}
              />
            ),
          }))}
          createLink={<Link to="/app/workspaces/new" />}
        />
      }
    >
      <WorkspaceTimezone value={settings.data?.workspace.timezone ?? 'UTC'}>
        {settings.isError ? (
          <Alert tone="warning" role="status">
            {settings.data
              ? 'Workspace settings could not refresh. Dates use the last known timezone.'
              : 'Display timezone unavailable. Dates are shown in UTC.'}
          </Alert>
        ) : null}
        <Outlet />
      </WorkspaceTimezone>
    </WorkspaceLayout>
  );
}
