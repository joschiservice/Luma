import { Alert, AlertDescription } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import { Empty } from '@luma/ui/components/primitives/empty';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import {
  AccountDeletionDialog,
  deletionCategoryLabel,
} from './account-deletion';
import { AccountSecurityEvents } from './account-security';
import { AccountStatusDialog, categoryLabel } from './account-status';
import { Failure, Loading } from './feedback';
import { InspectionAccess } from './inspection';
import { accountOptions, sessionOptions } from './queries';
import { staffRegion } from './regions';
import { accountRoute } from './router';

const dateTime = (value: string) => new Date(value).toLocaleString();

function roleLabel(row: { role: string; customRoleName: string | null }) {
  if (row.role === 'custom') return row.customRoleName ?? 'Custom role';

  return row.role.charAt(0).toUpperCase() + row.role.slice(1);
}

function deviceLabel(row: { browser: string | null; os: string | null }) {
  if (row.browser && row.os) return `${row.browser} on ${row.os}`;

  return row.browser ?? row.os ?? 'Unknown device';
}

/** Inspects one customer account under a server-validated account support grant. */
export function AccountPage() {
  const { userId } = accountRoute.useParams();
  const { grantId = '' } = accountRoute.useSearch();
  const session = useQuery(sessionOptions());
  const detail = useQuery({
    ...accountOptions(userId, grantId),
    refetchInterval: 30_000,
  });
  // Fixed when the dialog opens, so the refetch after the change doesn't flip its wording.
  const [statusChange, setStatusChange] = useState<'disable' | 'enable' | null>(
    null,
  );
  const canInspect =
    session.data?.permissions.includes('staff.accounts.inspect') ?? false;
  const canManage =
    session.data?.permissions.includes('staff.accounts.manage') ?? false;
  const canDelete =
    session.data?.permissions.includes('staff.accounts.delete') ?? false;
  const canEmergency =
    session.data?.permissions.includes('staff.inspect.emergency') ?? false;
  const [deletionChange, setDeletionChange] = useState<
    'schedule' | 'restore' | 'erase_now' | null
  >(null);

  return (
    <>
      <Link
        to="/"
        search={{ region: staffRegion() }}
        className={buttonVariants({ variant: 'ghost', size: 'sm' })}
      >
        Back to directory
      </Link>
      {!grantId ? (
        <>
          <PageHeader title="Account support access" />
          {canInspect ? (
            <InspectionAccess
              target={{ kind: 'account', id: userId }}
              canEmergency={canEmergency}
            />
          ) : (
            <Alert tone="warning">
              <AlertDescription>
                Your staff role does not allow account inspection.
              </AlertDescription>
            </Alert>
          )}
        </>
      ) : detail.isPending ? (
        <Loading>Checking access and reading account…</Loading>
      ) : detail.isError ? (
        <>
          <PageHeader title="Account unavailable" />
          <Failure error={detail.error} retry={() => void detail.refetch()} />
          {canInspect ? (
            <InspectionAccess
              target={{ kind: 'account', id: userId }}
              canEmergency={canEmergency}
            />
          ) : null}
        </>
      ) : (
        <>
          <PageHeader
            title={detail.data.account.name}
            description={detail.data.account.email}
            actions={
              <>
                <Button
                  variant="outline"
                  disabled={detail.isFetching}
                  onClick={() => void detail.refetch()}
                >
                  Refresh
                </Button>
                {/* A scheduled deletion keeps the account disabled until it is restored. */}
                {canManage && !detail.data.deletion ? (
                  <Button
                    variant={detail.data.disabled ? 'default' : 'destructive'}
                    onClick={() =>
                      setStatusChange(
                        detail.data.disabled ? 'enable' : 'disable',
                      )
                    }
                  >
                    {detail.data.disabled
                      ? 'Enable account'
                      : 'Disable account'}
                  </Button>
                ) : null}
                {canDelete && !detail.data.deletion?.eraseRequestedAt ? (
                  <>
                    <Button
                      variant={detail.data.deletion ? 'default' : 'outline'}
                      onClick={() =>
                        setDeletionChange(
                          detail.data.deletion ? 'restore' : 'schedule',
                        )
                      }
                    >
                      {detail.data.deletion
                        ? 'Restore account'
                        : 'Schedule deletion'}
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() => setDeletionChange('erase_now')}
                    >
                      Erase now
                    </Button>
                  </>
                ) : null}
              </>
            }
          />
          {detail.data.disabled ? (
            <Alert tone="danger">
              <AlertDescription>
                Account disabled {dateTime(detail.data.disabled.at)}
                {detail.data.disabled.byName
                  ? ` by ${detail.data.disabled.byName}`
                  : ''}{' '}
                · {categoryLabel(detail.data.disabled.category)}:{' '}
                {detail.data.disabled.reason}. The person can’t sign in, and
                every workspace rejects them.
              </AlertDescription>
            </Alert>
          ) : null}
          {detail.data.deletion ? (
            <Alert tone="danger">
              <AlertDescription>
                {detail.data.deletion.eraseRequestedAt
                  ? `Erasure requested ${dateTime(detail.data.deletion.eraseRequestedAt)}; the account is erased within minutes and can’t be restored.`
                  : `Scheduled for deletion ${dateTime(detail.data.deletion.scheduledAt)}${detail.data.deletion.byName ? ` by ${detail.data.deletion.byName}` : ''}. Erased after ${dateTime(detail.data.deletion.eraseAfter)} unless restored.`}{' '}
                {deletionCategoryLabel(detail.data.deletion.category)},
                reference {detail.data.deletion.reference}. The person can’t
                sign in, and their memberships are suspended.
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="staff-metadata">
            <span>Created: {dateTime(detail.data.account.createdAt)}</span>
            <span>
              Two-factor authentication:{' '}
              <Badge>
                {detail.data.security.twoFactorEnabled ? 'On' : 'Off'}
              </Badge>
            </span>
            <span>
              Passkeys:{' '}
              {detail.data.security.passkeys === 0
                ? 'None registered'
                : detail.data.security.passkeys}
            </span>
          </div>
          <Alert>
            <AlertDescription>
              Account support access is time-limited and grants no workspace
              access. Open a workspace to request its own support access.
            </AlertDescription>
          </Alert>
          {detail.isFetching ? (
            <Loading>Refreshing account records…</Loading>
          ) : null}
          <section
            className="staff-section"
            aria-labelledby="account-workspaces"
          >
            <h2 id="account-workspaces">Workspaces</h2>
            {detail.data.workspacesTruncated ? (
              <Alert tone="warning">
                <AlertDescription>
                  Only the first 100 workspaces are shown. This list is
                  incomplete.
                </AlertDescription>
              </Alert>
            ) : null}
            <DataTable
              caption="Account workspaces"
              rows={detail.data.workspaces}
              rowKey={(row) => row.id}
              columns={[
                {
                  key: 'name',
                  header: 'Workspace',
                  cell: (row) => (
                    <Link
                      to="/workspaces/$workspaceId"
                      params={{ workspaceId: row.id }}
                      search={{ region: staffRegion() }}
                      className="staff-link"
                    >
                      {row.name}
                    </Link>
                  ),
                },
                { key: 'role', header: 'Role', cell: roleLabel },
                {
                  key: 'membership',
                  header: 'Membership',
                  cell: (row) =>
                    row.membershipStatus === 'suspended' ? (
                      <Badge tone="warning">Suspended</Badge>
                    ) : (
                      <Badge>Active</Badge>
                    ),
                },
                {
                  key: 'status',
                  header: 'Workspace status',
                  hideOnNarrow: true,
                  cell: (row) => <Badge>{row.status}</Badge>,
                },
                {
                  key: 'joined',
                  header: 'Joined',
                  hideOnNarrow: true,
                  cell: (row) => dateTime(row.joinedAt),
                },
              ]}
              empty={
                <Empty>
                  <h3>No workspaces</h3>
                  <p>This account does not belong to any workspace.</p>
                </Empty>
              }
            />
          </section>
          <section className="staff-section" aria-labelledby="account-sessions">
            <h2 id="account-sessions">Active sessions</h2>
            {detail.data.sessionsTruncated ? (
              <Alert tone="warning">
                <AlertDescription>
                  Only the 100 most recently active sessions are shown.
                </AlertDescription>
              </Alert>
            ) : null}
            <DataTable
              caption="Active customer sessions"
              rows={detail.data.sessions}
              rowKey={(row) => row.id}
              columns={[
                {
                  key: 'device',
                  header: 'Device',
                  cell: (row) => (
                    <div>
                      {deviceLabel(row)}
                      <p className="staff-muted">
                        {row.ipAddress ?? 'No IP address recorded'}
                      </p>
                    </div>
                  ),
                },
                {
                  key: 'lastActive',
                  header: 'Last active',
                  cell: (row) =>
                    row.lastActiveAt
                      ? dateTime(row.lastActiveAt)
                      : 'Not recorded',
                },
                {
                  key: 'created',
                  header: 'Signed in',
                  hideOnNarrow: true,
                  cell: (row) => dateTime(row.createdAt),
                },
                {
                  key: 'expires',
                  header: 'Expires',
                  hideOnNarrow: true,
                  cell: (row) => dateTime(row.expiresAt),
                },
              ]}
              empty={
                <Empty>
                  <h3>No active sessions</h3>
                  <p>This account is not signed in anywhere.</p>
                </Empty>
              }
            />
          </section>
          <AccountSecurityEvents userId={userId} grantId={grantId} />
        </>
      )}
      {statusChange && detail.data ? (
        <AccountStatusDialog
          userId={userId}
          grantId={grantId}
          email={detail.data.account.email}
          action={statusChange}
          onClose={() => setStatusChange(null)}
        />
      ) : null}
      {deletionChange && detail.data ? (
        <AccountDeletionDialog
          userId={userId}
          grantId={grantId}
          email={detail.data.account.email}
          action={deletionChange}
          onClose={() => setDeletionChange(null)}
        />
      ) : null}
    </>
  );
}
