import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
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
function roleReach(role: WorkspaceRole, total: number) {
  if (role.allAppPermissions) return m.settings_role_every_permission();

  return m.settings_role_reach({ count: role.permissions.length, total });
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
        {m.settings_roles_loading()}
      </div>
    );
  if (roles.isError)
    return (
      <Alert tone="danger" role="alert">
        {m.settings_roles_load_failed()}{' '}
        <Button variant="outline" onClick={() => void roles.refetch()}>
          {m.common_retry()}
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
        {m.settings_roles_missing()}{' '}
        <Button variant="outline" onClick={() => open(undefined)}>
          {m.settings_roles_show_all()}
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
            {role.builtIn ? <Badge>{m.settings_role_built_in()}</Badge> : null}
            {role.archived ? (
              <Badge tone="warning">{m.settings_role_archived()}</Badge>
            ) : null}
            {access.role?.id === role.id ? (
              <Badge tone="accent">{m.settings_role_yours()}</Badge>
            ) : null}
          </strong>
          <span>{role.description || m.settings_role_no_description()}</span>
        </span>
        <span className="roles-row-meta">
          <span>{m.settings_role_people({ count: role.memberCount })}</span>
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
            {m.settings_roles_title()}{' '}
            <Badge>{formatNumber(active.length)}</Badge>
          </h2>
          <p>{m.settings_roles_description()}</p>
        </div>
        {manage ? (
          <Button onClick={() => duplicate(null)}>
            <Plus size={15} aria-hidden="true" /> {m.settings_roles_create()}
          </Button>
        ) : null}
      </header>
      <ul className="roles-list" aria-label={m.settings_roles_list_label()}>
        {active.map(row)}
      </ul>
      {archived.length ? (
        <Disclosure className="roles-archived">
          <summary>
            {m.settings_roles_archived_summary({ count: archived.length })}
          </summary>
          <ul className="roles-list">{archived.map(row)}</ul>
        </Disclosure>
      ) : null}
      <p className="settings-note">
        <Info size={14} aria-hidden="true" />
        {m.settings_roles_note()}{' '}
        <a href="/docs/roles-and-permissions" target="_blank" rel="noreferrer">
          {m.settings_roles_learn_more()}
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
