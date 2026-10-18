import { m } from '@luma/i18n/messages';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { useForm } from '@tanstack/react-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useNavigate } from '@tanstack/react-router';
import { ChevronRight, Plus } from 'lucide-react';
import { useRef, useState } from 'react';

import { EntryFrame, Failure, Pending } from '../../kit/identity/common';
import {
  createOrganization,
  IdentityError,
  organizationsOptions,
  regionOptions,
  workspaceName,
} from '../../kit/identity/data';
import { regionLabel } from '../../kit/identity/region';
import { closureNotice } from './closure';

/** One workspace row as the list needs it. */
type WorkspaceRow = Parameters<typeof closureNotice>[0] & {
  id: string;
  name: string;
  membershipStatus: 'active' | 'suspended';
};

/**
 * The workspace rows: open workspaces link to Home and mark suspended access; closed ones
 * can't be opened and say what happens to their data.
 */
export function WorkspaceRows({
  workspaces,
}: {
  workspaces: readonly WorkspaceRow[];
}) {
  return (
    <ul className="workspace-list">
      {workspaces.map((org) => {
        const closure = closureNotice(org);

        return closure ? (
          <li key={org.id}>
            <div className="workspace-list-closed">
              <span className="workspace-avatar" aria-hidden="true">
                {org.name.trim().slice(0, 1).toUpperCase()}
              </span>
              <span className="workspace-list-name">
                {org.name}
                <span className="workspace-list-note">{closure}</span>
              </span>
              <Badge>{m.identity_workspaces_closed()}</Badge>
            </div>
          </li>
        ) : (
          <li key={org.id}>
            <Link
              to="/app/$organizationId/home"
              params={{ organizationId: org.id }}
            >
              <span className="workspace-avatar" aria-hidden="true">
                {org.name.trim().slice(0, 1).toUpperCase()}
              </span>
              <span className="workspace-list-name">{org.name}</span>
              {org.membershipStatus === 'suspended' ? (
                <Badge tone="warning">
                  {m.identity_workspaces_suspended()}
                </Badge>
              ) : null}
              <ChevronRight size={16} aria-hidden="true" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Lists the person's workspaces, marking those where their access is suspended. A closed
 * workspace can't be opened; its row says when its data is deleted. Entry mode
 * opens the sole workspace when it's accessible, or routes an empty list to creation.
 */
export function WorkspaceList({ entry = false }: { entry?: boolean }) {
  const query = useQuery(organizationsOptions());
  if (query.isError)
    return <Failure error={query.error} retry={() => void query.refetch()} />;
  if (query.isPending || query.isFetching) return <Pending />;
  if (entry && query.data.length === 0)
    return <Navigate to="/app/workspaces/new" replace />;
  if (
    entry &&
    query.data.length === 1 &&
    query.data[0]!.membershipStatus === 'active' &&
    query.data[0]!.status !== 'closed'
  )
    return (
      <Navigate
        to="/app/$organizationId/home"
        params={{ organizationId: query.data[0]!.id }}
        replace
      />
    );

  return (
    <EntryFrame actions={<a href="/sign-out">{m.identity_sign_out_link()}</a>}>
      <section className="entry-panel" aria-labelledby="workspaces-title">
        <h1 id="workspaces-title">{m.identity_workspaces_title()}</h1>
        <p>{m.identity_workspaces_lead()}</p>
        {query.data.length ? (
          <WorkspaceRows workspaces={query.data} />
        ) : (
          <p className="entry-empty">{m.identity_workspaces_empty()}</p>
        )}
        <Link
          className={buttonVariants({ variant: 'outline' })}
          to="/app/workspaces/new"
        >
          <Plus aria-hidden="true" />
          {m.identity_workspaces_create()}
        </Link>
      </section>
    </EntryFrame>
  );
}

/**
 * Creates a workspace with validation and duplicate-submit protection, stopping retries when
 * the outcome is uncertain.
 */
export function NewWorkspace() {
  const client = useQueryClient();
  const region = useQuery(regionOptions());
  const navigate = useNavigate();
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [failureStatus, setFailureStatus] = useState<number>();
  const lock = useRef(false);
  const result = useRef<HTMLParagraphElement>(null);
  const formElement = useRef<HTMLFormElement>(null);
  const form = useForm({
    onSubmitInvalid: () => {
      setMessage(m.identity_auth_check_fields());
      requestAnimationFrame(() =>
        formElement.current
          ?.querySelector<HTMLInputElement>('input[aria-invalid="true"]')
          ?.focus(),
      );
    },
    defaultValues: { name: '' },
    onSubmit: async ({ value }) => {
      if (lock.current || uncertain || !region.data) return;
      lock.current = true;
      setPending(true);
      setMessage('');
      try {
        const org = await createOrganization(value.name, region.data!.region);
        await client.invalidateQueries({
          queryKey: ['private', 'organizations'],
        });
        await navigate({
          to: '/app/$organizationId/home',
          params: { organizationId: org.id },
        });
      } catch (error) {
        if (
          error instanceof IdentityError &&
          [401, 403, 404].includes(error.status)
        ) {
          setFailureStatus(error.status);

          return;
        }
        if (
          error instanceof IdentityError &&
          [400, 409, 422].includes(error.status)
        ) {
          setMessage(
            error.status === 409
              ? m.identity_new_workspace_taken()
              : m.identity_new_workspace_invalid(),
          );
        } else {
          setUncertain(true);
          setMessage(m.identity_new_workspace_unconfirmed());
          await client
            .fetchQuery(organizationsOptions())
            .catch(() => undefined);
        }
      } finally {
        lock.current = false;
        setPending(false);
        requestAnimationFrame(() => result.current?.focus());
      }
    },
  });
  if (region.isPending) return <Pending />;
  if (region.isError)
    return <Failure error={region.error} retry={() => void region.refetch()} />;
  if (failureStatus)
    return (
      <Failure
        error={new IdentityError(failureStatus)}
        retry={() => {
          // Authorization failures show navigation actions instead of a retry button.
        }}
      />
    );

  return (
    <EntryFrame actions={<a href="/sign-out">{m.identity_sign_out_link()}</a>}>
      <section className="entry-panel" aria-labelledby="new-workspace-title">
        <h1 id="new-workspace-title">{m.identity_new_workspace_title()}</h1>
        <p>
          {m.identity_new_workspace_lead({
            region: regionLabel(region.data.region),
          })}
        </p>
        <p>
          {m.identity_region_workspace({
            region: regionLabel(region.data.region),
          })}
        </p>
        <form
          ref={formElement}
          noValidate
          aria-busy={pending}
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <form.Field name="name" validators={{ onChange: workspaceName }}>
            {(field) => (
              <div className="form-field">
                <label htmlFor="workspace-name">
                  {m.identity_new_workspace_name_label()}
                </label>
                <Input
                  id="workspace-name"
                  autoComplete="organization"
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                  disabled={pending}
                  aria-invalid={field.state.meta.errors.length > 0}
                  aria-describedby="name-error"
                />
                <p id="name-error" className="field-help">
                  {field.state.meta.errors
                    .map((error) => error?.message)
                    .join(' ')}
                </p>
              </div>
            )}
          </form.Field>
          <p role="status" ref={result} tabIndex={-1} className="form-message">
            {pending ? m.identity_new_workspace_creating_status() : message}
          </p>
          <Button size="lg" type="submit" disabled={pending || uncertain}>
            {pending
              ? m.identity_new_workspace_creating()
              : m.identity_new_workspace_submit()}
          </Button>
        </form>
        <Link className="entry-back" to="/app/workspaces">
          {uncertain
            ? m.identity_new_workspace_check_list()
            : m.identity_new_workspace_back()}
        </Link>
      </section>
    </EntryFrame>
  );
}
