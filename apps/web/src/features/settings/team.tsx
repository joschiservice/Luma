import type { Membership } from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
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
import { roleName } from '../identity/permission-text';
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
    `${member.name ?? ''} ${member.email ?? ''} ${roleName(member.role)}`
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
        ? m.settings_team_only_owners()
        : access.covers(role)
          ? undefined
          : m.settings_team_role_out_of_reach(),
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
        ? m.settings_team_access_removed()
        : m.settings_team_role_changed(),
    );
  }

  function invitationState(
    invitation: NonNullable<typeof outstanding>[number],
  ) {
    if (invitation.status === 'revoked')
      return m.settings_invitation_status_revoked();
    if (invitation.status === 'expired')
      return m.settings_invitation_status_expired();
    if (invitation.delivery === 'sent')
      return m.settings_invitation_status_sent();
    if (invitation.delivery === 'failed')
      return m.settings_invitation_status_failed();
    if (invitation.delivery === 'cancelled')
      return m.settings_invitation_status_canceled();

    return m.settings_invitation_status_queued();
  }

  const inviteChoice = fullRole(inviteRole);

  return (
    <section>
      <header className="settings-section-heading">
        <div>
          <h2>
            {m.settings_team_title()}{' '}
            <Badge>
              {members.data
                ? formatNumber(members.data.length)
                : m.common_empty_value()}
            </Badge>
          </h2>
          <p>{m.settings_team_description()}</p>
        </div>
        {manage ? (
          <Button
            disabled={blocked || !deliveryAvailable}
            onClick={() => {
              setInviteRole('member');
              setInviteOpen(true);
            }}
          >
            <UserPlus size={15} aria-hidden="true" /> {m.settings_team_invite()}
          </Button>
        ) : null}
      </header>
      {!deliveryAvailable && manage ? (
        <Alert tone="warning">{m.settings_team_delivery_unavailable()}</Alert>
      ) : null}
      {error ? (
        <Alert tone="danger">
          {m.settings_team_load_failed()}{' '}
          <Button
            variant="outline"
            onClick={() => {
              void members.refetch();
              if (manage) void invitations.refetch();
            }}
          >
            {m.common_retry()}
          </Button>
        </Alert>
      ) : null}
      <div className="settings-search">
        <Search size={15} aria-hidden="true" />
        <Input
          aria-label={m.settings_team_search_label()}
          placeholder={m.settings_team_search_placeholder()}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {members.isPending ? (
        <p role="status">{m.settings_team_loading()}</p>
      ) : null}
      <div className="settings-members">
        {visible?.map((member) => (
          <div className="settings-member" key={member.id}>
            <div className="settings-avatar" aria-hidden="true">
              {(member.name ?? member.email ?? '?').slice(0, 2).toUpperCase()}
            </div>
            <div className="settings-member-identity">
              <strong>
                {member.name ??
                  member.email ??
                  m.settings_team_member_fallback()}{' '}
                {member.userId === actorId ? (
                  <small>{m.settings_team_you()}</small>
                ) : null}
              </strong>
              <span>{member.email ?? member.userId}</span>
            </div>
            <Link
              className="team-role-link"
              to="/app/$organizationId/settings/$section"
              params={{ organizationId, section: 'roles' }}
              search={{ role: member.role.id }}
              aria-label={m.settings_team_role_link({
                role: roleName(member.role),
              })}
            >
              <Badge tone={member.role.builtIn ? 'neutral' : 'info'}>
                {roleName(member.role)}
              </Badge>
            </Link>
            {changeable(member) ? (
              <Button
                variant="ghost"
                size="icon"
                disabled={blocked}
                aria-label={
                  (member.name ?? member.email)
                    ? m.settings_team_manage_member({
                        name: member.name ?? member.email ?? '',
                      })
                    : m.settings_team_manage_unnamed()
                }
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
            <Users size={23} aria-hidden="true" />
            <strong>
              {search
                ? m.settings_team_search_empty()
                : m.settings_team_empty()}
            </strong>
            {search ? (
              <Button variant="ghost" onClick={() => setSearch('')}>
                {m.settings_team_clear_search()}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {manage ? (
        <div className="settings-invitations">
          <h3>
            {m.settings_invitations_title()}{' '}
            <span>
              {pendingCount === undefined
                ? m.common_empty_value()
                : formatNumber(pendingCount)}
            </span>
          </h3>
          <p>{m.settings_invitations_description()}</p>
          {invitations.isPending ? (
            <p role="status">{m.settings_invitations_loading()}</p>
          ) : outstanding?.length === 0 ? (
            <div className="settings-invitation-empty">
              <Mail size={18} aria-hidden="true" />
              <span>{m.settings_invitations_empty()}</span>
            </div>
          ) : (
            outstanding?.map((invitation) => (
              <div
                className="settings-invitation"
                key={invitation.id}
                data-revoked={invitation.status === 'revoked' || undefined}
              >
                <Mail size={17} aria-hidden="true" />
                <div>
                  <strong>{invitation.email}</strong>
                  <span>
                    {m.settings_invitation_meta({
                      role: roleName(invitation.role),
                      status: invitationState(invitation),
                    })}
                  </span>
                  {invitation.status !== 'revoked' ? (
                    <small>
                      {rich(m.settings_invitation_expires, {
                        date: <WorkspaceDate value={invitation.expiresAt} />,
                      })}
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
                      {m.settings_invitation_invite_again()}
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
                            m.settings_invitation_resent(),
                          )
                        }
                      >
                        {m.settings_invitation_resend()}
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
                            m.settings_invitation_revoked(),
                          )
                        }
                      >
                        {m.settings_invitation_revoke()}
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
          <DialogTitle>{m.settings_invite_title()}</DialogTitle>
          <DialogDescription>
            {m.settings_invite_description()}
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
              }, m.settings_invite_queued());
            }}
          >
            <label htmlFor="invite-email">
              {m.settings_invite_email_label()}
            </label>
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
              <Alert tone="danger">{m.settings_invite_roles_failed()}</Alert>
            ) : (
              <RolePicker
                label={m.settings_role_label()}
                choices={active
                  .filter((role) => !isOwnerRole(role))
                  .map(choice)}
                value={inviteRole}
                disabled={blocked}
                onChange={setInviteRole}
              />
            )}
            <p className="settings-note">{m.settings_invite_no_owner()}</p>
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
              {command.pending
                ? m.settings_invite_sending()
                : m.settings_invite_send()}
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
          <DialogTitle>{m.settings_member_dialog_title()}</DialogTitle>
          <DialogDescription>
            {selected?.name ?? selected?.email} · {selected?.email}
            <br />
            {m.settings_member_dialog_role_timing()}
          </DialogDescription>
          <RolePicker
            label={m.settings_role_label()}
            choices={active.map(choice)}
            value={nextRole}
            disabled={blocked || lastOwner}
            onChange={setNextRole}
          />
          {lastOwner ? (
            <Alert tone="neutral">{m.settings_member_last_owner()}</Alert>
          ) : null}
          {selected ? <CommandFeedback command={command} /> : null}
          <div className="settings-dialog-actions">
            <Button
              variant="destructive"
              disabled={blocked || lastOwner}
              onClick={() => void changeMember(true)}
            >
              {m.settings_member_remove()}
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
              {m.settings_member_save_role()}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
