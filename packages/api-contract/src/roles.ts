import { z } from 'zod';

const roleKeySchema = z.enum(['owner', 'admin', 'member', 'custom']);

/** The role a membership or invitation uses. Built-in role IDs equal their key. */
export const roleReferenceSchema = z.object({
  id: z.string(),
  key: roleKeySchema,
  name: z.string(),
  builtIn: z.boolean(),
  revision: z.number().int().positive(),
});

const appOwnerSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** False when the app is installed but its package is missing from this deployment. */
  available: z.boolean(),
});

const permissionGroupSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  /** Set for permissions an installed app declares. */
  app: appOwnerSchema.nullable(),
});

const permissionDefinitionSchema = z.object({
  key: z.string(),
  group: z.string(),
  label: z.string(),
  description: z.string(),
  consequential: z.boolean(),
  /**
   * ISO date a core permission was added; role editors mark permissions added after a role last
   * changed as new. Null for app permissions.
   */
  introduced: z.string().nullable(),
});

export const workspaceRoleSchema = z.object({
  id: z.string(),
  key: roleKeySchema,
  name: z.string(),
  description: z.string(),
  builtIn: z.boolean(),
  revision: z.number().int().positive(),
  archived: z.boolean(),
  /** Granted keys. Owner and Admin also hold every installed app's permissions. */
  permissions: z.array(z.string()),
  allAppPermissions: z.boolean(),
  memberCount: z.number().int().nonnegative(),
  pendingInvitations: z.number().int().nonnegative(),
  updatedAt: z.string().nullable(),
});

export const rolesSnapshotSchema = z.object({
  roles: z.array(workspaceRoleSchema),
  groups: z.array(permissionGroupSchema),
  permissions: z.array(permissionDefinitionSchema),
});

const permissionKeySchema = z
  .string()
  .max(120)
  .regex(/^([a-z][a-z0-9-]{0,39}:)?[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/);

export const roleInputSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    description: z.string().trim().max(300),
    permissions: z.array(permissionKeySchema).max(200),
  })
  .strict();

export const roleHistoryEventSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum([
    'created',
    'updated',
    'archived',
    'app_permissions_removed',
    'member_assigned',
    'member_unassigned',
  ]),
  occurredAt: z.string(),
  actor: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  revision: z.number().int().nullable(),
  name: z
    .object({ before: z.string().nullable(), after: z.string().nullable() })
    .nullable(),
  added: z.array(z.string()),
  removed: z.array(z.string()),
  member: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  /** Why the change happened when no person made it directly, such as an app uninstall. */
  cause: z
    .object({ kind: z.literal('app_uninstalled'), appId: z.string() })
    .nullable(),
});

export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

export type RolesSnapshot = z.infer<typeof rolesSnapshotSchema>;

export type PermissionDefinition = z.infer<typeof permissionDefinitionSchema>;

export type RoleHistoryEvent = z.infer<typeof roleHistoryEventSchema>;
