import { WorkspaceAccountMenu } from '@luma/ui/components/workspace-account-menu';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useParams } from '@tanstack/react-router';
import { BookOpen, Inbox, LayoutDashboard, Unplug } from 'lucide-react';

import { Brand, Failure, Pending } from './common';
import { contextOptions, organizationsOptions, sessionOptions } from './data';
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
      {(['overview', 'exceptions', 'playbooks', 'connections'] as const).map(
        (page) => (
          <Link
            key={page}
            to={`/app/$organizationId/${page}`}
            params={{ organizationId }}
            activeProps={{ 'aria-current': 'page', className: 'active' }}
            onClick={close}
          >
            {page === 'overview' ? (
              <LayoutDashboard size={18} aria-hidden="true" />
            ) : page === 'exceptions' ? (
              <Inbox size={18} aria-hidden="true" />
            ) : page === 'playbooks' ? (
              <BookOpen size={18} aria-hidden="true" />
            ) : (
              <Unplug size={18} aria-hidden="true" />
            )}
            {page === 'exceptions'
              ? 'Issues'
              : page[0]!.toUpperCase() + page.slice(1)}
          </Link>
        ),
      )}
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
  const page = pathname.includes('/exceptions')
    ? 'Issues'
    : pathname.includes('/playbooks')
      ? 'Playbooks'
      : pathname.includes('/connections')
        ? 'Connections'
        : 'Overview';
  const client = useQueryClient();
  const access = useQuery(contextOptions(organizationId));
  const organizations = useQuery(organizationsOptions());
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
  if (access.isPending || organizations.isPending) return <Pending />;
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
          <span>Operations</span>
          <span aria-hidden="true">/</span>
          <span>{page}</span>
        </>
      }
      search={<WorkspaceSearch organizationId={organizationId} />}
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
          switchLink={<Link to="/app/workspaces" />}
        />
      }
    >
      <Outlet />
    </WorkspaceLayout>
  );
}
