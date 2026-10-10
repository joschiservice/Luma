import { Alert, AlertDescription } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Empty } from '@luma/ui/components/primitives/empty';
import {
  Field,
  FieldError,
  FieldLabel,
} from '@luma/ui/components/primitives/field';
import { Textarea } from '@luma/ui/components/primitives/textarea';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { reasonSchema } from './access';
import { AccountSecurityEvents } from './account-security';
import { AccountStatusDialog, categoryLabel } from './account-status';
import { staffApi } from './api';
import { Failure, Loading } from './feedback';
import { accountOptions, sessionOptions } from './queries';
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
  const [requestAccess, setRequestAccess] = useState(false);
  // Fixed when the dialog opens, so the refetch after the change doesn't flip its wording.
  const [statusChange, setStatusChange] = useState<'disable' | 'enable' | null>(
    null,
  );
  const canInspect =
    session.data?.permissions.includes('staff.accounts.inspect') ?? false;
  const canManage =
    session.data?.permissions.includes('staff.accounts.manage') ?? false;

  return (
    <>
      <Link to="/" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
        Back to directory
      </Link>
      {!grantId ? (
        <>
          <PageHeader title="Account support access" />
          <Alert tone="warning">
            <AlertDescription>
              {canInspect
                ? 'Account details require current account support access.'
                : 'Your staff role does not allow account inspection.'}
            </AlertDescription>
          </Alert>
          {canInspect ? (
            <Button onClick={() => setRequestAccess(true)}>
              Open account access
            </Button>
          ) : null}
        </>
      ) : detail.isPending ? (
        <Loading>Checking access and reading account…</Loading>
      ) : detail.isError ? (
        <>
          <PageHeader title="Account unavailable" />
          <Failure error={detail.error} retry={() => void detail.refetch()} />
          {canInspect ? (
            <Button variant="outline" onClick={() => setRequestAccess(true)}>
              Request new account access
            </Button>
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
                {canManage ? (
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
                      search={{}}
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
      {requestAccess && canInspect ? (
        <AccountAccessDialog
          userId={userId}
          name={detail.data?.account.name ?? 'account'}
          onClose={() => setRequestAccess(false)}
        />
      ) : null}
    </>
  );
}

/** Requests auditable, account-scoped access before displaying account details. */
function AccountAccessDialog({
  userId,
  name,
  onClose,
}: {
  userId: string;
  name: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const access = useMutation({
    mutationFn: (reason: string) => staffApi.grantAccount(userId, reason),
    onSuccess: async (grant) => {
      onClose();
      await navigate({
        to: '/accounts/$userId',
        params: { userId },
        search: { grantId: grant.id },
      });
    },
  });
  const form = useForm({
    defaultValues: { reason: '' },
    onSubmit: async ({ value }) => {
      try {
        await access.mutateAsync(reasonSchema.parse(value.reason));
      } catch {
        /* Mutation and field feedback describe the failed request. */
      }
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !access.isPending) onClose();
      }}
    >
      <DialogContent showCloseButton={!access.isPending}>
        <DialogHeader>
          <DialogTitle>Inspect {name}</DialogTitle>
          <DialogDescription>
            Open time-limited support access to this customer account. Your
            identity, reason and subsequent reads are recorded.
          </DialogDescription>
        </DialogHeader>
        <form
          className="staff-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <form.Field name="reason" validators={{ onChange: reasonSchema }}>
            {(field) => (
              <Field>
                <FieldLabel htmlFor="account-access-reason">
                  Support reason or ticket reference
                </FieldLabel>
                <Textarea
                  id="account-access-reason"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  disabled={access.isPending}
                  maxLength={500}
                  aria-invalid={field.state.meta.errors.length > 0}
                  aria-describedby="account-access-reason-error"
                />
                <FieldError
                  id="account-access-reason-error"
                  errors={field.state.meta.errors}
                />
              </Field>
            )}
          </form.Field>
          {access.isError ? <Failure error={access.error} /> : null}
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              onClick={onClose}
              disabled={access.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={access.isPending}>
              {access.isPending ? 'Opening access…' : 'Open account access'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
