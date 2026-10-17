import { conflict, forbidden, notFound, ServiceError } from '@luma/platform';

import type { Membership, TenantContext } from '../domain/context.js';
import { requireActiveMembership } from '../domain/context.js';
import type { PermissionDefinition } from '../domain/permissions.js';
import {
  appPermissionGroupDescription,
  appPermissionOwner,
  isPermission,
  permissionCatalog,
  permissionGroups,
} from '../domain/permissions.js';
import type { BuiltInRoleKey } from '../domain/roles.js';
import { builtInRoles } from '../domain/roles.js';

/** Permissions an app installed in the workspace declares. */
export interface AppPermissionGroup {
  app: { id: string; name: string; available: boolean };
  permissions: Omit<PermissionDefinition, 'group' | 'introduced'>[];
}

/** Reads app permission definitions without loading app code for missing packages. */
export type AppPermissionSource = (
  tenantId: string,
) => Promise<AppPermissionGroup[]>;

export interface StoredRole {
  id: string;
  name: string;
  description: string;
  revision: number;
  archived: boolean;
  permissions: string[];
  updatedAt: string;
}

export interface RoleEvent {
  id: string;
  type: string;
  actorId: string;
  actorName: string | null;
  memberName: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
}

export interface RolesTransaction {
  member(userId: string): Promise<Membership | null>;
  /** Lists custom roles, including archived ones, with their grants. */
  roles(): Promise<StoredRole[]>;
  /** Locks and reads one custom role. */
  role(id: string): Promise<StoredRole | null>;
  /** Counts members and pending invitations per role ID. */
  usage(): Promise<Map<string, { members: number; invitations: number }>>;
  command(
    id: string,
  ): Promise<{ actorId: string; request: unknown; result: unknown } | null>;
  saveCommand(
    id: string,
    actorId: string,
    request: unknown,
    result: unknown,
  ): Promise<void>;
  insert(role: StoredRole, actorId: string): Promise<void>;
  update(role: StoredRole): Promise<void>;
  /** Revokes pending invitations for the role and returns how many changed. */
  revokeInvitations(roleId: string): Promise<number>;
  audit(
    actorId: string,
    type: string,
    roleId: string,
    before: unknown,
    after: unknown,
  ): Promise<void>;
  history(roleId: string, limit: number): Promise<RoleEvent[]>;
}

