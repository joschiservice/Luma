import { Button } from '@luma/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@luma/ui/components/dialog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useParams } from '@tanstack/react-router';
import { useState } from 'react';

import { AccountMenu, Brand, Failure, Pending } from './common';
import { contextOptions, organizationsOptions, sessionOptions } from './data';

function Navigation({
  organizationId,
  close,
}: {
  organizationId: string;
  close?: () => void;
}) {
  return (
    <nav aria-label="Workspace navigation">
      {(['overview', 'exceptions', 'connections'] as const).map((page) => (
        <Link
          key={page}
          to={`/app/$organizationId/${page}`}
          params={{ organizationId }}
          activeProps={{ 'aria-current': 'page', className: 'active' }}
          onClick={close}
        >
          {page[0]!.toUpperCase() + page.slice(1)}
        </Link>
      ))}
    </nav>
  );
}

/** Provides workspace navigation and tenant context for nested application routes. */
export function WorkspaceShell() {
  const { organizationId } = useParams({ from: '/app/$organizationId' });

  return <TenantShell key={organizationId} organizationId={organizationId} />;
}

function TenantShell({ organizationId }: { organizationId: string }) {
  const client = useQueryClient();
  const access = useQuery(contextOptions(organizationId));
  const organizations = useQuery(organizationsOptions());
  const session = client.getQueryData(sessionOptions().queryKey);
  const [open, setOpen] = useState(false);
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
    <div className="desk">
      <a className="skip-link" href="#workspace-content">
        Skip to content
      </a>
      <aside className="desk-sidebar">
        <Brand />
        <p className="eyebrow">Exception Desk</p>
        <Navigation organizationId={organizationId} />
        <p className="sidebar-note">
          Room for a clearer
          <br />
          working day.
        </p>
      </aside>
      <div className="desk-body">
        <header className="desk-header">
          <div className="mobile-nav">
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger render={<Button variant="outline" />}>
                Menu
              </DialogTrigger>
              <DialogContent className="navigation-drawer">
                <DialogTitle>Exception Desk</DialogTitle>
                <DialogDescription>
                  Choose a destination in this workspace.
                </DialogDescription>
                <Navigation
                  organizationId={organizationId}
                  close={() => setOpen(false)}
                />
              </DialogContent>
            </Dialog>
          </div>
          <details className="workspace-switcher">
            <summary>{organization?.name ?? 'Workspace'}</summary>
            <div className="switcher-options">
              {organizations.data.map((org) => (
                <Link
                  key={org.id}
                  to="/app/$organizationId/overview"
                  params={{ organizationId: org.id }}
                >
                  {org.name}
                </Link>
              ))}
              <Link to="/app/workspaces/new">Create workspace</Link>
            </div>
          </details>
          <AccountMenu name={session?.user.name ?? 'Account'} />
        </header>
        <main id="workspace-content" tabIndex={-1} className="desk-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
