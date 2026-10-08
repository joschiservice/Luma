import { Alert, AlertDescription } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import { Empty } from '@luma/ui/components/primitives/empty';
import { Field, FieldLabel } from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
import { useForm } from '@tanstack/react-form';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { AccessDialog } from './access';
import { Failure, Loading } from './feedback';
import { directoryOptions, sessionOptions } from './queries';
import { directoryRoute } from './router';

/** Searches the minimal customer directory and opens an explicit support access request. */
export function DirectoryPage() {
  const { query = '' } = directoryRoute.useSearch();
  const navigate = directoryRoute.useNavigate();
  const session = useQuery(sessionOptions());
  const [target, setTarget] = useState<{ id: string; name: string } | null>(
    null,
  );
  const canRead =
    session.data?.permissions.includes('staff.directory.read') ?? false;
  const canInspect =
    session.data?.permissions.includes('staff.workspace.inspect') ?? false;
  const directory = useQuery({
    ...directoryOptions(query),
    enabled: canRead && query.length >= 3,
  });
  if (!canRead)
    return (
      <>
        <PageHeader title="Support directory" />
        <Alert tone="warning">
          <AlertDescription>
            Your staff role does not allow directory searches.
          </AlertDescription>
        </Alert>
      </>
    );

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
        onSearch={(query) => navigate({ search: { query } })}
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
              rowKey={(row) => row.id}
              columns={[
                { key: 'name', header: 'Workspace', cell: (row) => row.name },
                {
                  key: 'slug',
                  header: 'Slug',
                  hideOnNarrow: true,
                  cell: (row) => row.slug,
                },
                {
                  key: 'status',
                  header: 'Status',
                  cell: (row) => <Badge>{row.status}</Badge>,
                },
                {
                  key: 'region',
                  header: 'Data region',
                  hideOnNarrow: true,
                  cell: (row) => row.dataRegion,
                },
                {
                  key: 'inspect',
                  header: 'Support access',
                  cell: (row) =>
                    canInspect ? (
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
                  <h3>No matching workspaces</h3>
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
              rowKey={(row) => row.id}
              columns={[
                { key: 'name', header: 'Name', cell: (row) => row.name },
                { key: 'email', header: 'Email', cell: (row) => row.email },
              ]}
              empty={
                <Empty>
                  <h3>No matching users</h3>
                  <p>Try a different name or email address.</p>
                </Empty>
              }
            />
          </section>
        </div>
      )}
      {target ? (
        <AccessDialog
          key={target.id}
          workspaceId={target.id}
          name={target.name}
          onClose={() => setTarget(null)}
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
