import { Alert, AlertDescription } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import { Empty } from '@luma/ui/components/primitives/empty';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { AccessDialog, MembershipDialog, RevokeSessionsDialog } from './access';
import { AccessHistory } from './access-history';
import { Failure, Loading } from './feedback';
import { WorkspaceHealth } from './health';
import { sessionOptions, workspaceOptions } from './queries';
import { workspaceRoute } from './router';
import {
  SupportAccessRequestDialog,
  SupportAccessStatus,
  SupportViewDialog,
} from './support-view';

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
  const [viewAs, setViewAs] = useState<{
    userId: string;
    name: string;
    email: string;
  } | null>(null);
  const [askAccess, setAskAccess] = useState(false);
  const [membership, setMembership] = useState<{
    userId: string;
    email: string;
    action: 'suspend' | 'reactivate';
    soleOwner: boolean;
  } | null>(null);
  const canInspect =
    session.data?.permissions.includes('staff.workspace.inspect') ?? false;
  const canRevoke =
    session.data?.permissions.includes('staff.sessions.revoke') ?? false;
  const canManageMemberships =
    session.data?.permissions.includes('staff.memberships.manage') ?? false;
  const canViewAs =
    session.data?.permissions.includes('staff.view-as') ?? false;
  const canEmergencyView =
    session.data?.permissions.includes('staff.view-as.emergency') ?? false;
  const consented = !!detail.data?.supportAccess.allowedUntil;
  const activeOwners =
    detail.data?.members.filter(
      (member) => member.owner && member.status === 'active',
    ).length ?? 0;
  const membersTruncated = detail.data?.membersTruncated ?? false;
  const onlyHere =
    detail.data?.members.filter(
      (member) => member.onlyWorkspace && !member.accountDisabled,
    ).length ?? 0;

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
          {activeOwners === 0 &&
          detail.data.members.length &&
          !membersTruncated ? (
            <Alert tone="warning">
              <AlertDescription>
                This workspace has no active owner. Its owners’ access is
                suspended, so nobody in the workspace can change ownership.
              </AlertDescription>
            </Alert>
          ) : null}
          <Alert>
            <AlertDescription>
              Support access is time-limited. Connection status and last sync
              time do not establish that operational issues have been resolved.
            </AlertDescription>
          </Alert>
          {detail.isFetching ? (
            <Loading>Refreshing workspace records…</Loading>
          ) : null}
          {canViewAs || canEmergencyView ? (
            <SupportAccessStatus
              access={detail.data.supportAccess}
              canRequest={canViewAs}
              onRequest={() => setAskAccess(true)}
            />
          ) : null}
          <section
            className="staff-section"
            aria-labelledby="workspace-members"
          >
            <h2 id="workspace-members">Members</h2>
            {onlyHere > 0 ? (
              <p className="staff-muted">
                {onlyHere === 1
                  ? '1 member belongs only to this workspace.'
                  : `${onlyHere} members belong only to this workspace.`}{' '}
                To ban the workspace, disable their accounts from their account
                pages as well.
              </p>
            ) : null}
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
                      <Link
                        to="/accounts/$userId"
                        params={{ userId: row.userId }}
                        search={{}}
                        className="staff-link"
                      >
                        {row.name}
                      </Link>
                      <p className="staff-muted">{row.email}</p>
                      <p className="staff-muted staff-member-role-narrow">
                        Workspace role: {row.role}
                      </p>
                      {row.accountDisabled || row.onlyWorkspace ? (
                        <div className="staff-badges">
                          {row.accountDisabled ? (
                            <Badge tone="danger">Account disabled</Badge>
                          ) : null}
                          {row.onlyWorkspace ? (
                            <Badge>Only in this workspace</Badge>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ),
                },
                {
                  key: 'role',
                  header: 'Workspace role',
                  hideOnNarrow: true,
                  cell: (row) => row.role,
                },
                {
                  key: 'status',
                  header: 'Membership',
                  cell: (row) =>
                    row.status === 'suspended' ? (
                      <div>
                        <Badge tone="warning">Suspended</Badge>
                        <p className="staff-muted">
                          {row.suspendedBy === 'account_deletion'
                            ? 'Account scheduled for deletion'
                            : row.suspendedBy === 'staff'
                              ? 'By Luma support'
                              : 'By the workspace'}
                          {row.suspendedAt
                            ? `, ${new Date(row.suspendedAt).toLocaleString()}`
                            : ''}
                        </p>
                      </div>
                    ) : (
                      <Badge>Active</Badge>
                    ),
                },
                ...(canRevoke ||
                canManageMemberships ||
                canViewAs ||
                canEmergencyView
                  ? [
                      {
                        key: 'actions',
                        header: 'Account actions',
                        cell: (row: {
                          userId: string;
                          name: string;
                          email: string;
                          owner: boolean;
                          status: 'active' | 'suspended';
                          suspendedBy:
                            'staff' | 'customer' | 'account_deletion' | null;
                          accountDisabled: boolean;
                        }) => (
                          <div className="staff-actions">
                            {(canViewAs && consented) || canEmergencyView ? (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={
                                  row.status !== 'active' || row.accountDisabled
                                }
                                onClick={() => setViewAs(row)}
                                aria-label={`View as ${row.email}`}
                              >
                                View as
                              </Button>
                            ) : null}
                            {canRevoke ? (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setTarget(row)}
                                aria-label={`Revoke sessions for ${row.email}`}
                              >
                                Revoke sessions
                              </Button>
                            ) : null}
                            {/* Restoring the account brings these memberships back. */}
                            {canManageMemberships &&
                            row.suspendedBy !== 'account_deletion' ? (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  setMembership({
                                    userId: row.userId,
                                    email: row.email,
                                    action:
                                      row.status === 'active'
                                        ? 'suspend'
                                        : 'reactivate',
                                    // A truncated list can't rule out other owners;
                                    // asking for the acknowledgement then is harmless.
                                    soleOwner:
                                      row.owner &&
                                      row.status === 'active' &&
                                      (activeOwners === 1 || membersTruncated),
                                  })
                                }
                                aria-label={`${row.status === 'active' ? 'Suspend' : 'Reactivate'} membership for ${row.email}`}
                              >
                                {row.status === 'active'
                                  ? 'Suspend'
                                  : 'Reactivate'}
                              </Button>
                            ) : null}
                          </div>
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
          <WorkspaceHealth workspaceId={workspaceId} grantId={grantId} />
          <AccessHistory workspaceId={workspaceId} grantId={grantId} />
        </>
      )}
      {requestAccess && canInspect ? (
        <AccessDialog
          workspaceId={workspaceId}
          name={detail.data?.workspace.name ?? 'workspace'}
          onClose={() => setRequestAccess(false)}
        />
      ) : null}
      {membership && canManageMemberships && detail.isSuccess ? (
        <MembershipDialog
          key={`${membership.userId}:${membership.action}`}
          workspaceId={workspaceId}
          grantId={grantId}
          member={membership}
          action={membership.action}
          soleOwner={membership.soleOwner}
          onClose={() => setMembership(null)}
        />
      ) : null}
      {viewAs && detail.isSuccess ? (
        <SupportViewDialog
          key={viewAs.userId}
          workspaceId={workspaceId}
          grantId={grantId}
          member={viewAs}
          consented={consented}
          canConsent={canViewAs}
          canEmergency={canEmergencyView}
          onClose={() => setViewAs(null)}
        />
      ) : null}
      {askAccess && canViewAs && detail.isSuccess ? (
        <SupportAccessRequestDialog
          workspaceId={workspaceId}
          grantId={grantId}
          onClose={() => setAskAccess(false)}
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
