import { z } from 'zod';

const appSlotSchema = z.enum([
  'connections',
  'settings',
  'app-settings',
  'page',
  'record',
  'inventory',
  'fulfillment',
]);

export const appManifestSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  category: z.enum(['storefront', 'erp', 'utility']),
  ui: z.array(appSlotSchema),
  connectionTypes: z.array(z.object({ kind: z.string(), name: z.string() })),
  /** Permissions the app owns, namespaced `<appId>:<name>`; roles can grant them. */
  permissions: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      description: z.string(),
      consequential: z.boolean(),
    }),
  ),
  /** Core permissions the app needs in the workspace; installing grants them. */
  scopes: z.array(z.string()),
  /** The permission a person needs to see each UI slot, keyed by slot. */
  slotAccess: z.record(z.string(), z.string()),
});

export const workspaceAppSchema = z.object({
  appId: z.string(),
  status: z.enum(['installed', 'uninstalled']),
  version: z.number().int().positive(),
  updatedAt: z.string().datetime(),
  /** Scopes granted to the current installation; empty after uninstall. */
  grantedScopes: z.array(z.string()),
});

export const workspaceAppStateSchema = workspaceAppSchema.extend({
  /** Scopes a newer app version requests that nobody approved yet. */
  pendingScopes: z.array(z.string()),
  /** Active roles holding this app's permissions; uninstalling removes them. */
  roles: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      permissions: z.number().int(),
    }),
  ),
});

export type AppManifest = z.infer<typeof appManifestSchema>;

export type WorkspaceApp = z.infer<typeof workspaceAppSchema>;

export type WorkspaceAppState = z.infer<typeof workspaceAppStateSchema>;
