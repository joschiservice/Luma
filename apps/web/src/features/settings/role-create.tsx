import { Button } from '@luma/ui/components/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { Textarea } from '@luma/ui/components/primitives/textarea';
import { useState } from 'react';

import { usePermissions } from '../identity/permissions';
import type { WorkspaceRole } from './roles-data';

/** A role being created: its details and the permissions it starts with. */
export interface RoleDraft {
  name: string;
  description: string;
  permissions: string[];
  /** The role it was duplicated from, if any. */
  basedOn: string | null;
}

/**
 * Asks for a new role's name and starting point. Starting from another role copies the
 * permissions the person may grant; nothing is saved until they review the role.
 */
export function CreateRoleDialog({
  organizationId,
  roles,
  state,
  close,
  start,
}: {
  organizationId: string;
  roles: WorkspaceRole[];
  state: { base: WorkspaceRole | null } | null;
  close: () => void;
  start: (draft: RoleDraft) => void;
}) {
  return (
    <Dialog
      open={!!state}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent>
        {state ? (
          <CreateRoleForm
            key={state.base?.id ?? 'blank'}
            organizationId={organizationId}
            roles={roles}
            base={state.base}
            start={start}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function CreateRoleForm({
  organizationId,
  roles,
  base,
  start,
}: {
  organizationId: string;
  roles: WorkspaceRole[];
  base: WorkspaceRole | null;
  start: (draft: RoleDraft) => void;
}) {
  const access = usePermissions(organizationId);
  const [name, setName] = useState(base ? `${base.name} copy` : '');
  const [description, setDescription] = useState(base?.description ?? '');
  const [from, setFrom] = useState(base?.id ?? 'blank');
  const source = roles.find((role) => role.id === from) ?? null;
  const taken = roles.some(
    (role) =>
      !role.archived &&
      role.name.trim().toLowerCase() === name.trim().toLowerCase(),
  );
  const options = [
    { value: 'blank', label: 'No permissions' },
    ...roles
      .filter((role) => !role.archived)
      .map((role) => ({ value: role.id, label: role.name })),
  ];
  const withheld = source
    ? source.permissions.filter((key) => !access.owner && !access.can(key))
    : [];

  return (
    <>
      <DialogTitle>
        {base ? `Duplicate ${base.name}` : 'Create a role'}
      </DialogTitle>
      <DialogDescription>
        Name the role and choose where to start. You’ll review every permission
        before anything is saved.
      </DialogDescription>
      <form
        className="settings-dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          start({
            name: name.trim(),
            description: description.trim(),
            permissions: source
              ? source.permissions.filter((key) => !withheld.includes(key))
              : [],
            basedOn: source?.id ?? null,
          });
        }}
      >
        <label htmlFor="role-name">Name</label>
        <Input
          id="role-name"
          required
          maxLength={60}
          value={name}
          autoFocus
          aria-invalid={taken || undefined}
          aria-describedby={taken ? 'role-name-taken' : undefined}
          placeholder="For example, Buyer"
          onChange={(event) => setName(event.target.value)}
        />
        {taken ? (
          <p className="roles-field-error" id="role-name-taken">
            Another role already has this name.
          </p>
        ) : null}
        <label htmlFor="role-description">Description</label>
        <Textarea
          id="role-description"
          maxLength={300}
          rows={2}
          className="min-h-16"
          value={description}
          placeholder="Who should have this role and what they work on"
          onChange={(event) => setDescription(event.target.value)}
        />
        <label id="role-from-label">Start from</label>
        <Select
          aria-labelledby="role-from-label"
          options={options}
          value={from}
          onValueChange={(value) => {
            if (value) setFrom(value);
          }}
        />
        {source?.allAppPermissions ? (
          <p className="settings-note">
            App permissions are not copied from {source.name}. Grant the ones
            this role needs in the next step.
          </p>
        ) : null}
        {withheld.length ? (
          <p className="settings-note">
            {withheld.length} permission{withheld.length === 1 ? '' : 's'} from{' '}
            {source?.name} stay off because your role doesn’t include them.
          </p>
        ) : null}
        <Button type="submit" disabled={!name.trim() || taken}>
          Continue to permissions
        </Button>
      </form>
    </>
  );
}
