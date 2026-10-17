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

import { EntryFrame } from '../../kit/identity/common';
import {
  auth,
  IdentityError,
  organizationsOptions,
  sessionOptions,
} from '../../kit/identity/data';
import {
  forgetInvitationToken,
  invitationToken,
} from '../../kit/identity/invitation-return';
import { roleName } from '../../kit/identity/permission-text';
import { settingsApi } from '../../kit/settings/data';

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
  // Set when joining was refused because the account's address isn't confirmed yet.
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [confirmation, setConfirmation] = useState<
    'sending' | 'sent' | 'failed'
  >();
  const session = useQuery(sessionOptions());
  const invitation = useQuery({
    queryKey: ['private', 'invitation', organizationId, invitationId, token],
    retry: false,
    gcTime: 0,
    queryFn: () => settingsApi.settings.previewInvitation({ body: proof }),
  });

  async function accept() {
    setPending(true);
    setError('');
    setUnconfirmed(false);
    setConfirmation(undefined);
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
      setUnconfirmed(
        error instanceof IdentityError && error.code === 'EMAIL_NOT_VERIFIED',
      );
      setError(
        error instanceof Error
          ? error.message
          : m.settings_invitation_accept_failed(),
      );
    } finally {
      setPending(false);
    }
  }

  async function sendConfirmation() {
    const email = session.data?.user.email;
    if (!email) return setConfirmation('failed');
    setConfirmation('sending');
    try {
      const result = await auth.sendVerificationEmail({ email });
      setConfirmation(result.error ? 'failed' : 'sent');
    } catch {
      setConfirmation('failed');
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
        {unconfirmed && session.data?.user.email ? (
          <>
            <Button
              variant="outline"
              disabled={confirmation === 'sending'}
              onClick={() => void sendConfirmation()}
            >
              {m.settings_invitation_verify_send()}
            </Button>
            <p role="status">
              {confirmation === 'sent'
                ? m.settings_invitation_verify_sent({
                    email: session.data.user.email,
                  })
                : confirmation === 'failed'
                  ? m.settings_invitation_verify_failed()
                  : ''}
            </p>
          </>
        ) : null}
        <Link className="entry-back" to="/app">
          {m.settings_invitation_back()}
        </Link>
      </section>
    </EntryFrame>
  );
}
