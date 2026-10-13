import { z } from 'zod';

const scalar = z.union([
  z.string().max(2000),
  z.number().finite(),
  z.boolean(),
]);

const adaptivePackageConfigSchema = z
  .object({
    parameters: z.record(z.string().min(1).max(100), scalar),
    sharing: z
      .object({
        scope: z.enum(['workspace', 'roles']),
        roleIds: z.array(z.string().min(1).max(100)).max(50),
      })
      .strict(),
  })
  .strict();

export const adaptivePackageSummarySchema = z.object({
  retainedConfig: adaptivePackageConfigSchema.nullable(),
  id: z.string(),
  version: z.string(),
  name: z.object({ en: z.string(), de: z.string() }),
  description: z.object({ en: z.string(), de: z.string() }),
  permissions: z.array(z.string()),
  requirements: z.array(z.string()),
  parameters: z.array(
    z.object({
      key: z.string(),
      type: z.enum(['string', 'number', 'boolean']),
      required: z.boolean(),
      label: z.object({ en: z.string(), de: z.string() }),
      default: scalar.nullable(),
    }),
  ),
  installed: z
    .object({
      version: z.string(),
      revision: z.number().int(),
      config: adaptivePackageConfigSchema,
      resources: z.array(
        z.object({
          kind: z.enum(['field', 'view', 'workflow']),
          key: z.string(),
          id: z.string(),
        }),
      ),
    })
    .nullable(),
});

export const adaptivePackageReviewSchema = z.object({
  package: adaptivePackageSummarySchema,
  reviewDigest: z.string(),
  canInstall: z.boolean(),
  missing: z.array(z.string()),
  additions: z.array(
    z.object({
      kind: z.enum(['field', 'view', 'workflow']),
      key: z.string(),
      label: z.string(),
    }),
  ),
  workflowsActivate: z.literal(false),
  permissionsGranted: z.array(z.string()).max(0),
});

export const adaptivePackageRequestSchema = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    config: adaptivePackageConfigSchema,
  })
  .strict();

export type AdaptivePackageConfig = z.infer<typeof adaptivePackageConfigSchema>;
