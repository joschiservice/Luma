import type { Permission } from './permissions.js';
import {
  appPermissionOwner,
  isPermission,
  permissionCatalog,
} from './permissions.js';

export type BuiltInRoleKey = 'owner' | 'admin' | 'member';

/** The role a membership or invitation points at; built-in IDs equal their key. */
export interface RoleReference {
  id: string;
  key: BuiltInRoleKey | 'custom';
  name: string;
  builtIn: boolean;
  /** Increases with every change; built-in roles stay at 1. */
  revision: number;
}

interface BuiltInRole {
  key: BuiltInRoleKey;
  name: string;
  description: string;
  permissions: readonly Permission[];
  /** Built-in roles that manage the workspace hold every installed app's permissions. */
  appPermissions: boolean;
}

const allCore = permissionCatalog.map((permission) => permission.key);

const memberPermissions = [
  'adaptive.fields.read',
  'orders.read',
  'fulfillment.read',
  'inventory.read',
  'products.read',
  'customers.read',
  'returns.read',
  'insights.read',
  'issues.read',
  'decisions.self_assign',
  'workflows.read',
  'procurement.read',
  'messages.read',
  'assistant.use',
  'activity.read',
] as const satisfies readonly Permission[];

/**
 * Roles every workspace has. They can't be edited: new catalog permissions reach Owner and
 * Admin here, and Member only when added to its list.
 */
export const builtInRoles: Readonly<Record<BuiltInRoleKey, BuiltInRole>> = {
  owner: {
    key: 'owner',
    name: 'Owner',
    description:
      'Full access, including granting and removing ownership. Every workspace keeps at least one owner.',
    permissions: allCore,
    appPermissions: true,
  },
  admin: {
    key: 'admin',
    name: 'Admin',
    description:
      'Runs the workspace: settings, team, connections, workflows, and every change. Can’t change owners.',
    permissions: allCore,
    appPermissions: true,
  },
  member: {
    key: 'member',
    name: 'Member',
    description:
      'Sees operations, records, and workflows, takes decisions, and asks Luma. Can’t change data or settings.',
    permissions: memberPermissions,
    appPermissions: false,
  },
};

/** Reports whether a value names a built-in role. */
export function isBuiltInRole(value: string): value is BuiltInRoleKey {
  return Object.hasOwn(builtInRoles, value);
}

/** Describes a built-in role as a role reference. */
export function builtInReference(key: BuiltInRoleKey): RoleReference {
  return {
    id: key,
    key,
    name: builtInRoles[key].name,
    builtIn: true,
    revision: 1,
  };
}

/**
 * An immutable set of granted permission keys. Built-in roles that manage the workspace also
 * answer yes for every app permission; the app host still requires the app to be installed.
 */
export class PermissionSet implements Iterable<string> {
  readonly #keys: ReadonlySet<string>;
  readonly #allApps: boolean;

  constructor(keys: Iterable<string>, allApps = false) {
    this.#keys = new Set(keys);
    this.#allApps = allApps;
    Object.freeze(this);
  }

  /** Builds the permissions of a built-in role or of a custom role's stored grants. */
  static forRole(role: RoleReference, granted: Iterable<string> = []) {
    if (role.key === 'custom')
      return new PermissionSet(
        [...granted].filter(
          (key) => isPermission(key) || appPermissionOwner(key) !== null,
        ),
      );
    const definition = builtInRoles[role.key];

    return new PermissionSet(definition.permissions, definition.appPermissions);
  }

  has(permission: string): boolean {
    return (
      this.#keys.has(permission) ||
      (this.#allApps && appPermissionOwner(permission) !== null)
    );
  }

  /** True when every app permission is granted, as for Owner and Admin. */
  get allAppPermissions() {
    return this.#allApps;
  }

  get size() {
    return this.#keys.size;
  }

  /** Reports whether this set grants everything another set grants. */
  covers(other: PermissionSet): boolean {
    if (other.#allApps && !this.#allApps) return false;

    return [...other.#keys].every((key) => this.has(key));
  }

  [Symbol.iterator]() {
    return [...this.#keys].sort()[Symbol.iterator]();
  }

  toJSON() {
    return [...this];
  }
}
