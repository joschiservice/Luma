import type {
  AuthorityChange,
  AuthorityGroup,
  AuthoritySnapshot,
  FactAuthority,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import {
  DataTable,
  type DataTableColumn,
} from '@luma/ui/components/primitives/data-table';
import { SearchableSelect } from '@luma/ui/components/primitives/searchable-select';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { Failure } from '../../kit/identity/common';
import { ApiError } from '../../kit/identity/data';
import { settingsApi } from '../../kit/settings/data';
import { privateQueryDefaults } from '../../lib/private-query';
import { authorityGroupLabels, authorityLabel } from '../orders/authority';
import { SectionHeading } from './section-heading';

function AuthorityOverride({
  fact,
  data,
  disabled,
  save,
}: {
  fact: FactAuthority;
  data: AuthoritySnapshot;
  disabled: boolean;
  save: (group: AuthorityGroup, connectionId: string | null) => void;
}) {
  const [value, setValue] = useState(fact.overrideConnectionId ?? 'default');
  const id = useId();
  const options = [
    { value: 'default', label: m.settings_authority_default() },
    ...data.connections
      .filter(
        (connection) =>
          fact.eligibleIds.includes(connection.id) ||
          fact.overrideConnectionId === connection.id,
      )
      .map((connection) => ({
        value: connection.id,
        label: connection.available
          ? connection.label
          : m.settings_authority_unavailable({ source: connection.label }),
      })),
  ];

  return (
    <div className="settings-authority-control">
      <span id={id} className="sr-only">
        {authorityGroupLabels[fact.group]()}
      </span>
      <SearchableSelect
        aria-labelledby={id}
        options={options}
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (next) setValue(next);
        }}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={
          disabled || value === (fact.overrideConnectionId ?? 'default')
        }
        onClick={() => save(fact.group, value === 'default' ? null : value)}
      >
        {m.common_save()}
      </Button>
    </div>
  );
}

/** Presents category defaults, conflicts and reviewed overrides using the server's eligible connections. */
export function SourceAuthorityView({
  data,
  disabled,
  save,
}: {
  data: AuthoritySnapshot;
  disabled: boolean;
  save: (group: AuthorityGroup, connectionId: string | null) => void;
}) {
  const columns: DataTableColumn<FactAuthority>[] = [
    {
      key: 'group',
      header: m.settings_authority_fact(),
      cell: (fact) => authorityGroupLabels[fact.group](),
    },
    {
      key: 'source',
      header: m.orders_authority_title(),
      cell: (fact) => authorityLabel(fact, data.connections),
    },
    {
      key: 'override',
      header: m.settings_authority_override(),
      cell: (fact) => (
        <AuthorityOverride
          key={`${data.revision}:${fact.group}`}
          fact={fact}
          data={data}
          disabled={disabled}
          save={save}
        />
      ),
    },
  ];

  return (
    <section className="settings-section">
      <SectionHeading
        title={m.settings_section_authority()}
        description={m.settings_authority_description()}
      />
      <DataTable
        caption={m.settings_section_authority()}
        columns={columns}
        rows={data.groups}
        rowKey={(fact) => fact.group}
      />
    </section>
  );
}

/** Loads authority settings and retries an uncertain write with its original command identity. */
export function SourceAuthoritySettings({
  organizationId,
  disabled,
}: {
  organizationId: string;
  disabled: boolean;
}) {
  const client = useQueryClient();
  const queryKey = [
    'private',
    'organization',
    organizationId,
    'source-authority',
  ];
  const query = useQuery({
    ...privateQueryDefaults,
    queryKey,
    queryFn: ({ signal }) =>
      settingsApi.sourceAuthority.get(
        { params: { organizationId } },
        { signal },
      ),
  });
  const mutation = useMutation({
    mutationFn: (body: AuthorityChange) =>
      settingsApi.sourceAuthority.change({ params: { organizationId }, body }),
    retry: false,
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: ['private', 'organization', organizationId],
      }),
    // Recovery does not wait for fresh data; a retry keeps the command's identity.
    onError: () => {
      void client.invalidateQueries({
        queryKey: ['private', 'organization', organizationId],
      });
    },
  });
  const uncertain =
    mutation.isError &&
    (!(mutation.error instanceof ApiError) || mutation.error.status >= 500);
  if (
    query.error instanceof ApiError &&
    [401, 403, 404].includes(query.error.status)
  )
    return <Failure error={query.error} retry={() => void query.refetch()} />;

  return (
    <>
      {query.isPending ? <p role="status">{m.settings_loading()}</p> : null}
      {query.error ? (
        <Alert tone="danger">
          {m.settings_load_failed()}{' '}
          <Button variant="outline" onClick={() => void query.refetch()}>
            {m.common_retry()}
          </Button>
        </Alert>
      ) : null}
      {mutation.error ? (
        <Alert tone="danger" role="alert">
          {uncertain ? m.settings_command_uncertain() : mutation.error.message}
          {uncertain && mutation.variables ? (
            <Button
              variant="outline"
              disabled={disabled || mutation.isPending}
              onClick={() => mutation.mutate(mutation.variables!)}
            >
              {m.settings_command_check_status()}
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {mutation.isPending ? (
        <p role="status">{m.settings_command_saving()}</p>
      ) : null}
      {mutation.isSuccess ? (
        <p role="status">{m.settings_command_saved()}</p>
      ) : null}
      {query.data ? (
        <SourceAuthorityView
          data={query.data}
          disabled={
            disabled ||
            !!query.error ||
            query.isFetching ||
            mutation.isPending ||
            uncertain
          }
          save={(group, connectionId) =>
            mutation.mutate({
              commandId: crypto.randomUUID(),
              revision: query.data!.revision,
              group,
              connectionId,
            })
          }
        />
      ) : null}
    </>
  );
}
