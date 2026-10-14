import { z } from 'zod';

import {
  adaptiveViewQueryInputSchema,
  adaptiveViewQuerySchema,
} from './adaptive-view-query.js';

const field = z.string().min(1).max(120);

const adaptiveViewSharingSchema = z
  .object({
    scope: z.enum(['private', 'workspace', 'roles']),
    roleIds: z.array(z.string().min(1).max(100)).max(50).default([]),
  })
  .strict()
  .superRefine((sharing, context) => {
    if ((sharing.scope === 'roles') !== sharing.roleIds.length > 0)
      context.addIssue({
        code: 'custom',
        message:
          'Role sharing requires roles; other scopes cannot contain roles',
        path: ['roleIds'],
      });
  });

/** A reviewed view to save. The query may be format 1 or 2; it is stored in format 2. */
export const adaptiveViewInputSchema = z
  .object({
    commandId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).default(''),
    sharing: adaptiveViewSharingSchema,
    query: adaptiveViewQueryInputSchema,
    reviewed: z.literal(true),
  })
  .strict();

/** A saved view. Its query is always in format 2, upgraded on read when stored in format 1. */
export const adaptiveViewSchema = adaptiveViewInputSchema
  .omit({ reviewed: true, commandId: true })
  .extend({
    query: adaptiveViewQuerySchema,
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    ownerId: z.string().uuid(),
    revision: z.number().int().positive(),
    archived: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    canEdit: z.boolean(),
  });

export const adaptiveViewRevisionSchema = adaptiveViewSchema
  .omit({ canEdit: true })
  .extend({ changedBy: z.string().uuid() });

export const builtInAdaptiveViewSchema = z.object({
  id: z.enum(['stuck-orders', 'inventory-discrepancies', 'supplier-decisions']),
  name: z.object({ en: z.string(), de: z.string() }),
  query: adaptiveViewQuerySchema,
});

export const adaptiveViewPreviewSchema = z.object({
  items: z.array(z.record(z.string(), z.unknown())).max(100),
  nextCursor: z.string().nullable(),
  asOf: z.string().datetime({ offset: true }),
  totalCount: z.number().int().nonnegative().nullable(),
  warnings: z.array(z.string().max(1000)).max(50),
  availableColumns: z.array(field),
  groups: z
    .array(
      z.object({ key: z.unknown(), count: z.number().int().nonnegative() }),
    )
    .max(100)
    .default([]),
  chartSeries: z
    .array(
      z.object({
        id: field,
        points: z
          .array(
            z.object({
              key: z.unknown(),
              value: z.number().nullable(),
              count: z.number().int().nonnegative(),
            }),
          )
          .max(100),
        truncated: z.boolean(),
        complete: z.boolean(),
      }),
    )
    .max(4)
    .default([]),
  aggregates: z
    .array(
      z.object({
        metricId: field,
        value: z.number().nullable(),
        complete: z.boolean(),
      }),
    )
    .default([]),
});

export const adaptiveViewDraftSchema = z.object({
  status: z.enum([
    'ready',
    'needs_clarification',
    'unsupported',
    'unavailable',
  ]),
  query: adaptiveViewQuerySchema.nullable(),
  explanation: z.string().max(2000),
  warnings: z.array(z.string().max(1000)).max(20),
  preview: adaptiveViewPreviewSchema.nullable(),
});

export type AdaptiveViewInput = z.infer<typeof adaptiveViewInputSchema>;

export type AdaptiveView = z.infer<typeof adaptiveViewSchema>;

export type AdaptiveViewPreview = z.infer<typeof adaptiveViewPreviewSchema>;
