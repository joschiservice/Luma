import type { Membership, RoleHistoryEvent } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Archive,
  Blocks,
  History,
  PencilLine,
  Sparkles,
  UserMinus,
  UserPlus,
  Users,
} from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';

import { permissionLabel } from '../../kit/identity/permission-text';
import {
  type PermissionDefinition,
  roleHistoryOptions,
  type WorkspaceRole,
} from '../../kit/settings/roles-data';

/** Lists the people who currently have a role. */
export function RolePeople({
  organizationId,
  people,
  loading,
}: {
  organizationId: string;
  people: Membership[];
  loading: boolean;
}) {
  if (loading) return <p role="status">{m.settings_role_people_loading()}</p>;

  return (
    <>
      {people.length ? (
        <ul className="settings-members role-people">
          {people.map((member) => (
            <li className="settings-member" key={member.id}>
              <div className="settings-avatar" aria-hidden="true">
                {(member.name ?? member.email ?? '?').slice(0, 2).toUpperCase()}
              </div>
              <div className="settings-member-identity">
                <strong>
                  {member.name ??
                    member.email ??
                    m.settings_team_member_fallback()}
                </strong>
                <span>{member.email ?? member.userId}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="settings-empty">
          <Users size={22} aria-hidden="true" />
          <strong>{m.settings_role_people_empty_title()}</strong>
          <span>{m.settings_role_people_empty_body()}</span>
        </div>
      )}
      <p className="settings-note">
        {rich(m.settings_role_people_change, {
          team: (
            <Link
              to="/app/$organizationId/settings/$section"
              params={{ organizationId, section: 'team' }}
            >
              {m.settings_role_people_team_link()}
            </Link>
          ),
        })}
      </p>
    </>
  );
}

const kinds: Record<
  RoleHistoryEvent['kind'],
  {
    Icon: typeof History;
    /** Describes the event as a sentence that names its actor. */
    text: (event: RoleHistoryEvent, actor: ReactElement) => ReactNode;
  }
> = {
  created: {
    Icon: Sparkles,
    text: (_, actor) => rich(m.settings_role_history_created, { actor }),
  },
  updated: {
    Icon: PencilLine,
    text: (event, actor) =>
      rich(
        event.name
          ? m.settings_role_history_renamed
          : m.settings_role_history_updated,
        { actor },
      ),
  },
  archived: {
    Icon: Archive,
    text: (_, actor) => rich(m.settings_role_history_archived, { actor }),
  },
  app_permissions_removed: {
    Icon: Blocks,
    text: (event, actor) =>
      event.cause?.appId
        ? rich(m.settings_role_history_app_removed, {
            actor,
            app: event.cause.appId,
          })
        : rich(m.settings_role_history_app_removed_unnamed, { actor }),
  },
  member_assigned: {
    Icon: UserPlus,
    text: (event, actor) =>
      event.member?.name
        ? rich(m.settings_role_history_assigned, {
            actor,
            member: event.member.name,
          })
        : rich(m.settings_role_history_assigned_unnamed, { actor }),
  },
  member_unassigned: {
    Icon: UserMinus,
    text: (event, actor) =>
      event.member?.name
        ? rich(m.settings_role_history_unassigned, {
            actor,
            member: event.member.name,
          })
        : rich(m.settings_role_history_unassigned_unnamed, { actor }),
  },
};

/** Shows who changed a role, when, and which permissions were granted or removed. */
export function RoleHistory({
  organizationId,
  role,
  labels,
  allowed,
}: {
  organizationId: string;
  role: WorkspaceRole;
  labels: Map<string, PermissionDefinition>;
  allowed: boolean;
}) {
  const history = useQuery({
    ...roleHistoryOptions(organizationId, role.id),
    enabled: allowed,
  });
  if (!allowed)
    return <Alert tone="neutral">{m.settings_role_history_restricted()}</Alert>;
  if (history.isPending)
    return <p role="status">{m.settings_role_history_loading()}</p>;
  if (history.isError)
    return (
      <Alert tone="danger" role="alert">
        {m.settings_role_history_failed()}{' '}
        <Button variant="outline" onClick={() => void history.refetch()}>
          {m.common_retry()}
        </Button>
      </Alert>
    );
  if (!history.data.length)
    return (
      <div className="settings-empty">
        <History size={22} aria-hidden="true" />
        <strong>{m.settings_role_history_empty_title()}</strong>
        <span>
          {role.builtIn
            ? m.settings_role_history_empty_built_in()
            : m.settings_role_history_empty_custom()}
        </span>
      </div>
    );
  const chips = (keys: string[], tone: 'success' | 'danger', sign: string) =>
    keys.map((key) => (
      <Badge key={`${sign}${key}`} tone={tone}>
        <span aria-hidden="true">{sign}</span>
        <span className="sr-only">
          {sign === '+'
            ? m.settings_role_history_granted()
            : m.settings_role_history_removed()}{' '}
        </span>
        {permissionLabel(key, labels.get(key)?.label ?? key)}
      </Badge>
    ));

  return (
    <ol className="role-history">
      {history.data.map((event) => {
        const { Icon, text } = kinds[event.kind];
        const actor = (
          <strong>
            {event.actor
              ? (event.actor.name ?? m.settings_role_history_someone())
              : 'Luma'}
          </strong>
        );

        return (
          <li key={event.id}>
            <span className="role-history-icon" aria-hidden="true">
              <Icon size={14} />
            </span>
            <div>
              <p>
                {event.kind === 'member_assigned' &&
                event.actor &&
                event.actor.id === event.member?.id
                  ? rich(m.settings_role_history_joined, { actor })
                  : text(event, actor)}
              </p>
              {event.name?.before && event.name.after ? (
                <p className="role-history-detail">
                  {event.name.before} → {event.name.after}
                </p>
              ) : null}
              {event.added.length || event.removed.length ? (
                <div className="role-history-chips">
                  {chips(event.added, 'success', '+')}
                  {chips(event.removed, 'danger', '−')}
                </div>
              ) : null}
              <small>
                <WorkspaceDate value={event.occurredAt} />
              </small>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
