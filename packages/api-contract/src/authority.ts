import { z } from 'zod';

export const authorityGroupSchema = z.enum([
  'order_lines',
  'order_lifecycle',
  'order_fulfillment',
  'order_tracking',
  'inventory_stock',
  'inventory_selling',
]);

export const factAuthoritySchema = z.object({
  group: authorityGroupSchema,
  state: z.enum(['resolved', 'unknown', 'conflicting']),
  basis: z.enum(['default', 'override']),
  connectionId: z.string().uuid().nullable(),
  overrideConnectionId: z.string().uuid().nullable(),
  candidateIds: z.array(z.string().uuid()),
  eligibleIds: z.array(z.string().uuid()),
});

export const authoritySnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  groups: z.array(factAuthoritySchema),
  connections: z.array(
    z.object({
      id: z.string().uuid(),
      label: z.string(),
      category: z.enum(['storefront', 'erp']).nullable(),
      available: z.boolean(),
      capabilities: z.array(z.string()),
    }),
  ),
});

export const authorityChangeSchema = z
  .object({
    commandId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    group: authorityGroupSchema,
    connectionId: z.string().uuid().nullable(),
  })
  .strict();

export const authorityEventSchema = authorityChangeSchema.extend({
  actorId: z.string(),
  previousConnectionId: z.string().uuid().nullable(),
  occurredAt: z.string().datetime(),
});

export type AuthorityGroup = z.infer<typeof authorityGroupSchema>;

export type FactAuthority = z.infer<typeof factAuthoritySchema>;

export type AuthoritySnapshot = z.infer<typeof authoritySnapshotSchema>;

export type AuthorityChange = z.infer<typeof authorityChangeSchema>;

export type AuthorityEvent = z.infer<typeof authorityEventSchema>;
