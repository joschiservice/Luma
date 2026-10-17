import { m } from '@luma/i18n/messages';
import { Alert, AlertDescription } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import { Empty } from '@luma/ui/components/primitives/empty';
import { Field, FieldLabel } from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
import { useForm } from '@tanstack/react-form';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { Failure, Loading } from './feedback';
import { InspectionRequestDialog } from './inspection';
import { directoryOptions } from './queries';
import { staffPath, type StaffRegion, staffRegion } from './regions';
import { directoryRoute } from './router';

/** Searches the minimal customer directory and asks a workspace to approve inspection. */
export function DirectoryPage() {
  const { query = '' } = directoryRoute.useSearch();
  const navigate = directoryRoute.useNavigate();
  const workspaceNavigate = useNavigate();
  const [target, setTarget] = useState<{
    id: string;
    name: string;
    region: StaffRegion;
  } | null>(null);
  const directory = useQuery(directoryOptions(query));

  return (
    <>
      <PageHeader
        title="Support directory"
        description="Find a customer account or workspace to investigate."
      />
      <DirectorySearch
        key={query}
        query={query}
        pending={directory.isFetching}
        onSearch={(query) =>
          navigate({ search: { region: staffRegion(), query } })
        }
      />
      {query.length < 3 ? (
        <Empty>
          <h2>Search the support directory</h2>
          <p>
            Enter at least 3 characters of a name, email address or workspace.
          </p>
        </Empty>
      ) : directory.isPending ? (
        <Loading>Searching customers and workspaces…</Loading>
      ) : directory.isError ? (
        <Failure
          error={directory.error}
          retry={() => void directory.refetch()}
        />
      ) : (
        <div className="staff-directory" aria-busy={directory.isFetching}>
          {directory.isFetching ? (
            <Loading>Refreshing directory…</Loading>
          ) : null}
          <div role="status" className="staff-badges">
            {directory.data.regions.map((result) => (
              <span key={result.region}>
                <Badge
                  tone={result.status === 'answered' ? 'neutral' : 'warning'}
                >
                  {result.region}:{' '}
                  {result.status === 'answered'
                    ? m.identity_staff_region_answered()
                    : result.status === 'rollout-disabled'
                      ? m.identity_staff_region_paused()
                      : m.identity_staff_region_incomplete()}
                </Badge>
                {result.status === 'access-required' ? (
                  <a
                    className="staff-link"
                    href={staffPath('/login', result.region)}
                  >
                    {m.identity_staff_region_sign_in({ region: result.region })}
                  </a>
                ) : null}
              </span>
            ))}
          </div>
          {directory.data.incomplete ? (
            <Alert tone="warning">
              <AlertDescription>
                {m.identity_staff_results_incomplete()}
              </AlertDescription>
            </Alert>
          ) : null}
          <section
            className="staff-section"
            aria-labelledby="workspace-results"
          >
            <h2 id="workspace-results">Workspaces</h2>
            {directory.data.workspacesTruncated ? (
              <Alert tone="warning">
                <AlertDescription>
                  Only the first 25 matching workspaces are shown. Narrow your
                  search to see other results.
                </AlertDescription>
              </Alert>
            ) : null}
            <DataTable
              caption="Matching workspaces"
              rows={directory.data.workspaces}
              rowKey={(row) => `${row.region}:${row.id}`}
              columns={[
                {
                  key: 'name',
                  header: 'Workspace',
                  cell: (row) => (
                    <div>
                      {row.name}
                      <div className="staff-directory-narrow">
                        <Badge>{row.region}</Badge>
                        <Badge>{row.status}</Badge>
                      </div>
                    </div>
                  ),
                },
                {
                  key: 'slug',
                  header: 'Slug',
                  hideOnNarrow: true,
                  cell: (row) => row.slug,
                },
                {
                  key: 'status',
                  header: 'Status',
                  hideOnNarrow: true,
                  cell: (row) => <Badge>{row.status}</Badge>,
                },
                {
                  key: 'region',
                  header: 'Data region',
                  hideOnNarrow: true,
                  cell: (row) => row.region,
                },
                {
                  key: 'inspect',
                  header: 'Support access',
                  cell: (row) =>
                    row.permissions.includes('staff.workspace.inspect') ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setTarget(row)}
                        aria-label={`Inspect ${row.name}`}
                      >
                        Inspect
                      </Button>
                    ) : (
                      'No inspection permission'
                    ),
                },
              ]}
              empty={
                <Empty>
                  <h3>{m.identity_staff_workspaces_empty()}</h3>
                  <p>Try a different name or slug.</p>
                </Empty>
              }
            />
          </section>
          <section className="staff-section" aria-labelledby="user-results">
            <h2 id="user-results">Users</h2>
            {directory.data.usersTruncated ? (
              <Alert tone="warning">
                <AlertDescription>
                  Only the first 25 matching users are shown. Narrow your search
                  to see other results.
                </AlertDescription>
              </Alert>
            ) : null}
            <DataTable
              caption="Matching customer accounts"
              rows={directory.data.users}
              rowKey={(row) => `${row.region}:${row.id}`}
              columns={[
                {
                  key: 'name',
                  header: 'Name',
                  cell: (row) => (
                    <div>
                      {row.name}
                      <div className="staff-directory-narrow">
                        <p className="staff-muted">{row.email}</p>
                        <Badge>{row.region}</Badge>
                      </div>
                    </div>
                  ),
                },
                {
                  key: 'email',
                  header: 'Email',
                  hideOnNarrow: true,
                  cell: (row) => row.email,
                },
                {
                  key: 'region',
                  header: m.identity_staff_region_column(),
                  hideOnNarrow: true,
                  cell: (row) => <Badge>{row.region}</Badge>,
                },
                {
                  key: 'account',
                  header: 'Account',
                  cell: (row) =>
                    row.permissions.includes('staff.accounts.inspect') ? (
                      <Link
                        to="/accounts/$userId"
                        params={{ userId: row.id }}
                        search={{ region: row.region }}
                        className={buttonVariants({
                          variant: 'outline',
                          size: 'sm',
                        })}
                        aria-label={`Open account ${row.email}`}
                      >
                        Open account
                      </Link>
                    ) : (
                      'No account permission'
                    ),
                },
              ]}
              empty={
                <Empty>
                  <h3>{m.identity_staff_users_empty()}</h3>
                  <p>Try a different name or email address.</p>
                </Empty>
              }
            />
          </section>
        </div>
      )}
      {target ? (
        <InspectionRequestDialog
          key={target.id}
          target={{ kind: 'workspace', id: target.id }}
          region={target.region}
          name={target.name}
          onClose={() => setTarget(null)}
          afterRequest={async () => {
            await workspaceNavigate({
              to: '/workspaces/$workspaceId',
              params: { workspaceId: target.id },
              search: { region: target.region },
            });
          }}
        />
      ) : null}
    </>
  );
}

function DirectorySearch({
  query,
  pending,
  onSearch,
}: {
  query: string;
  pending: boolean;
  onSearch: (query: string) => Promise<void>;
}) {
  const form = useForm({
    defaultValues: { query },
    onSubmit: async ({ value }) => {
      await onSearch(value.query.trim());
    },
  });

  return (
    <form
      className="staff-search"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <form.Field name="query">
        {(field) => (
          <Field>
            <FieldLabel htmlFor="directory-search">
              Name, email or workspace
            </FieldLabel>
            <Input
              id="directory-search"
              type="search"
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value)}
              maxLength={100}
              placeholder="Search at least 3 characters"
            />
          </Field>
        )}
      </form.Field>
      <Button type="submit" disabled={pending}>
        Search
      </Button>
    </form>
  );
}
