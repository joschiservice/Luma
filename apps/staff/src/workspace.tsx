import { Alert, AlertDescription } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import { Empty } from '@luma/ui/components/primitives/empty';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { AccessDialog, RevokeSessionsDialog } from './access';
import { Failure, Loading } from './feedback';
import { sessionOptions, workspaceOptions } from './queries';
import { workspaceRoute } from './router';

/** Inspects current workspace records under a server-validated support access grant. */
export function WorkspacePage() {
  const { workspaceId } = workspaceRoute.useParams();
  const { grantId = '' } = workspaceRoute.useSearch();
  const session = useQuery(sessionOptions());
  const detail = useQuery({
    ...workspaceOptions(workspaceId, grantId),
    refetchInterval: 30_000,
  });
  const [requestAccess, setRequestAccess] = useState(false);
  const [target, setTarget] = useState<{
    userId: string;
    email: string;
  } | null>(null);
  const canInspect =
    session.data?.permissions.includes('staff.workspace.inspect') ?? false;
  const canRevoke =
    session.data?.permissions.includes('staff.sessions.revoke') ?? false;

  return (
    <>
      <Link to="/" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
        Back to directory
      </Link>
      {!grantId ? (
        <>
          <PageHeader title="Workspace support access" />
          <Alert tone="warning">
            <AlertDescription>
              Customer details require current support access.
            </AlertDescription>
          </Alert>
          {canInspect ? (
            <Button onClick={() => setRequestAccess(true)}>
              Open support access
            </Button>
          ) : null}
        </>
      ) : detail.isPending ? (
        <Loading>Checking access and reading workspace…</Loading>
      ) : detail.isError ? (
        <>
          <PageHeader title="Workspace unavailable" />
          <Failure error={detail.error} retry={() => void detail.refetch()} />
          {canInspect ? (
            <Button variant="outline" onClick={() => setRequestAccess(true)}>
              Request new support access
            </Button>
          ) : null}
        </>
      ) : (
        <>
          <PageHeader
            title={detail.data.workspace.name}
            description="Workspace records read through your support access grant."
            actions={
              <Button
                variant="outline"
                disabled={detail.isFetching}
                onClick={() => void detail.refetch()}
              >
                Refresh
              </Button>
            }
          />
          <div className="staff-metadata">
            <span>
              Status: <Badge>{detail.data.workspace.status}</Badge>
            </span>
            <span>Data region: {detail.data.workspace.dataRegion}</span>
            <span>Slug: {detail.data.workspace.slug}</span>
          </div>
          <Alert>
            <AlertDescription>
              Support access is time-limited. Connection status and last sync
              time do not establish that operational issues have been resolved.
            </AlertDescription>
          </Alert>
          {detail.isFetching ? (
            <Loading>Refreshing workspace records…</Loading>
          ) : null}
          <section
            className="staff-section"
            aria-labelledby="workspace-members"
          >
            <h2 id="workspace-members">Members</h2>
            {detail.data.membersTruncated ? (
              <Alert tone="warning">
                <AlertDescription>
                  Only the first 100 members are shown. This list is incomplete.
                </AlertDescription>
              </Alert>
            ) : null}
            <DataTable
              caption="Workspace members"
              rows={detail.data.members}
              rowKey={(row) => row.id}
              columns={[
                {
                  key: 'name',
                  header: 'Member',
                  cell: (row) => (
                    <div>
                      {row.name}
                      <p className="staff-muted">{row.email}</p>
                      <p className="staff-muted staff-member-role-narrow">
                        Workspace role: {row.role}
                      </p>
                    </div>
                  ),
                },
                {
                  key: 'role',
                  header: 'Workspace role',
                  hideOnNarrow: true,
                  cell: (row) => row.role,
                },
                ...(canRevoke
                  ? [
                      {
                        key: 'actions',
                        header: 'Account actions',
                        cell: (row: { userId: string; email: string }) => (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setTarget(row)}
                            aria-label={`Revoke sessions for ${row.email}`}
                          >
                            Revoke sessions
                          </Button>
                        ),
                      },
                    ]
                  : []),
              ]}
              empty={
                <Empty>
                  <h3>No members returned</h3>
                  <p>No workspace members were returned by this read.</p>
                </Empty>
              }
            />
          </section>
          <section
            className="staff-section"
            aria-labelledby="workspace-connections"
          >
            <h2 id="workspace-connections">Connections</h2>
            {detail.data.connectionsTruncated ? (
              <Alert tone="warning">
                <AlertDescription>
                  Only the first 100 connections are shown. This list is
                  incomplete.
                </AlertDescription>
              </Alert>
            ) : null}
            <DataTable
              caption="Workspace provider connections"
              rows={detail.data.connections}
              rowKey={(row) => row.id}
              columns={[
                {
                  key: 'provider',
                  header: 'Provider',
                  cell: (row) => row.provider,
                },
                {
                  key: 'status',
                  header: 'Connection status',
                  cell: (row) => <Badge>{row.status}</Badge>,
                },
                {
                  key: 'sync',
                  header: 'Last sync',
                  cell: (row) =>
                    row.lastSyncAt
                      ? new Date(row.lastSyncAt).toLocaleString()
                      : 'No sync recorded',
                },
              ]}
              empty={
                <Empty>
                  <h3>No connections returned</h3>
                  <p>No provider connections were returned by this read.</p>
                </Empty>
              }
            />
          </section>
        </>
      )}
      {requestAccess && canInspect ? (
        <AccessDialog
          workspaceId={workspaceId}
          name={detail.data?.workspace.name ?? 'workspace'}
          onClose={() => setRequestAccess(false)}
        />
      ) : null}
      {target && canRevoke && detail.isSuccess ? (
        <RevokeSessionsDialog
          key={target.userId}
          workspaceId={workspaceId}
          grantId={grantId}
          userId={target.userId}
          email={target.email}
          onClose={() => setTarget(null)}
        />
      ) : null}
    </>
  );
}
