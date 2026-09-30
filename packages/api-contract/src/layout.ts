import { z } from 'zod';

/** Modules a person can place on their workspace Home. */
export const homeModuleIds = [
  'attention',
  'handling',
  'connections',
  'activity',
  'outcomes',
  'operational-metrics',
  'order-metrics',
  'catalog',
  'fulfillment',
] as const;

export const homeModuleSchema = z
  .object({
    id: z.enum(homeModuleIds),
    size: z.enum(['half', 'full']),
  })
  .strict();

/** A workspace page pinned to the sidebar, addressed relative to the workspace root. */
export const pinnedPageSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(400)
      .regex(/^(?!\/)(?!.*\.\.)[\w\-/.?=&%]+$/),
    label: z.string().trim().min(1).max(120),
  })
  .strict();

const homeModulesSchema = z
  .array(homeModuleSchema)
  .max(homeModuleIds.length)
  .refine(
    (modules) =>
      new Set(modules.map((module) => module.id)).size === modules.length,
    'Each module can appear once.',
  );

const pinnedPagesSchema = z
  .array(pinnedPageSchema)
  .max(12)
  .refine(
    (pages) => new Set(pages.map((page) => page.path)).size === pages.length,
    'Each page can be pinned once.',
  );

export const workspaceLayoutSchema = z.object({
  /** Null uses the default Home for the workspace. */
  home: homeModulesSchema.nullable(),
  pinned: pinnedPagesSchema,
  revision: z.number().int().nonnegative(),
});

export const saveWorkspaceLayoutSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    home: homeModulesSchema.nullable(),
    pinned: pinnedPagesSchema,
  })
  .strict();

export type HomeModuleId = (typeof homeModuleIds)[number];

export type HomeModule = z.infer<typeof homeModuleSchema>;

export type PinnedPage = z.infer<typeof pinnedPageSchema>;

export type WorkspaceLayout = z.infer<typeof workspaceLayoutSchema>;
