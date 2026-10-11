import { m } from '@luma/i18n/messages';
import { Badge } from '@luma/ui/components/primitives/badge';
import { useId } from 'react';

import type { WorkspaceRole } from '../../kit/settings/roles-data';

/** A role offered in a picker, with the reason it can't be chosen when disabled. */
export interface RoleChoice {
  role: WorkspaceRole;
  unavailable?: string | undefined;
}

/**
 * Chooses one role from a list of radio cards that show what each role is for. Disabled roles
 * explain why they can't be chosen.
 */
export function RolePicker({
  label,
  choices,
  value,
  disabled,
  onChange,
}: {
  label: string;
  choices: RoleChoice[];
  value: string;
  disabled?: boolean;
  onChange: (roleId: string) => void;
}) {
  const name = useId();

  return (
    <fieldset className="role-picker" disabled={disabled}>
      <legend>{label}</legend>
      {choices.map(({ role, unavailable }) => {
        const id = `${name}-${role.id}`;

        return (
          <label
            key={role.id}
            className="role-choice"
            htmlFor={id}
            data-disabled={unavailable ? true : undefined}
          >
            <input
              type="radio"
              id={id}
              name={name}
              value={role.id}
              checked={value === role.id}
              disabled={!!unavailable}
              aria-describedby={`${id}-description`}
              onChange={() => onChange(role.id)}
            />
            <span className="role-choice-copy">
              <strong>
                {role.name}
                {role.builtIn ? null : (
                  <Badge>{m.settings_role_custom()}</Badge>
                )}
              </strong>
              <span id={`${id}-description`}>
                {unavailable ??
                  (role.description || m.settings_role_no_description())}
              </span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
