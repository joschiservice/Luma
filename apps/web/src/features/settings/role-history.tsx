import type { Membership, RoleHistoryEvent } from '@luma/api-contract';
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

import {
  type PermissionDefinition,
  roleHistoryOptions,
  type WorkspaceRole,
} from './roles-data';

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
  if (loading) return <p role="status">Loading people…</p>;

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
                  {member.name ?? member.email ?? 'Workspace member'}
                </strong>
                <span>{member.email ?? member.userId}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="settings-empty">
          <Users size={22} aria-hidden="true" />
          <strong>Nobody has this role</strong>
          <span>Assign it in Team or choose it when inviting someone.</span>
        </div>
      )}
      <p className="settings-note">
        Change someone’s role in{' '}
        <Link
          to="/app/$organizationId/settings/$section"
          params={{ organizationId, section: 'team' }}
        >
          Team
        </Link>
        .
      </p>
    </>
  );
}

const kinds: Record<
  RoleHistoryEvent['kind'],
  { Icon: typeof History; text: (event: RoleHistoryEvent) => string }
> = {
  created: { Icon: Sparkles, text: () => 'created this role' },
  updated: {
    Icon: PencilLine,
    text: (event) =>
      event.name ? 'renamed and changed this role' : 'changed this role',
  },
  archived: { Icon: Archive, text: () => 'archived this role' },
  app_permissions_removed: {
    Icon: Blocks,
    text: (event) =>
      `uninstalled ${event.cause?.appId ?? 'an app'}, which removed its permissions`,
  },
  member_assigned: {
    Icon: UserPlus,
    text: (event) => `gave ${event.member?.name ?? 'a teammate'} this role`,
  },
  member_unassigned: {
    Icon: UserMinus,
    text: (event) =>
      `moved ${event.member?.name ?? 'a teammate'} to another role or removed them`,
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
    return (
      <Alert tone="neutral">
        Role history is visible to people who can manage roles.
      </Alert>
    );
  if (history.isPending) return <p role="status">Loading history…</p>;
  if (history.isError)
    return (
      <Alert tone="danger" role="alert">
        History could not be loaded.{' '}
        <Button variant="outline" onClick={() => void history.refetch()}>
          Retry
        </Button>
      </Alert>
    );
  if (!history.data.length)
    return (
      <div className="settings-empty">
        <History size={22} aria-hidden="true" />
        <strong>No changes recorded yet</strong>
        <span>
          {role.builtIn
            ? 'Built-in roles don’t change; assignments appear here.'
            : 'Edits and assignments appear here.'}
        </span>
      </div>
    );
  const chips = (keys: string[], tone: 'success' | 'danger', sign: string) =>
    keys.map((key) => (
      <Badge key={`${sign}${key}`} tone={tone}>
        <span aria-hidden="true">{sign}</span>
        <span className="sr-only">
          {sign === '+' ? 'Granted ' : 'Removed '}
        </span>
        {labels.get(key)?.label ?? key}
      </Badge>
    ));

  return (
    <ol className="role-history">
      {history.data.map((event) => {
        const { Icon, text } = kinds[event.kind];

        return (
          <li key={event.id}>
            <span className="role-history-icon" aria-hidden="true">
              <Icon size={14} />
            </span>
            <div>
              <p>
                {event.kind === 'member_assigned' &&
                event.actor &&
                event.actor.id === event.member?.id ? (
                  <>
                    <strong>{event.actor.name ?? 'A teammate'}</strong> joined
                    with this role
                  </>
                ) : (
                  <>
                    <strong>{event.actor?.name ?? 'Luma'}</strong> {text(event)}
                  </>
                )}
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
                {event.revision ? ` · Revision ${event.revision}` : null}
              </small>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
