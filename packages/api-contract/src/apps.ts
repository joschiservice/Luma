import { z } from 'zod';

export const appManifestSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  category: z.enum(['storefront', 'erp', 'utility']),
  ui: z.array(z.enum(['connections', 'settings', 'app-settings', 'page'])),
  connectionTypes: z.array(z.object({ kind: z.string(), name: z.string() })),
});

export const workspaceAppSchema = z.object({
  appId: z.string(),
  status: z.enum(['installed', 'uninstalled']),
  version: z.number().int().positive(),
  updatedAt: z.string().datetime(),
});

export type AppManifest = z.infer<typeof appManifestSchema>;

export type WorkspaceApp = z.infer<typeof workspaceAppSchema>;
