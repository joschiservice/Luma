import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
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
import { roleName } from '../identity/permission-text';
import { settingsApi } from './data';

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
    queryFn: () => settingsApi.settings.previewInvitation({ body: proof }),
  });

  async function accept() {
    setPending(true);
    setError('');
    try {
      await settingsApi.settings.acceptInvitation({ body: proof });
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
          : m.settings_invitation_accept_failed(),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <EntryFrame
      actions={<a href="/sign-out">{m.settings_invitation_other_account()}</a>}
    >
      <section className="entry-panel invitation-card">
        <span className="entry-panel-icon" aria-hidden="true">
          <MailCheck size={18} />
        </span>
        <h1>
          {invitation.data
            ? m.settings_invitation_join_title({
                workspace: invitation.data.name,
              })
            : m.settings_invitation_title()}
        </h1>
        {invitation.isPending ? (
          <p role="status">{m.settings_invitation_checking()}</p>
        ) : invitation.error ? (
          <Alert tone="danger">{invitation.error.message}</Alert>
        ) : (
          <>
            <p>
              {rich(m.settings_invitation_details, {
                role: <strong>{roleName(invitation.data.role)}</strong>,
                email: <strong>{invitation.data.email}</strong>,
              })}
            </p>
            <p>{m.settings_invitation_accept_help()}</p>
            <Button disabled={pending} onClick={() => void accept()}>
              {pending
                ? m.settings_invitation_joining()
                : m.settings_invitation_accept()}
            </Button>
          </>
        )}
        {error ? (
          <Alert role="alert" tone="danger">
            {error}
          </Alert>
        ) : null}
        <Link className="entry-back" to="/app">
          {m.settings_invitation_back()}
        </Link>
      </section>
    </EntryFrame>
  );
}
