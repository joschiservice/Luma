import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { useForm } from '@tanstack/react-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useNavigate } from '@tanstack/react-router';
import { ChevronRight, Plus } from 'lucide-react';
import { useRef, useState } from 'react';

import { EntryFrame, Failure, Pending } from './common';
import {
  createOrganization,
  IdentityError,
  organizationsOptions,
  workspaceName,
} from './data';

/**
 * Lists accessible workspaces; entry mode opens the sole workspace or routes an empty list
 * to creation.
 */
export function WorkspaceList({ entry = false }: { entry?: boolean }) {
  const query = useQuery(organizationsOptions());
  if (query.isError)
    return <Failure error={query.error} retry={() => void query.refetch()} />;
  if (query.isPending || query.isFetching) return <Pending />;
  if (entry && query.data.length === 0)
    return <Navigate to="/app/workspaces/new" replace />;
  if (entry && query.data.length === 1)
    return (
      <Navigate
        to="/app/$organizationId/home"
        params={{ organizationId: query.data[0]!.id }}
        replace
      />
    );

  return (
    <EntryFrame actions={<a href="/sign-out">Sign out</a>}>
      <section className="entry-panel" aria-labelledby="workspaces-title">
        <h1 id="workspaces-title">Choose a workspace</h1>
        <p>Open a workspace to pick up where you left off.</p>
        {query.data.length ? (
          <ul className="workspace-list">
            {query.data.map((org) => (
              <li key={org.id}>
                <Link
                  to="/app/$organizationId/home"
                  params={{ organizationId: org.id }}
                >
                  <span className="workspace-avatar" aria-hidden="true">
                    {org.name.trim().slice(0, 1).toUpperCase()}
                  </span>
                  <span className="workspace-list-name">{org.name}</span>
                  <ChevronRight size={16} aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="entry-empty">You don’t have a workspace yet.</p>
        )}
        <Link
          className={buttonVariants({ variant: 'outline' })}
          to="/app/workspaces/new"
        >
          <Plus aria-hidden="true" />
          Create workspace
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
      setMessage('Check the highlighted fields.');
      requestAnimationFrame(() =>
        formElement.current
          ?.querySelector<HTMLInputElement>('input[aria-invalid="true"]')
          ?.focus(),
      );
    },
    defaultValues: { name: '' },
    onSubmit: async ({ value }) => {
      if (lock.current || uncertain) return;
      lock.current = true;
      setPending(true);
      setMessage('');
      try {
        const org = await createOrganization(value.name);
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
              ? 'That workspace address is taken. Try again to generate a new address.'
              : 'Check the workspace name and try again.',
          );
        } else {
          setUncertain(true);
          setMessage(
            'Creation was not confirmed. Check your workspace list before trying again.',
          );
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
    <EntryFrame actions={<a href="/sign-out">Sign out</a>}>
      <section className="entry-panel" aria-labelledby="new-workspace-title">
        <h1 id="new-workspace-title">Create a workspace</h1>
        <p>
          A workspace holds one business’s connected systems, issues and
          workflows. Its data is hosted in the European Union.
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
                <label htmlFor="workspace-name">Workspace name</label>
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
            {pending ? 'Creating your workspace…' : message}
          </p>
          <Button size="lg" type="submit" disabled={pending || uncertain}>
            {pending ? 'Creating…' : 'Create workspace'}
          </Button>
        </form>
        <Link className="entry-back" to="/app/workspaces">
          {uncertain ? 'Check workspace list' : 'Back to workspaces'}
        </Link>
      </section>
    </EntryFrame>
  );
}
