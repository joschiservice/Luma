import { Alert, AlertDescription } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { Empty } from '@luma/ui/components/primitives/empty';
import {
  Field,
  FieldError,
  FieldLabel,
} from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';

import { Failure, Loading } from './feedback';
import { codeLabel, formatTime } from './health';
import { type AuditFilters, auditOptions, sessionOptions } from './queries';
import { auditRoute } from './router';

const eventLabels: Record<string, string> = {
  'staff.signed-in': 'Signed in',
  'staff.sign-in.failed': 'Sign-in failed',
  'staff.signed-out': 'Signed out',
  'staff.identity.provisioned': 'Staff access provisioned',
  'staff.local.provisioned': 'Local staff access provisioned',
  'directory.searched': 'Directory searched',
  'workspace.access.opened': 'Support access opened',
  'workspace.inspected': 'Workspace inspected',
  'workspace.health.read': 'Workspace health read',
  'workspace.access-history.read': 'Access history read',
  'customer.sessions.revoked': 'Customer sessions revoked',
  'staff.audit.read': 'Staff audit read',
};

const eventOptions = [
  { value: '', label: 'All events' },
  ...Object.entries(eventLabels).map(([value, label]) => ({ value, label })),
];

type Search = ReturnType<typeof auditRoute.useSearch>;

/** Converts local calendar days into the API's instant range; `to` includes the whole day. */
function filtersFrom(search: Search): AuditFilters {
  const end = search.to ? new Date(`${search.to}T00:00:00`) : null;
  end?.setDate(end.getDate() + 1);

  return {
    staff: search.staff || undefined,
    workspace: search.workspace,
    account: search.account || undefined,
    event: search.event,
    from: search.from
      ? new Date(`${search.from}T00:00:00`).toISOString()
      : undefined,
    to: end?.toISOString(),
  };
}

/** Reviews staff sign-ins, searches, support grants, reads and commands with bounded filters. */
export function AuditPage() {
  const search = auditRoute.useSearch();
  const session = useQuery(sessionOptions());
  const allowed =
    session.data?.permissions.includes('staff.audit.read') ?? false;
  const invalidRange = !!search.from && !!search.to && search.from > search.to;
  const audit = useInfiniteQuery(
    auditOptions(filtersFrom(search), allowed && !invalidRange),
  );
  if (!allowed)
    return (
      <>
        <PageHeader title="Staff audit log" />
        <Alert tone="warning">
          <AlertDescription>
            Your staff role does not allow reviewing the staff audit log.
          </AlertDescription>
        </Alert>
      </>
    );
  const entries = audit.data?.pages.flatMap((page) => page.entries) ?? [];

  return (
    <>
      <PageHeader
        title="Staff audit log"
        description="What staff did, newest first. Opening this log is recorded too."
        actions={
          audit.data ? (
            <Button variant="outline" onClick={() => void audit.refetch()}>
              Refresh
            </Button>
          ) : null
        }
      />
      <AuditFiltersForm key={JSON.stringify(search)} search={search} />
      {invalidRange ? null : audit.isPending ? (
        <Loading>Reading the staff audit log…</Loading>
      ) : !audit.data ? (
        <Failure error={audit.error} retry={() => void audit.refetch()} />
      ) : (
        <section
          className="staff-section"
          aria-labelledby="audit-entries"
          aria-busy={audit.isFetching}
        >
          <h2 id="audit-entries">Entries</h2>
          {audit.isError ? (
            <Failure error={audit.error} retry={() => void audit.refetch()} />
          ) : null}
          <DataTable
            caption="Staff audit entries, newest first"
            density="compact"
            rows={entries}
            rowKey={(row) => row.sequence}
            columns={[
              {
                key: 'event',
                header: 'Event',
                cell: (row) => (
                  <div>
                    {eventLabels[row.event] ?? codeLabel(row.event)}
                    {row.outcome === 'failed' ? (
                      <>
                        {' '}
                        <Badge tone="danger">Failed</Badge>
                      </>
                    ) : null}
                    <p className="staff-muted">{formatTime(row.createdAt)}</p>
                  </div>
                ),
              },
              {
                key: 'staff',
                header: 'Staff member',
                cell: (row) =>
                  row.staff ? (
                    <div>
                      {row.staff.name ?? 'Removed staff member'}
                      <p className="staff-muted">
                        {row.staff.email ?? row.staff.id.slice(0, 8)}
                      </p>
                      <Link
                        to="/audit"
                        search={{ staff: row.staff.email ?? row.staff.id }}
                        className="staff-link"
                      >
                        Only this staff member
                      </Link>
                    </div>
                  ) : (
                    'No staff session'
                  ),
              },
              {
                key: 'target',
                header: 'Workspace or account',
                cell: (row) => <Target entry={row} />,
              },
              {
                key: 'reason',
                header: 'Reason and request',
                hideOnNarrow: true,
                cell: (row) => (
                  <div>
                    {row.reason ?? 'No reason recorded'}
                    <p className="staff-muted">
                      Request <code>{row.requestId}</code>
                    </p>
                    {Object.keys(row.details).length ? (
                      <Disclosure variant="plain">
                        <summary>Details</summary>
                        <pre className="staff-details">
                          {JSON.stringify(row.details, null, 2)}
                        </pre>
                      </Disclosure>
                    ) : null}
                  </div>
                ),
              },
            ]}
            empty={
              <Empty>
                <h3>No matching entries</h3>
                <p>No staff audit entry matches these filters.</p>
              </Empty>
            }
          />
          {audit.hasNextPage ? (
            <Button
              variant="outline"
              onClick={() => {
                if (!audit.isFetchingNextPage) void audit.fetchNextPage();
              }}
            >
              {audit.isFetchingNextPage
                ? 'Loading older entries…'
                : 'Load older entries'}
            </Button>
          ) : entries.length ? (
            <p className="staff-muted">No older entries match these filters.</p>
          ) : null}
        </section>
      )}
    </>
  );
}