export interface RolesRepository {
  transaction<T>(
    tenantId: string,
    userId: string,
    operation: (tx: RolesTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface RoleInput {
  name: string;
  description: string;
  permissions: string[];
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const difference = (a: Iterable<string>, b: Iterable<string>) => {
  const other = new Set(b);

  return [...new Set(a)].filter((key) => !other.has(key)).sort();
};

/**
 * Lists, creates, edits and archives workspace roles. Mutations need `roles.manage`, run under
 * the workspace lock with command receipts, and never grant permissions the editor lacks.
 */
export function createRolesService(deps: {
  repository: RolesRepository;
  appPermissions: AppPermissionSource;
  id(): string;
  now(): Date;
}) {
  async function authorized<T>(
    context: TenantContext,
    manage: boolean,
    operation: (tx: RolesTransaction, actor: Membership) => Promise<T>,
  ) {
    return deps.repository.transaction(
      context.tenantId,
      context.actor.id,
      async (tx) => {
        const actor = await tx.member(context.actor.id);
        if (!actor) throw notFound('Workspace not found');
        requireActiveMembership(actor);
        if (manage && !actor.permissions.has('roles.manage'))
          throw forbidden(
            'Your role does not allow managing roles. Ask a workspace admin for access.',
          );

        return operation(tx, actor);
      },
    );
  }

  async function command<T>(
    context: TenantContext,
    commandId: string,
    request: unknown,
    operation: (tx: RolesTransaction, actor: Membership) => Promise<T>,
  ) {
    return authorized(context, true, async (tx, actor) => {
      const serialized = JSON.stringify(request);
      const previous = await tx.command(commandId);
      if (previous) {
        if (
          previous.actorId !== context.actor.id ||
          previous.request !== serialized
        )
          throw conflict(
            'This request ID was already used. Refresh before trying again.',
          );

        return previous.result as T;
      }
      const result = await operation(tx, actor);
      await tx.saveCommand(commandId, context.actor.id, serialized, result);

      return result;
    });
  }

  /** Rejects unknown or unavailable keys that are newly granted; existing grants may stay. */
  async function validate(
    tenantId: string,
    permissions: string[],
    existing: string[] = [],
  ) {
    const apps = new Map(
      (await deps.appPermissions(tenantId)).map((group) => [
        group.app.id,
        group,
      ]),
    );
    const kept = new Set(existing);
    const invalid = permissions.filter((key) => {
      if (kept.has(key) || isPermission(key)) return false;
      const app = apps.get(appPermissionOwner(key) ?? '');

      return (
        !app?.app.available ||
        !app.permissions.some((permission) => permission.key === key)
      );
    });
    if (invalid.length)
      throw new ServiceError(
        422,
        'VALIDATION_ERROR',
        `These permissions are unknown or unavailable: ${invalid.slice(0, 5).join(', ')}.`,
      );
  }

  /** Non-owners may only touch roles whose current and new grants they hold themselves. */
  function requireCovers(actor: Membership, ...grants: string[][]) {
    if (actor.role.key === 'owner') return;
    const missing = grants.flatMap((keys) =>
      keys.filter((key) => !actor.permissions.has(key)),
    );
    if (missing.length)
      throw forbidden(
        `You can only grant permissions you hold. Missing: ${[...new Set(missing)].slice(0, 5).join(', ')}.`,
      );
  }

  function summary(
    role: StoredRole,
    usage: Map<string, { members: number; invitations: number }>,
  ) {
    return {
      id: role.id,
      key: 'custom' as const,
      name: role.name,
      description: role.description,
      builtIn: false,
      revision: role.revision,
      archived: role.archived,
      permissions: [...role.permissions].sort(),
      allAppPermissions: false,
      memberCount: usage.get(role.id)?.members ?? 0,
      pendingInvitations: usage.get(role.id)?.invitations ?? 0,
      updatedAt: role.updatedAt,
    };
  }

  function normalized(input: RoleInput) {
    return {
      name: input.name.trim(),
      description: input.description.trim(),
      permissions: [...new Set(input.permissions)].sort(),
    };
  }

  return {
    /** Lists roles with usage and the grantable catalog; any member can read it. */
    list: (context: TenantContext) =>
      authorized(context, false, async (tx) => {
        const [custom, usage, apps] = await Promise.all([
          tx.roles(),
          tx.usage(),
          deps.appPermissions(context.tenantId),
        ]);
        const builtIn = (Object.keys(builtInRoles) as BuiltInRoleKey[]).map(
          (key) => {
            const role = builtInRoles[key];

            return {
              id: key,
              key,
              name: role.name,
              description: role.description,
              builtIn: true,
              revision: 1,
              archived: false,
              permissions: [...role.permissions].sort(),
              allAppPermissions: role.appPermissions,
              memberCount: usage.get(key)?.members ?? 0,
              pendingInvitations: usage.get(key)?.invitations ?? 0,
              updatedAt: null,
            };
          },
        );

        return {
          roles: [
            ...builtIn,
            ...custom
              .sort(
                (a, b) =>
                  Number(a.archived) - Number(b.archived) ||
                  a.name.localeCompare(b.name),
              )
              .map((role) => summary(role, usage)),
          ],
          groups: [
            ...permissionGroups.map((group) => ({ ...group, app: null })),
            ...apps.map((group) => ({
              id: `app:${group.app.id}`,
              label: group.app.name,
              description: appPermissionGroupDescription(
                group.app.name,
                group.app.available,
              ),
              app: group.app,
            })),
          ],
          permissions: [
            ...permissionCatalog.map((permission) => ({ ...permission })),
            ...apps.flatMap((group) =>
              group.permissions.map((permission) => ({
                ...permission,
                group: `app:${group.app.id}`,
                introduced: null,
              })),
            ),
          ],
        };
      }),

    /** Creates a custom role from scratch or from a duplicated role's grants. */
    create(context: TenantContext, commandId: string, input: RoleInput) {
      const value = normalized(input);

      return command(
        context,
        commandId,
        { kind: 'role.create', ...value },
        async (tx, actor) => {
          await validate(context.tenantId, value.permissions);
          requireCovers(actor, value.permissions);
          const role: StoredRole = {
            id: deps.id(),
            ...value,
            revision: 1,
            archived: false,
            updatedAt: deps.now().toISOString(),
          };
          await tx.insert(role, actor.userId);
          await tx.audit(actor.userId, 'role.created', role.id, null, {
            revision: 1,
            name: role.name,
            permissions: role.permissions,
          });

          return summary(role, new Map());
        },
      );
    },

    /** Saves a reviewed edit only if the role is still at the revision the editor read. */
    update(
      context: TenantContext,
      roleId: string,
      commandId: string,
      input: RoleInput & { revision: number },
    ) {
      const value = normalized(input);

      return command(
        context,
        commandId,
        { kind: 'role.update', roleId, revision: input.revision, ...value },
        async (tx, actor) => {
          const before = uuid.test(roleId) ? await tx.role(roleId) : null;
          if (!before)
            throw notFound('Role not found. Built-in roles cannot be changed.');
          if (before.archived)
            throw conflict('Archived roles cannot be changed.');
          if (before.revision !== input.revision)
            throw conflict(
              'Someone else changed this role. Review the latest version before saving.',
            );
          await validate(
            context.tenantId,
            value.permissions,
            before.permissions,
          );
          const added = difference(value.permissions, before.permissions);
          const removed = difference(before.permissions, value.permissions);
          requireCovers(actor, before.permissions, added);
          const usage = await tx.usage();
          if (
            !added.length &&
            !removed.length &&
            value.name === before.name &&
            value.description === before.description
          )
            return summary(before, usage);
          const after: StoredRole = {
            ...before,
            ...value,
            revision: before.revision + 1,
            updatedAt: deps.now().toISOString(),
          };
          await tx.update(after);
          await tx.audit(
            actor.userId,
            'role.updated',
            roleId,
            {
              revision: before.revision,
              name: before.name,
              permissions: removed,
            },
            {
              revision: after.revision,
              name: after.name,
              permissions: added,
            },
          );

          return summary(after, usage);
        },
      );
    },

    /** Archives an unused role and revokes its pending invitations. */
    archive(
      context: TenantContext,
      roleId: string,
      commandId: string,
      input: { revision: number },
    ) {
      return command(
        context,
        commandId,
        { kind: 'role.archive', roleId, revision: input.revision },
        async (tx, actor) => {
          const before = uuid.test(roleId) ? await tx.role(roleId) : null;
          if (!before)
            throw notFound(
              'Role not found. Built-in roles cannot be archived.',
            );
          if (before.archived) throw conflict('This role is already archived.');
          if (before.revision !== input.revision)
            throw conflict(
              'Someone else changed this role. Review the latest version first.',
            );
          requireCovers(actor, before.permissions);
          const members = (await tx.usage()).get(roleId)?.members ?? 0;
          if (members)
            throw conflict(
              `${members} ${members === 1 ? 'person has' : 'people have'} this role. Give them another role before archiving it.`,
            );
          const revoked = await tx.revokeInvitations(roleId);
          const after: StoredRole = {
            ...before,
            archived: true,
            revision: before.revision + 1,
            updatedAt: deps.now().toISOString(),
          };
          await tx.update(after);
          await tx.audit(
            actor.userId,
            'role.archived',
            roleId,
            { revision: before.revision },
            { revision: after.revision, revokedInvitations: revoked },
          );

          return summary(after, new Map());
        },
      );
    },

    /** Reads recent role changes and member assignments, newest first. */
    history: (context: TenantContext, roleId: string) =>
      authorized(context, true, async (tx) => {
        const events = await tx.history(roleId, 100);

        return events.map((event) => roleHistoryItem(event, roleId));
      }),
  };
}

const strings = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];

const text = (value: unknown) => (typeof value === 'string' ? value : null);

/** Maps a bounded access event to a role history entry. */
function roleHistoryItem(event: RoleEvent, roleId: string) {
  const before = event.before ?? {};
  const after = event.after ?? {};
  const kind =
    event.type === 'role.created'
      ? ('created' as const)
      : event.type === 'role.updated'
        ? ('updated' as const)
        : event.type === 'role.archived'
          ? ('archived' as const)
          : event.type === 'role.app_permissions_removed'
            ? ('app_permissions_removed' as const)
            : after.roleId === roleId
              ? ('member_assigned' as const)
              : ('member_unassigned' as const);
  const cause = after.cause as { kind?: unknown; appId?: unknown } | undefined;
  const member = kind === 'member_assigned' || kind === 'member_unassigned';

  return {
    id: event.id,
    kind,
    occurredAt: event.createdAt,
    actor:
      event.actorId === '00000000-0000-0000-0000-000000000000'
        ? null
        : { id: event.actorId, name: event.actorName },
    revision: typeof after.revision === 'number' ? after.revision : null,
    name:
      kind === 'created' ||
      (kind === 'updated' && text(before.name) !== text(after.name))
        ? { before: text(before.name), after: text(after.name) }
        : null,
    added: kind === 'app_permissions_removed' ? [] : strings(after.permissions),
    removed:
      kind === 'app_permissions_removed' || kind === 'updated'
        ? strings(before.permissions)
        : [],
    member: member
      ? {
          id:
            text(after.userId) ??
            text(before.userId) ??
            (event.type === 'invitation.accepted' ? event.actorId : ''),
          name: event.memberName,
        }
      : null,
    cause:
      cause?.kind === 'app_uninstalled' && typeof cause.appId === 'string'
        ? { kind: 'app_uninstalled' as const, appId: cause.appId }
        : null,
  };
}

export type RolesService = ReturnType<typeof createRolesService>;
