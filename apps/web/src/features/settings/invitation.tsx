import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
} from '@tanstack/react-router';
import { MailCheck } from 'lucide-react';
import { useState } from 'react';

import { EntryFrame } from '../identity/common';
import { organizationsOptions } from '../identity/data';
import {
  forgetInvitationToken,
  invitationToken,
} from '../identity/invitation-return';
import { settingsApi, SettingsError } from './data';

/** Reviews an email-bound invitation and reconciles acceptance before opening the workspace. */
export function AcceptInvitation() {
  const { organizationId, invitationId } = useParams({
    from: '/app/invitations/$organizationId/$invitationId',
  });
  const token = useLocation({ select: (location) => location.hash });
  const path = `/app/invitations/${organizationId}/${invitationId}`;
  const proof = {
    organizationId,
    invitationId,
    token: token || invitationToken(path),
  };
  const navigate = useNavigate();
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const invitation = useQuery({
    queryKey: ['private', 'invitation', organizationId, invitationId, token],
    retry: false,
    gcTime: 0,
    queryFn: async () => {
      const result = await settingsApi.settings.previewInvitation({
        body: proof,
      });
      if (result.status !== 200)
        throw new SettingsError(result.status, result.body.message);

      return result.body;
    },
  });

  async function accept() {
    setPending(true);
    setError('');
    try {
      const result = await settingsApi.settings.acceptInvitation({
        body: proof,
      });
      if (result.status !== 200)
        throw new SettingsError(result.status, result.body.message);
      forgetInvitationToken(path);
      await client.invalidateQueries({
        queryKey: ['private', 'organizations'],
      });
      await navigate({
        to: '/app/$organizationId/home',
        params: { organizationId },
        replace: true,
        hash: '',
      });
    } catch (error) {
      try {
        const organizations = await client.fetchQuery(organizationsOptions());
        if (organizations.some((item) => item.id === organizationId)) {
          await navigate({
            to: '/app/$organizationId/home',
            params: { organizationId },
            replace: true,
            hash: '',
          });

          return;
        }
      } catch {
        /* Keep the invitation available for a safe retry after connectivity returns. */
      }
      setError(
        error instanceof Error
          ? error.message
          : 'Could not confirm acceptance. Check your connection and try again.',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <EntryFrame actions={<a href="/sign-out">Use a different account</a>}>
      <section className="entry-panel invitation-card">
        <span className="entry-panel-icon" aria-hidden="true">
          <MailCheck size={18} />
        </span>
        <h1>
          {invitation.data
            ? `Join ${invitation.data.name}`
            : 'Workspace invitation'}
        </h1>
        {invitation.isPending ? (
          <p role="status">Checking your invitation…</p>
        ) : invitation.error ? (
          <Alert tone="danger">{invitation.error.message}</Alert>
        ) : (
          <>
            <p>
              You’re invited with the{' '}
              <strong>{invitation.data.role.name}</strong> role using{' '}
              <strong>{invitation.data.email}</strong>.
            </p>
            <p>Accept to access this workspace and its operations.</p>
            <Button disabled={pending} onClick={() => void accept()}>
              {pending ? 'Joining workspace…' : 'Accept invitation'}
            </Button>
          </>
        )}
        {error ? (
          <Alert role="alert" tone="danger">
            {error}
          </Alert>
        ) : null}
        <Link className="entry-back" to="/app">
          Back to your workspaces
        </Link>
      </section>
    </EntryFrame>
  );
}
