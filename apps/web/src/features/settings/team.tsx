import type { Membership } from '@luma/api-contract';
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
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Mail, MoreHorizontal, Search, UserPlus, Users } from 'lucide-react';
import { useState } from 'react';

import { Failure } from '../identity/common';
import { IdentityError } from '../identity/data';
import { isOwnerRole, usePermissions } from '../identity/permissions';
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
import { type RoleChoice, RolePicker } from './role-picker';
import { rolesOptions, type WorkspaceRole } from './roles-data';

/**
 * Manages member access and email invitations with explicit confirmation and delivery status.
 * People can only assign roles whose permissions they hold; only owners change ownership.
 */
export function TeamSettings({
  organizationId,
  actorId,
  deliveryAvailable,
}: {
  organizationId: string;
  actorId: string;
  deliveryAvailable: boolean;
}) {
  const access = usePermissions(organizationId);
  const manage = access.can('members.manage');
  const members = useQuery(membersOptions(organizationId));
  const roles = useQuery(rolesOptions(organizationId));
  const invitations = useQuery({
    ...invitationsOptions(organizationId),
    enabled: manage,
  });
  const online = useSettingsOnline();
  const command = useSettingsCommand(organizationId);
  const [search, setSearch] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [selected, setSelected] = useState<Membership | null>(null);
  const [nextRole, setNextRole] = useState('member');
  const blocked = !online || command.locked;
  const error = members.error ?? invitations.error;
  if (error instanceof IdentityError && [401, 404].includes(error.status))
    return <Failure error={error} retry={() => void members.refetch()} />;
  const active = roles.data?.roles.filter((role) => !role.archived) ?? [];
  const visible = members.data?.filter((member) =>
    `${member.name ?? ''} ${member.email ?? ''} ${member.role.name}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const outstanding = invitations.data?.filter(
    (invitation) =>
      ['pending', 'expired'].includes(invitation.status) ||
      (invitation.status === 'revoked' && invitation.role.archived),
  );
  const pendingCount = outstanding?.filter(
    (invitation) => invitation.status === 'pending',
  ).length;
  const owners =
    members.data?.filter((member) => isOwnerRole(member.role)).length ?? 0;
  const lastOwner = isOwnerRole(selected?.role) && owners === 1;
  const fullRole = (id: string) => active.find((role) => role.id === id);
  // Changing someone needs their current role, and the new one, within your own permissions.
  const changeable = (member: Membership) => {
    const current = roles.data?.roles.find(
      (role) => role.id === member.role.id,
    );

    return (
      manage &&
      (!isOwnerRole(member.role) || access.owner) &&
      (!current || access.covers(current))
    );
  };
  const choice = (role: WorkspaceRole): RoleChoice => ({
    role,
    unavailable:
      isOwnerRole(role) && !access.owner
        ? 'Only owners can make someone an owner.'
        : access.covers(role)
          ? undefined
          : 'Includes permissions your role doesn’t have.',
  });

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
                body: { roleId: nextRole },
              }),
        );
        setSelected(null);
      },
      remove
        ? 'Workspace access removed.'
        : 'Role updated. It applies on their next request.',
    );
  }

  function invitationState(
    invitation: NonNullable<typeof outstanding>[number],
  ) {
    if (invitation.status === 'revoked')
      return 'Revoked because its role was archived · Invite again with another role';
    if (invitation.status === 'expired') return 'Expired';
    if (invitation.delivery === 'sent')
      return 'Email sent · Pending acceptance';
    if (invitation.delivery === 'failed')
      return 'Delivery failed · Resend to retry';
    if (invitation.delivery === 'cancelled')
      return 'Delivery cancelled · Resend to retry';

    return 'Email queued';
  }

  const inviteChoice = fullRole(inviteRole);

  return (
    <section>
      <header className="settings-section-heading">
        <div>
          <h2>
            Team <Badge>{members.data?.length ?? '—'}</Badge>
          </h2>
          <p>The people who keep your operations moving.</p>
        </div>
        {manage ? (
          <Button
            disabled={blocked || !deliveryAvailable}
            onClick={() => {
              setInviteRole('member');
              setInviteOpen(true);
            }}
          >
            <UserPlus size={15} /> Invite teammate
          </Button>
        ) : null}
      </header>
      {!deliveryAvailable && manage ? (
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
              if (manage) void invitations.refetch();
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
            <Link
              className="team-role-link"
              to="/app/$organizationId/settings/$section"
              params={{ organizationId, section: 'roles' }}
              search={{ role: member.role.id }}
              aria-label={`${member.role.name} role: see what it allows`}
            >
              <Badge tone={member.role.builtIn ? 'neutral' : 'info'}>
                {member.role.name}
              </Badge>
            </Link>
            {changeable(member) ? (
              <Button
                variant="ghost"
                size="icon"
                disabled={blocked}
                aria-label={`Manage ${member.name ?? member.email ?? 'member'}`}
                onClick={() => {
                  setSelected(member);
                  setNextRole(member.role.id);
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
      {manage ? (
        <div className="settings-invitations">
          <h3>
            Invitations <span>{pendingCount ?? '—'}</span>
          </h3>
          <p>Access starts only after the recipient accepts.</p>
          {invitations.isPending ? (
            <p role="status">Loading invitations…</p>
          ) : outstanding?.length === 0 ? (
            <div className="settings-invitation-empty">
              <Mail size={18} />
              <span>No outstanding invitations. Your team is up to date.</span>
            </div>
          ) : (
            outstanding?.map((invitation) => (
              <div
                className="settings-invitation"
                key={invitation.id}
                data-revoked={invitation.status === 'revoked' || undefined}
              >
                <Mail size={17} />
                <div>
                  <strong>{invitation.email}</strong>
                  <span>
                    {invitation.role.name} · {invitationState(invitation)}
                  </span>
                  {invitation.status !== 'revoked' ? (
                    <small>
                      Expires <WorkspaceDate value={invitation.expiresAt} />
                    </small>
                  ) : null}
                </div>
                <div className="settings-invitation-actions">
                  {invitation.status === 'revoked' ? (
                    <Button
                      variant="ghost"
                      disabled={blocked || !deliveryAvailable}
                      onClick={() => {
                        setEmail(invitation.email);
                        setInviteRole('member');
                        setInviteOpen(true);
                      }}
                    >
                      Invite again
                    </Button>
                  ) : (
                    <>
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
                    </>
                  )}
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
        <DialogContent className="team-dialog">
          <DialogTitle>Invite a teammate</DialogTitle>
          <DialogDescription>
            Send a personal invitation. They’ll sign in with this email address
            to join your workspace with the role you choose.
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
                      roleId: inviteRole,
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
            {roles.isError ? (
              <Alert tone="danger">Roles could not be loaded.</Alert>
            ) : (
              <RolePicker
                label="Role"
                choices={active
                  .filter((role) => !isOwnerRole(role))
                  .map(choice)}
                value={inviteRole}
                disabled={blocked}
                onChange={setInviteRole}
              />
            )}
            <p className="settings-note">
              Invitations can’t grant ownership. Make someone an owner after
              they join.
            </p>
            {inviteOpen ? <CommandFeedback command={command} /> : null}
            <Button
              type="submit"
              disabled={
                blocked ||
                !email.trim() ||
                !inviteChoice ||
                !!choice(inviteChoice).unavailable
              }
            >
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
        <DialogContent className="team-dialog">
          <DialogTitle>Manage access</DialogTitle>
          <DialogDescription>
            {selected?.name ?? selected?.email} · {selected?.email}
            <br />
            Role changes apply on their next request.
          </DialogDescription>
          <RolePicker
            label="Role"
            choices={active.map(choice)}
            value={nextRole}
            disabled={blocked || lastOwner}
            onChange={setNextRole}
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
              disabled={
                blocked ||
                lastOwner ||
                nextRole === selected?.role.id ||
                !fullRole(nextRole)
              }
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
