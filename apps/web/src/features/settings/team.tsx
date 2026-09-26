import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useQuery } from '@tanstack/react-query';
import { Mail, MoreHorizontal, Search, UserPlus, Users } from 'lucide-react';
import { useState } from 'react';

import { Failure } from '../identity/common';
import { IdentityError } from '../identity/data';
import {
  CommandFeedback,
  useSettingsCommand,
  useSettingsOnline,
} from './command';
import {
  invitationsOptions,
  membersOptions,
  settingsApi,
  settingsResult,
} from './data';

type Role = 'owner' | 'admin' | 'member';

type Member = {
  id: string;
  userId: string;
  role: Role;
  name?: string | undefined;
  email?: string | undefined;
};

const roles = [
  { value: 'member' as const, label: 'Member' },
  { value: 'admin' as const, label: 'Admin' },
];

/** Manages member access and email invitations with explicit confirmation and delivery status. */
export function TeamSettings({
  organizationId,
  actorId,
  role,
  deliveryAvailable,
}: {
  organizationId: string;
  actorId: string;
  role: Role;
  deliveryAvailable: boolean;
}) {
  const members = useQuery(membersOptions(organizationId));
  const invitations = useQuery({
    ...invitationsOptions(organizationId),
    enabled: role !== 'member',
  });
  const online = useSettingsOnline();
  const command = useSettingsCommand(organizationId);
  const [search, setSearch] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'member' | 'admin'>('member');
  const [selected, setSelected] = useState<Member | null>(null);
  const [nextRole, setNextRole] = useState<Role>('member');
  const admin = role !== 'member';
  const blocked = !online || command.locked;
  const error = members.error ?? invitations.error;
  if (error instanceof IdentityError && [401, 403, 404].includes(error.status))
    return <Failure error={error} retry={() => void members.refetch()} />;
  const visible = members.data?.filter((member) =>
    `${member.name ?? ''} ${member.email ?? ''} ${member.role}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const pending = invitations.data?.filter((invitation) =>
    ['pending', 'expired'].includes(invitation.status),
  );
  const lastOwner =
    selected?.role === 'owner' &&
    members.data?.filter((member) => member.role === 'owner').length === 1;

  async function changeMember(remove: boolean) {
    if (!selected) return;
    const target = selected;
    await command.run(
      async (commandId) => {
        settingsResult(
          remove
            ? await settingsApi.identity.removeMember({
                params: { organizationId, memberId: target.id },
                headers: { 'x-command-id': commandId },
              })
            : await settingsApi.identity.updateMember({
                params: { organizationId, memberId: target.id },
                headers: { 'x-command-id': commandId },
                body: { role: nextRole },
              }),
        );
        setSelected(null);
      },
      remove ? 'Workspace access removed.' : 'Member role updated.',
    );
  }

  return (
    <section>
      <header className="settings-section-heading">
        <div>
          <h2>
            Team <Badge>{members.data?.length ?? '—'}</Badge>
          </h2>
          <p>The people who keep your operations moving.</p>
        </div>
        {admin ? (
          <Button
            disabled={blocked || !deliveryAvailable}
            onClick={() => setInviteOpen(true)}
          >
            <UserPlus size={15} /> Invite teammate
          </Button>
        ) : null}
      </header>
      {!deliveryAvailable && admin ? (
        <Alert tone="warning">
          Email delivery is unavailable. Configure email before inviting
          teammates.
        </Alert>
      ) : null}
      {error ? (
        <Alert tone="danger">
          Team information could not be refreshed.{' '}
          <Button
            variant="outline"
            onClick={() => {
              void members.refetch();
              if (admin) void invitations.refetch();
            }}
          >
            Retry
          </Button>
        </Alert>
      ) : null}
      <div className="settings-search">
        <Search size={15} />
        <Input
          aria-label="Search team"
          placeholder="Search by name, email, or role…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {members.isPending ? <p role="status">Loading team…</p> : null}
      <div className="settings-members">
        {visible?.map((member) => (
          <div className="settings-member" key={member.id}>
            <div className="settings-avatar" aria-hidden="true">
              {(member.name ?? member.email ?? '?').slice(0, 2).toUpperCase()}
            </div>
            <div className="settings-member-identity">
              <strong>
                {member.name ?? member.email ?? 'Workspace member'}{' '}
                {member.userId === actorId ? <small>You</small> : null}
              </strong>
              <span>{member.email ?? member.userId}</span>
            </div>
            <Badge>{member.role}</Badge>
            {admin && (member.role !== 'owner' || role === 'owner') ? (
              <Button
                variant="ghost"
                size="icon"
                disabled={blocked}
                aria-label={`Manage ${member.name ?? member.email ?? 'member'}`}
                onClick={() => {
                  setSelected(member);
                  setNextRole(member.role);
                }}
              >
                <MoreHorizontal size={17} />
              </Button>
            ) : null}
          </div>
        ))}
        {visible?.length === 0 ? (
          <div className="settings-empty">
            <Users size={23} />
            <strong>
              {search ? 'No teammates match your search' : 'No members to show'}
            </strong>
            {search ? (
              <Button variant="ghost" onClick={() => setSearch('')}>
                Clear search
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {admin ? (
        <div className="settings-invitations">
          <h3>
            Invitations <span>{pending?.length ?? '—'}</span>
          </h3>
          <p>Access starts only after the recipient accepts.</p>
          {invitations.isPending ? (
            <p role="status">Loading invitations…</p>
          ) : pending?.length === 0 ? (
            <div className="settings-invitation-empty">
              <Mail size={18} />
              <span>No outstanding invitations. Your team is up to date.</span>
            </div>
          ) : (
            pending?.map((invitation) => (
              <div className="settings-invitation" key={invitation.id}>
                <Mail size={17} />
                <div>
                  <strong>{invitation.email}</strong>
                  <span>
                    {invitation.role} ·{' '}
                    {invitation.status === 'expired'
                      ? 'Expired'
                      : invitation.delivery === 'sent'
                        ? 'Email sent · Pending acceptance'
                        : invitation.delivery === 'failed'
                          ? 'Delivery failed · Resend to retry'
                          : invitation.delivery === 'cancelled'
                            ? 'Delivery cancelled · Resend to retry'
                            : 'Email queued'}
                  </span>
                  <small>
                    Expires <WorkspaceDate value={invitation.expiresAt} />
                  </small>
                </div>
                <div className="settings-invitation-actions">
                  <Button
                    variant="ghost"
                    disabled={blocked || !deliveryAvailable}
                    onClick={() =>
                      void command.run(
                        async (commandId) =>
                          settingsResult(
                            await settingsApi.settings.changeInvitation({
                              params: {
                                organizationId,
                                invitationId: invitation.id,
                              },
                              body: {
                                commandId,
                                generation: invitation.generation,
                                action: 'resend',
                              },
                            }),
                          ),
                        'New invitation queued. The previous link no longer works.',
                      )
                    }
                  >
                    Resend
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={blocked}
                    onClick={() =>
                      void command.run(
                        async (commandId) =>
                          settingsResult(
                            await settingsApi.settings.changeInvitation({
                              params: {
                                organizationId,
                                invitationId: invitation.id,
                              },
                              body: {
                                commandId,
                                generation: invitation.generation,
                                action: 'revoke',
                              },
                            }),
                          ),
                        'Invitation revoked.',
                      )
                    }
                  >
                    Revoke
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      ) : null}
      {!inviteOpen && !selected ? <CommandFeedback command={command} /> : null}
      <Dialog
        open={inviteOpen}
        onOpenChange={(open) => {
          if (!command.locked) setInviteOpen(open);
        }}
      >
        <DialogContent>
          <DialogTitle>Invite a teammate</DialogTitle>
          <DialogDescription>
            Send a personal invitation. They’ll sign in with this email address
            to join your workspace.
          </DialogDescription>
          <form
            className="settings-dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              void command.run(async (commandId) => {
                settingsResult(
                  await settingsApi.settings.invite({
                    params: { organizationId },
                    body: {
                      commandId,
                      email: email.trim().toLowerCase(),
                      role: inviteRole,
                    },
                  }),
                );
                setInviteOpen(false);
                setEmail('');
              }, 'Invitation queued. Access starts when it is accepted.');
            }}
          >
            <label htmlFor="invite-email">Email address</label>
            <Input
              id="invite-email"
              type="email"
              required
              maxLength={254}
              autoComplete="email"
              value={email}
              disabled={blocked}
              onChange={(event) => setEmail(event.target.value)}
            />
            <label id="invite-role-label">Role</label>
            <Select
              aria-labelledby="invite-role-label"
              options={roles}
              value={inviteRole}
              disabled={blocked}
              onValueChange={(value) => {
                if (value) setInviteRole(value);
              }}
            />
            <p className="settings-note">
              {inviteRole === 'admin'
                ? 'Admins manage workspace settings, members, and approvals.'
                : 'Members can view operations and manage their own email preferences.'}
            </p>
            {inviteOpen ? <CommandFeedback command={command} /> : null}
            <Button type="submit" disabled={blocked || !email.trim()}>
              {command.pending ? 'Queuing invitation…' : 'Send invitation'}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open && !command.locked) setSelected(null);
        }}
      >
        <DialogContent>
          <DialogTitle>Manage access</DialogTitle>
          <DialogDescription>
            {selected?.name ?? selected?.email} · {selected?.email}
            <br />
            Changes take effect immediately in this workspace.
          </DialogDescription>
          <Select
            aria-label="Member role"
            value={nextRole}
            options={[
              ...roles,
              ...(role === 'owner'
                ? [{ value: 'owner' as const, label: 'Owner' }]
                : []),
            ]}
            disabled={blocked || lastOwner}
            onValueChange={(value) => {
              if (value) setNextRole(value);
            }}
          />
          {lastOwner ? (
            <Alert tone="neutral">
              This is the last owner. Make another teammate an owner before
              changing or removing this access.
            </Alert>
          ) : null}
          {selected ? <CommandFeedback command={command} /> : null}
          <div className="settings-dialog-actions">
            <Button
              variant="destructive"
              disabled={blocked || lastOwner}
              onClick={() => void changeMember(true)}
            >
              Remove access
            </Button>
            <Button
              disabled={blocked || lastOwner || nextRole === selected?.role}
              onClick={() => void changeMember(false)}
            >
              Save role
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
