import type { RolesSnapshot } from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Input } from '@luma/ui/components/primitives/input';
import { Switch } from '@luma/ui/components/primitives/switch';
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from '@luma/ui/components/primitives/tabs';
import { Textarea } from '@luma/ui/components/primitives/textarea';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useQuery } from '@tanstack/react-query';
import {
  Archive,
  ArrowLeft,
  Check,
  Copy,
  Minus,
  Plus,
  Search,
} from 'lucide-react';
import { useId, useMemo, useState } from 'react';

import { usePermissions } from '../identity/permissions';
import {
  CommandFeedback,
  useSettingsCommand,
  useSettingsOnline,
} from './command';
import { membersOptions, settingsApi, settingsResult } from './data';
import type { RoleDraft } from './role-create';
import { RoleHistory, RolePeople } from './role-history';
import { RoleMark } from './roles';
import {
  isNewForRole,
  permissionChanges,
  type PermissionDefinition,
  type WorkspaceRole,
} from './roles-data';

type Values = { name: string; description: string; permissions: string[] };

/**
 * Shows a role's permissions and, for people who manage roles, edits a custom role or creates a
 * new one. Changes are reviewed, with the people they affect, before they are saved.
 */
export function RoleEditor({
  organizationId,
  catalog,
  role,
  draft: initial,
  close,
  duplicate,
}: {
  organizationId: string;
  catalog: RolesSnapshot;
  /** Null while creating a role from `draft`. */
  role: WorkspaceRole | null;
  draft?: RoleDraft;
  close: (created?: string) => void;
  duplicate: (base: WorkspaceRole) => void;
}) {
  const access = usePermissions(organizationId);
  const online = useSettingsOnline();
  const command = useSettingsCommand(organizationId);
  const members = useQuery(membersOptions(organizationId));
  const [edits, setEdits] = useState<Values | null>(
    initial
      ? {
          name: initial.name,
          description: initial.description,
          permissions: initial.permissions,
        }
      : null,
  );
  const [tab, setTab] = useState<'permissions' | 'people' | 'history'>(
    'permissions',
  );
  const [query, setQuery] = useState('');
  const [grantedOnly, setGrantedOnly] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const creating = !role;
  const saved: Values = role
    ? {
        name: role.name,
        description: role.description,
        permissions: role.permissions,
      }
    : { name: '', description: '', permissions: [] };
  const values = edits ?? saved;
  const manage = access.can('roles.manage');
  // Non-owners can only change roles whose permissions they already hold.
  const withinReach = !role || access.covers(role);
  const editable =
    manage && withinReach && (creating || (!role.builtIn && !role.archived));
  const granted = new Set(values.permissions);
  const holds = (key: string) =>
    role?.allAppPermissions && key.includes(':') ? true : granted.has(key);
  const grantable = (key: string) => access.owner || access.can(key);
  const changes = permissionChanges(saved.permissions, values.permissions);
  const renamed =
    values.name.trim() !== saved.name ||
    values.description.trim() !== saved.description;
  const dirty =
    creating || renamed || !!changes.added.length || !!changes.removed.length;
  const people =
    members.data?.filter((member) => role && member.role.id === role.id) ?? [];
  const labels = useMemo(
    () => new Map(catalog.permissions.map((item) => [item.key, item])),
    [catalog.permissions],
  );
  const blocked = !online || command.locked;
  const nameTaken = catalog.roles.some(
    (other) =>
      other.id !== role?.id &&
      !other.archived &&
      other.name.trim().toLowerCase() === values.name.trim().toLowerCase(),
  );

  const change = (next: Partial<Values>) => setEdits({ ...values, ...next });
  const toggle = (key: string, on: boolean) =>
    change({
      permissions: on
        ? [...new Set([...values.permissions, key])]
        : values.permissions.filter((item) => item !== key),
    });

  async function save() {
    let created: string | undefined;
    await command.run(
      async (commandId) => {
        const body = {
          name: values.name.trim(),
          description: values.description.trim(),
          permissions: values.permissions,
        };
        const result = role
          ? await settingsApi.roles.update({
              params: { organizationId, roleId: role.id },
              headers: { 'x-command-id': commandId },
              body: { ...body, revision: role.revision },
            })
          : await settingsApi.roles.create({
              params: { organizationId },
              headers: { 'x-command-id': commandId },
              body,
            });
        created = (settingsResult(result) as WorkspaceRole).id;
        setReviewing(false);
        setEdits(null);
      },
      role
        ? 'Role saved. It applies on each person’s next request.'
        : 'Role created.',
    );
    if (creating && created) close(created);
  }

  const term = query.trim().toLowerCase();
  const matches = (permission: PermissionDefinition) =>
    (!term ||
      `${permission.label} ${permission.description} ${permission.key}`
        .toLowerCase()
        .includes(term)) &&
    (!grantedOnly || holds(permission.key));
  const groups = catalog.groups
    .map((group) => ({
      group,
      all: catalog.permissions.filter((item) => item.group === group.id),
    }))
    .filter(({ all }) => all.length)
    .map((entry) => ({ ...entry, shown: entry.all.filter(matches) }));
  const total = catalog.permissions.length;
  const count = catalog.permissions.filter((item) => holds(item.key)).length;
  const sensitive = catalog.permissions.filter(
    (item) => item.consequential && holds(item.key),
  ).length;

  return (
    <section className="role-editor" aria-labelledby="role-title">
      <Button
        variant="ghost"
        size="sm"
        className="role-back"
        onClick={() => close()}
      >
        <ArrowLeft size={15} /> All roles
      </Button>
      <header className="role-header">
        {role ? (
          <RoleMark role={role} />
        ) : (
          <RoleMark role={{ key: 'custom' }} />
        )}
        <div className="role-header-copy">
          <h2 id="role-title">
            {values.name.trim() || 'New role'}
            {role?.builtIn ? <Badge>Built-in</Badge> : null}
            {role?.archived ? <Badge tone="warning">Archived</Badge> : null}
            {creating ? <Badge tone="accent">Not saved yet</Badge> : null}
          </h2>
          <p>{values.description.trim() || 'No description'}</p>
          <span className="role-header-meta">
            {role
              ? `${role.memberCount} ${role.memberCount === 1 ? 'person' : 'people'} · `
              : null}
            {role?.allAppPermissions
              ? 'Every permission, including installed apps'
              : `${count} of ${total} permissions${sensitive ? ` · ${sensitive} sensitive` : ''}`}
            {role?.updatedAt ? (
              <>
                {' · Updated '}
                <WorkspaceDate value={role.updatedAt} />
              </>
            ) : null}
          </span>
        </div>
        {role && manage ? (
          <div className="role-header-actions">
            <Button
              variant="outline"
              size="sm"
              disabled={blocked}
              onClick={() => duplicate(role)}
            >
              <Copy size={14} /> Duplicate
            </Button>
            {!role.builtIn && !role.archived && withinReach ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={blocked}
                onClick={() => setArchiving(true)}
              >
                <Archive size={14} /> Archive
              </Button>
            ) : null}
          </div>
        ) : null}
      </header>
      {role?.builtIn ? (
        <Alert tone="neutral">
          Built-in roles can’t be changed and gain new permissions as Luma adds
          features.
          {manage ? ' Duplicate this role to start a custom one.' : null}
        </Alert>
      ) : null}
      {role?.archived ? (
        <Alert tone="neutral">
          This role is archived. Nobody has it, and it can’t be assigned.
        </Alert>
      ) : null}
      {role && manage && !withinReach && !role.builtIn && !role.archived ? (
        <Alert tone="neutral">
          This role has permissions your role doesn’t include, so only an owner
          or someone with all of them can change it.
        </Alert>
      ) : null}
      {!creating ? (
        <Tabs
          value={tab}
          onValueChange={(next) =>
            setTab(
              next === 'people' || next === 'history' ? next : 'permissions',
            )
          }
        >
          <TabsList aria-label="Role details" activateOnFocus={false}>
            <TabsTrigger value="permissions">Permissions</TabsTrigger>
            <TabsTrigger value="people">
              People <span className="role-tab-count">{role.memberCount}</span>
            </TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
        </Tabs>
      ) : null}
      {tab === 'people' && role ? (
        <RolePeople
          organizationId={organizationId}
          people={people}
          loading={members.isPending}
        />
      ) : null}
      {tab === 'history' && role ? (
        <RoleHistory
          organizationId={organizationId}
          role={role}
          labels={labels}
          allowed={manage}
        />
      ) : null}
      {tab === 'permissions' ? (
        <>
          {editable ? (
            <div className="settings-panel">
              <div className="settings-field">
                <label htmlFor="role-edit-name">Name</label>
                <Input
                  id="role-edit-name"
                  value={values.name}
                  maxLength={60}
                  required
                  disabled={blocked}
                  aria-invalid={nameTaken || undefined}
                  onChange={(event) => change({ name: event.target.value })}
                />
                {nameTaken ? (
                  <small className="roles-field-error">
                    Another role already has this name.
                  </small>
                ) : null}
              </div>
              <div className="settings-field">
                <label htmlFor="role-edit-description">Description</label>
                <p>Help admins choose the right role when inviting people.</p>
                <Textarea
                  id="role-edit-description"
                  value={values.description}
                  maxLength={300}
                  rows={2}
                  className="min-h-16"
                  disabled={blocked}
                  onChange={(event) =>
                    change({ description: event.target.value })
                  }
                />
              </div>
            </div>
          ) : null}
          <div className="role-toolbar">
            <div className="settings-search">
              <Search size={15} aria-hidden="true" />
              <Input
                aria-label="Search permissions"
                placeholder="Search permissions…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <label className="role-toolbar-toggle">
              <Switch
                checked={grantedOnly}
                onCheckedChange={setGrantedOnly}
                aria-label="Show granted permissions only"
              />
              Granted only
            </label>
          </div>
          {groups.every(({ shown }) => !shown.length) ? (
            <div className="settings-empty">
              <Search size={20} aria-hidden="true" />
              <strong>No permissions match</strong>
              <Button
                variant="ghost"
                onClick={() => {
                  setQuery('');
                  setGrantedOnly(false);
                }}
              >
                Clear filters
              </Button>
            </div>
          ) : null}
          {groups.map(({ group, all, shown }) =>
            shown.length ? (
              <PermissionGroup
                key={group.id}
                group={group}
                all={all}
                shown={shown}
                role={role}
                holds={holds}
                editable={editable && group.app?.available !== false}
                grantable={grantable}
                blocked={blocked}
                toggle={toggle}
                setMany={(keys, on) =>
                  change({
                    permissions: on
                      ? [...new Set([...values.permissions, ...keys])]
                      : values.permissions.filter((key) => !keys.includes(key)),
                  })
                }
              />
            ) : null,
          )}
          {editable && dirty ? (
            <div
              className="role-savebar"
              role="region"
              aria-label="Unsaved role changes"
            >
              <span>
                {creating
                  ? `${values.permissions.length} permission${values.permissions.length === 1 ? '' : 's'} selected`
                  : [
                      changes.added.length
                        ? `${changes.added.length} added`
                        : null,
                      changes.removed.length
                        ? `${changes.removed.length} removed`
                        : null,
                      renamed ? 'details changed' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
              </span>
              <Button
                variant="ghost"
                disabled={command.pending}
                onClick={() => (creating ? close() : setEdits(null))}
              >
                {creating ? 'Cancel' : 'Discard changes'}
              </Button>
              <Button
                disabled={blocked || !values.name.trim() || nameTaken}
                onClick={() => setReviewing(true)}
              >
                {creating ? 'Review and create' : 'Review changes'}
              </Button>
            </div>
          ) : null}
          {!reviewing && !archiving ? (
            <CommandFeedback command={command} />
          ) : null}
        </>
      ) : null}
      <ReviewDialog
        open={reviewing}
        close={() => {
          if (!command.locked) setReviewing(false);
        }}
        creating={creating}
        name={values.name.trim()}
        renamed={!creating && renamed ? { before: saved, after: values } : null}
        added={creating ? [...values.permissions].sort() : changes.added}
        removed={creating ? [] : changes.removed}
        labels={labels}
        people={people.map(
          (member) => member.name ?? member.email ?? 'A teammate',
        )}
        command={command}
        save={() => void save()}
      />
      {role ? (
        <ArchiveDialog
          organizationId={organizationId}
          open={archiving}
          role={role}
          showPeople={() => {
            setArchiving(false);
            setTab('people');
          }}
          close={() => setArchiving(false)}
          archived={() => close()}
        />
      ) : null}
    </section>
  );
}

function PermissionGroup({
  group,
  all,
  shown,
  role,
  holds,
  editable,
  grantable,
  blocked,
  toggle,
  setMany,
}: {
  group: RolesSnapshot['groups'][number];
  all: PermissionDefinition[];
  shown: PermissionDefinition[];
  role: WorkspaceRole | null;
  holds: (key: string) => boolean;
  editable: boolean;
  grantable: (key: string) => boolean;
  blocked: boolean;
  toggle: (key: string, on: boolean) => void;
  setMany: (keys: string[], on: boolean) => void;
}) {
  const titleId = useId();
  const held = all.filter((item) => holds(item.key)).length;
  const reachable = shown.filter((item) => grantable(item.key));
  const allOn = reachable.every((item) => holds(item.key));

  return (
    <section className="settings-panel role-group" aria-labelledby={titleId}>
      <div className="settings-panel-heading">
        <div>
          <h3 id={titleId}>
            {group.label}
            {group.app ? <Badge tone="info">App</Badge> : null}
            {group.app && !group.app.available ? (
              <Badge tone="warning">Unavailable</Badge>
            ) : null}
          </h3>
          <p>{group.description}</p>
        </div>
        <div className="role-group-summary">
          <span>
            {held}/{all.length}
          </span>
          {editable && reachable.length > 1 ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={blocked}
              onClick={() =>
                setMany(
                  reachable.map((item) => item.key),
                  !allOn,
                )
              }
            >
              {allOn ? 'Remove all' : 'Grant all'}
            </Button>
          ) : null}
        </div>
      </div>
      <ul className="role-permissions">
        {shown.map((permission) => (
          <PermissionRow
            key={permission.key}
            permission={permission}
            on={holds(permission.key)}
            isNew={isNewForRole(permission, role)}
            editable={editable}
            grantable={grantable(permission.key)}
            blocked={blocked}
            toggle={toggle}
          />
        ))}
      </ul>
    </section>
  );
}

