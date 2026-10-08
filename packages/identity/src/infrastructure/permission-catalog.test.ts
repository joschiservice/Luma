import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import {
  appPermissionGroupDescription,
  permissionCatalog,
  permissionGroups,
} from '../domain/permissions.js';
import { builtInRoles } from '../domain/roles.js';

// The web localizes this text by key from the English catalog; both must say the same thing.
const catalog = JSON.parse(
  readFileSync(
    new URL('../../../i18n/messages/en/permissions.json', import.meta.url),
    'utf8',
  ),
) as Record<string, string>;

const key = (id: string) => id.replaceAll(/[.:-]/g, '_');

it('keeps the English message catalog in sync with permission groups', () => {
  for (const group of permissionGroups) {
    expect(catalog[`permissions_group_${key(group.id)}_label`]).toBe(
      group.label,
    );
    expect(catalog[`permissions_group_${key(group.id)}_description`]).toBe(
      group.description,
    );
  }
  expect(catalog.permissions_app_group_description).toBe(
    appPermissionGroupDescription('{app}', true),
  );
  expect(catalog.permissions_app_group_unavailable).toBe(
    appPermissionGroupDescription('{app}', false),
  );
});

it('keeps the English message catalog in sync with core permissions', () => {
  for (const permission of permissionCatalog) {
    expect(catalog[`permissions_${key(permission.key)}_label`]).toBe(
      permission.label,
    );
    expect(catalog[`permissions_${key(permission.key)}_description`]).toBe(
      permission.description,
    );
  }
});

it('keeps the English message catalog in sync with built-in roles', () => {
  for (const role of Object.values(builtInRoles)) {
    expect(catalog[`permissions_role_${role.key}_name`]).toBe(role.name);
    expect(catalog[`permissions_role_${role.key}_description`]).toBe(
      role.description,
    );
  }
});