function Target({
  entry,
}: {
  entry: {
    workspace: { id: string; name: string | null } | null;
    account: { id: string; name: string | null; email: string | null } | null;
  };
}) {
  if (!entry.workspace && !entry.account) return '—';

  return (
    <div className="staff-target">
      {entry.workspace ? (
        <div>
          <Link
            to="/workspaces/$workspaceId"
            params={{ workspaceId: entry.workspace.id }}
            search={{}}
          >
            {entry.workspace.name ?? 'Deleted workspace'}
          </Link>
          <p className="staff-muted">
            Workspace {entry.workspace.id.slice(0, 8)} ·{' '}
            <Link
              to="/audit"
              search={{ workspace: entry.workspace.id }}
              className="staff-link"
            >
              Only this workspace
            </Link>
          </p>
        </div>
      ) : null}
      {entry.account ? (
        <div>
          {entry.account.email ? (
            <Link
              to="/accounts/$userId"
              params={{ userId: entry.account.id }}
              search={{}}
            >
              {entry.account.name ?? entry.account.email}
            </Link>
          ) : (
            'Deleted account'
          )}
          <p className="staff-muted">
            Account {entry.account.email ?? entry.account.id.slice(0, 8)} ·{' '}
            <Link
              to="/audit"
              search={{ account: entry.account.id }}
              className="staff-link"
            >
              Only this account
            </Link>
          </p>
        </div>
      ) : null}
    </div>
  );
}

function AuditFiltersForm({ search }: { search: Search }) {
  const navigate = auditRoute.useNavigate();
  const [values, setValues] = useState({
    staff: search.staff ?? '',
    workspace: search.workspace ?? '',
    account: search.account ?? '',
    event: search.event ?? '',
    from: search.from ?? '',
    to: search.to ?? '',
  });
  const set = (key: keyof typeof values) => (value: string) =>
    setValues((current) => ({ ...current, [key]: value }));
  const workspaceInvalid =
    !!values.workspace &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      values.workspace.trim(),
    );
  const rangeInvalid = !!values.from && !!values.to && values.from > values.to;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (workspaceInvalid || rangeInvalid) return;
    void navigate({
      search: {
        staff: values.staff.trim() || undefined,
        workspace: values.workspace.trim().toLowerCase() || undefined,
        account: values.account.trim() || undefined,
        event: values.event || undefined,
        from: values.from || undefined,
        to: values.to || undefined,
      },
    });
  };

  return (
    <form
      className="staff-audit-filters"
      aria-label="Filter staff audit entries"
      onSubmit={submit}
    >
      <Field>
        <FieldLabel htmlFor="audit-staff">Staff member email or ID</FieldLabel>
        <Input
          id="audit-staff"
          value={values.staff}
          maxLength={320}
          onChange={(event) => set('staff')(event.target.value)}
        />
      </Field>
      <Field data-invalid={workspaceInvalid || undefined}>
        <FieldLabel htmlFor="audit-workspace">Workspace ID</FieldLabel>
        <Input
          id="audit-workspace"
          value={values.workspace}
          maxLength={36}
          aria-invalid={workspaceInvalid || undefined}
          onChange={(event) => set('workspace')(event.target.value)}
        />
        {workspaceInvalid ? (
          <FieldError>Enter a complete workspace ID.</FieldError>
        ) : null}
      </Field>
      <Field>
        <FieldLabel htmlFor="audit-account">Account email or ID</FieldLabel>
        <Input
          id="audit-account"
          value={values.account}
          maxLength={320}
          onChange={(event) => set('account')(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel id="audit-event-label">Event</FieldLabel>
        <Select
          aria-labelledby="audit-event-label"
          options={
            eventOptions.some((option) => option.value === values.event)
              ? eventOptions
              : [
                  ...eventOptions,
                  { value: values.event, label: codeLabel(values.event) },
                ]
          }
          placeholder="All events"
          value={values.event}
          onValueChange={(value) => set('event')(value ?? '')}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="audit-from">From</FieldLabel>
        <Input
          id="audit-from"
          type="date"
          value={values.from}
          onChange={(event) => set('from')(event.target.value)}
        />
      </Field>
      <Field data-invalid={rangeInvalid || undefined}>
        <FieldLabel htmlFor="audit-to">Until (inclusive)</FieldLabel>
        <Input
          id="audit-to"
          type="date"
          value={values.to}
          aria-invalid={rangeInvalid || undefined}
          onChange={(event) => set('to')(event.target.value)}
        />
        {rangeInvalid ? (
          <FieldError>Choose an end date on or after the start.</FieldError>
        ) : null}
      </Field>
      <div className="staff-actions">
        <Button type="submit">Apply filters</Button>
        <Link
          to="/audit"
          search={{}}
          className={buttonVariants({ variant: 'ghost' })}
        >
          Clear filters
        </Link>
      </div>
    </form>
  );
}
