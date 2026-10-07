import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ChevronRight,
  Crown,
  IdCard,
  Info,
  Plus,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { useState } from 'react';

import { usePermissions } from '../identity/permissions';
import { CreateRoleDialog, type RoleDraft } from './role-create';
import { RoleEditor } from './role-editor';
import { rolesOptions, type WorkspaceRole } from './roles-data';

const roleIcons = {
  owner: Crown,
  admin: ShieldCheck,
  member: UserRound,
  custom: IdCard,
} satisfies Record<WorkspaceRole['key'], typeof IdCard>;

/** The mark shown beside a role; built-in roles keep a recognizable symbol. */
export function RoleMark({ role }: { role: Pick<WorkspaceRole, 'key'> }) {
  const Icon = roleIcons[role.key];

  return (
    <span className="roles-mark" data-role={role.key} aria-hidden="true">
      <Icon size={15} />
    </span>
  );
}

/** Summarizes a role's reach in a few words, such as "12 of 31 permissions". */
export function roleReach(role: WorkspaceRole, total: number) {
  if (role.allAppPermissions) return 'Every permission';

  return `${role.permissions.length} of ${total} permission${total === 1 ? '' : 's'}`;
}

/**
 * Lists built-in and custom roles and opens the selected role. Anyone in the workspace can read
 * roles; people with permission to manage roles create, edit and archive custom ones.
 */
export function RolesSettings({
  organizationId,
  roleId,
}: {
  organizationId: string;
  roleId: string | undefined;
}) {
  const navigate = useNavigate();
  const roles = useQuery(rolesOptions(organizationId));
  const access = usePermissions(organizationId);
  const [creating, setCreating] = useState<{
    base: WorkspaceRole | null;
  } | null>(null);
  const [draft, setDraft] = useState<RoleDraft | null>(null);
  const manage = access.can('roles.manage');
  const open = (id: string | undefined) =>
    void navigate({
      to: '/app/$organizationId/settings/$section',
      params: { organizationId, section: 'roles' },
      search: id ? { role: id } : {},
    });

  if (roles.isPending)
    return (
      <div className="settings-loading" role="status">
        <div />
        <div />
        <div />
        Loading roles…
      </div>
    );
  if (roles.isError)
    return (
      <Alert tone="danger" role="alert">
        Roles could not be loaded. Check your connection and try again.{' '}
        <Button variant="outline" onClick={() => void roles.refetch()}>
          Retry
        </Button>
      </Alert>
    );

  const catalog = roles.data;
  const total = catalog.permissions.length;
  const selected = roleId
    ? catalog.roles.find((role) => role.id === roleId)
    : undefined;
  const duplicate = (base: WorkspaceRole | null) => setCreating({ base });

  if (draft)
    return (
      <RoleEditor
        key={`new:${draft.name}`}
        organizationId={organizationId}
        catalog={catalog}
        role={null}
        draft={draft}
        close={(created) => {
          setDraft(null);
          if (created) open(created);
        }}
        duplicate={duplicate}
      />
    );
  if (roleId && !selected)
    return (
      <Alert tone="warning">
        This role no longer exists in this workspace.{' '}
        <Button variant="outline" onClick={() => open(undefined)}>
          Show all roles
        </Button>
      </Alert>
    );
  if (selected)
    return (
      <>
        <RoleEditor
          key={`${selected.id}:${selected.revision}`}
          organizationId={organizationId}
          catalog={catalog}
          role={selected}
          close={() => open(undefined)}
          duplicate={duplicate}
        />
        <CreateRoleDialog
          organizationId={organizationId}
          roles={catalog.roles}
          state={creating}
          close={() => setCreating(null)}
          start={(next) => {
            setCreating(null);
            setDraft(next);
          }}
        />
      </>
    );

  const active = catalog.roles.filter((role) => !role.archived);
  const archived = catalog.roles.filter((role) => role.archived);
  const row = (role: WorkspaceRole) => (
    <li key={role.id}>
      <Link
        className="roles-row"
        to="/app/$organizationId/settings/$section"
        params={{ organizationId, section: 'roles' }}
        search={{ role: role.id }}
      >
        <RoleMark role={role} />
        <span className="roles-row-identity">
          <strong>
            {role.name}
            {role.builtIn ? <Badge>Built-in</Badge> : null}
            {role.archived ? <Badge tone="warning">Archived</Badge> : null}
            {access.role?.id === role.id ? (
              <Badge tone="accent">Your role</Badge>
            ) : null}
          </strong>
          <span>{role.description || 'No description'}</span>
        </span>
        <span className="roles-row-meta">
          <span>
            {role.memberCount} {role.memberCount === 1 ? 'person' : 'people'}
          </span>
          <span>{roleReach(role, total)}</span>
        </span>
        <ChevronRight size={16} aria-hidden="true" />
      </Link>
    </li>
  );

  return (
    <section aria-labelledby="roles-title">
      <header className="settings-section-heading">
        <div>
          <h2 id="roles-title">
            Roles <Badge>{active.length}</Badge>
          </h2>
          <p>Decide what each person can see and do in this workspace.</p>
        </div>
        {manage ? (
          <Button onClick={() => duplicate(null)}>
            <Plus size={15} /> Create role
          </Button>
        ) : null}
      </header>
      <ul className="roles-list" aria-label="Roles">
        {active.map(row)}
      </ul>
      {archived.length ? (
        <Disclosure className="roles-archived">
          <summary>Archived roles ({archived.length})</summary>
          <ul className="roles-list">{archived.map(row)}</ul>
        </Disclosure>
      ) : null}
      <p className="settings-note">
        <Info size={14} aria-hidden="true" />
        Built-in roles gain new permissions as Luma adds features. Custom roles
        only change when someone edits them, so new features stay off until you
        grant them.{' '}
        <a href="/docs/roles-and-permissions" target="_blank" rel="noreferrer">
          Learn about roles
        </a>
      </p>
      <CreateRoleDialog
        organizationId={organizationId}
        roles={catalog.roles}
        state={creating}
        close={() => setCreating(null)}
        start={(next) => {
          setCreating(null);
          setDraft(next);
        }}
      />
    </section>
  );
}