function PermissionRow({
  permission,
  on,
  isNew,
  editable,
  grantable,
  blocked,
  toggle,
}: {
  permission: PermissionDefinition;
  on: boolean;
  isNew: boolean;
  editable: boolean;
  grantable: boolean;
  blocked: boolean;
  toggle: (key: string, on: boolean) => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  // Removing is always possible; granting needs the editor to hold the permission.
  const locked = !on && !grantable;

  return (
    <li className="role-permission" data-on={on || undefined}>
      <span className="role-permission-copy">
        <strong id={titleId}>
          {permission.label}
          {permission.consequential ? (
            <Badge tone="warning">Sensitive</Badge>
          ) : null}
          {isNew ? <Badge tone="accent">New</Badge> : null}
        </strong>
        <span id={descriptionId}>
          {permission.description}
          {editable && locked ? (
            <em> You can’t grant this because your role doesn’t include it.</em>
          ) : null}
        </span>
      </span>
      {editable ? (
        <Switch
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          checked={on}
          disabled={blocked || locked}
          onCheckedChange={(next) => toggle(permission.key, next)}
        />
      ) : (
        <span className="role-permission-state" data-on={on || undefined}>
          {on ? (
            <>
              <Check size={14} aria-hidden="true" /> Included
            </>
          ) : (
            <>
              <Minus size={14} aria-hidden="true" /> Not included
            </>
          )}
        </span>
      )}
    </li>
  );
}

function ReviewDialog({
  open,
  close,
  creating,
  name,
  renamed,
  added,
  removed,
  labels,
  people,
  command,
  save,
}: {
  open: boolean;
  close: () => void;
  creating: boolean;
  name: string;
  renamed: { before: Values; after: Values } | null;
  added: string[];
  removed: string[];
  labels: Map<string, PermissionDefinition>;
  people: string[];
  command: ReturnType<typeof useSettingsCommand>;
  save: () => void;
}) {
  const sensitive = added.filter((key) => labels.get(key)?.consequential);
  const list = (keys: string[], tone: 'added' | 'removed') => (
    <ul className="role-review-list" data-tone={tone}>
      {keys.map((key) => (
        <li key={key}>
          {tone === 'added' ? (
            <Plus size={13} aria-hidden="true" />
          ) : (
            <Minus size={13} aria-hidden="true" />
          )}
          <span className="sr-only">
            {tone === 'added' ? 'Grant' : 'Remove'}:
          </span>
          {labels.get(key)?.label ?? key}
          {labels.get(key)?.consequential ? (
            <Badge tone="warning">Sensitive</Badge>
          ) : null}
        </li>
      ))}
    </ul>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="role-review">
        <DialogTitle>
          {creating ? `Create ${name}` : `Review changes to ${name}`}
        </DialogTitle>
        <DialogDescription>
          {creating
            ? 'Check what this role allows. You can assign it to people after it’s created.'
            : people.length
              ? `These changes apply to ${people.length} ${people.length === 1 ? 'person' : 'people'} on their next request.`
              : 'Nobody has this role yet, so the changes affect no one right now.'}
        </DialogDescription>
        {renamed &&
        (renamed.before.name !== renamed.after.name.trim() ||
          renamed.before.description !== renamed.after.description.trim()) ? (
          <div className="role-review-section">
            <h3>Details</h3>
            {renamed.before.name !== renamed.after.name.trim() ? (
              <p>
                Name: {renamed.before.name} → {renamed.after.name.trim()}
              </p>
            ) : null}
            {renamed.before.description !== renamed.after.description.trim() ? (
              <p>Description updated</p>
            ) : null}
          </div>
        ) : null}
        {added.length ? (
          <div className="role-review-section">
            <h3>{creating ? 'Permissions' : `Granted (${added.length})`}</h3>
            {list(added, 'added')}
          </div>
        ) : creating ? (
          <p className="settings-note">
            This role has no permissions. People with it can sign in but see no
            workspace data.
          </p>
        ) : null}
        {removed.length ? (
          <div className="role-review-section">
            <h3>Removed ({removed.length})</h3>
            {list(removed, 'removed')}
          </div>
        ) : null}
        {sensitive.length ? (
          <Alert tone="warning">
            {sensitive.length === 1
              ? 'One permission lets people change data, access or policy, or see personal data.'
              : `${sensitive.length} permissions let people change data, access or policy, or see personal data.`}{' '}
            Grant them only to people who need them.
          </Alert>
        ) : null}
        {!creating && people.length ? (
          <div className="role-review-section">
            <h3>People with this role</h3>
            <p className="role-review-people">
              {people.slice(0, 6).join(', ')}
              {people.length > 6 ? ` and ${people.length - 6} more` : ''}
            </p>
          </div>
        ) : null}
        {open ? <CommandFeedback command={command} /> : null}
        <DialogFooter>
          <Button variant="outline" disabled={command.locked} onClick={close}>
            Back to editing
          </Button>
          <Button disabled={command.locked} onClick={save}>
            {command.pending
              ? 'Saving…'
              : creating
                ? 'Create role'
                : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ArchiveDialog({
  organizationId,
  open,
  role,
  showPeople,
  close,
  archived,
}: {
  organizationId: string;
  open: boolean;
  role: WorkspaceRole;
  showPeople: () => void;
  close: () => void;
  archived: () => void;
}) {
  const command = useSettingsCommand(organizationId);
  const inUse = role.memberCount > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !command.locked) close();
      }}
    >
      <DialogContent>
        <DialogTitle>Archive {role.name}?</DialogTitle>
        <DialogDescription>
          {inUse
            ? `${role.memberCount} ${role.memberCount === 1 ? 'person has' : 'people have'} this role. Give them another role in Team before archiving it.`
            : 'Archived roles can’t be assigned. Their history stays available.'}
        </DialogDescription>
        {!inUse && role.pendingInvitations ? (
          <Alert tone="warning">
            {role.pendingInvitations} pending invitation
            {role.pendingInvitations === 1 ? '' : 's'} for this role will be
            revoked. Invite those people again with another role.
          </Alert>
        ) : null}
        <CommandFeedback command={command} />
        <DialogFooter>
          {inUse ? (
            <Button onClick={showPeople}>Show people</Button>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={command.locked}
                onClick={close}
              >
                Keep role
              </Button>
              <Button
                variant="destructive"
                disabled={command.locked}
                onClick={() =>
                  void command.run(async (commandId) => {
                    settingsResult(
                      await settingsApi.roles.archive({
                        params: { organizationId, roleId: role.id },
                        headers: { 'x-command-id': commandId },
                        body: { revision: role.revision },
                      }),
                    );
                    close();
                    archived();
                  }, 'Role archived.')
                }
              >
                {command.pending ? 'Archiving…' : 'Archive role'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
