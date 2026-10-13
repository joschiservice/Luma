import { z } from 'zod';

export const adaptiveActionRequestSchema = z
  .object({
    commandId: z.string().uuid(),
    recordIds: z
      .array(z.string().uuid())
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();

export const adaptiveActionCatalogSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      label: z.object({ en: z.string(), de: z.string() }),
      available: z.boolean(),
      reason: z.string().nullable(),
      requiredPermissions: z.array(z.string()),
    }),
  ),
});

export const adaptiveActionPreviewSchema = z.object({
  reviewDigest: z.string(),
  items: z.array(
    z.object({
      recordId: z.string().uuid(),
      available: z.boolean(),
      reason: z.string().nullable(),
      changes: z.array(
        z.object({
          label: z.string(),
          before: z.string().nullable(),
          after: z.string().nullable(),
        }),
      ),
      scope: z.string(),
      approval: z.string(),
      verification: z.string(),
    }),
  ),
});

export const adaptiveActionResultsSchema = z.object({
  items: z.array(
    z.object({
      recordId: z.string().uuid(),
      state: z.enum([
        'proposed',
        'approval_required',
        'verified',
        'uncertain',
        'failed',
        'unavailable',
      ]),
      reason: z.string().nullable(),
      proposalId: z.string().nullable(),
      destination: z.string().nullable(),
    }),
  ),
});

export const adaptiveActionDefinitionsSchema = z.object({
  items: z.array(
    z.object({
      target: z.object({
        kind: z.enum(['capability', 'workflow']),
        id: z.string(),
        version: z.string().optional(),
      }),
      inputs: z.array(
        z.object({
          key: z.string(),
          type: z.enum(['string', 'number', 'boolean']),
        }),
      ),
      requiredPermissions: z.array(z.string()),
      available: z.boolean(),
      reason: z.string().nullable(),
    }),
  ),
});
