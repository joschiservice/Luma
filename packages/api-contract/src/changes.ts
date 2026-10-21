import { z } from 'zod';

/** Kinds of record the change feed reports, named like the fields that identify them. */
const changeRecordTypes = [
  'order',
  'fulfillment',
  'return',
  'inventory',
  'product',
  'customer',
  'returnCase',
  'issue',
] as const;

const changeRecordTypeSchema = z.enum(changeRecordTypes);

export const changeQuerySchema = z
  .object({
    after: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'The `cursor` of the previous page. Without it, the response holds no changes and returns the current position.',
      ),
    types: z
      .string()
      .max(200)
      .transform((text) => text.split(','))
      .pipe(
        z.array(changeRecordTypeSchema).min(1).max(changeRecordTypes.length),
      )
      .optional()
      .describe(
        `Comma-separated record types, such as \`order,customer\`. Defaults to every type you can read. Types: ${changeRecordTypes.map((type) => `\`${type}\``).join(', ')}.`,
      ),
    limit: z.coerce.number().int().min(1).max(1000).default(500),
  })
  .strict();

const changeSchema = z.object({
  type: changeRecordTypeSchema,
  id: z.string().uuid(),
  /** `deleted` once the record no longer exists; `upserted` for every other change. */
  operation: z.enum(['upserted', 'deleted']),
  recordedAt: z.string().datetime({ offset: true }),
});

export const changePageSchema = z.object({
  items: z.array(changeSchema),
  /** Pass as `after` to continue; equal to `after` when nothing changed. */
  cursor: z.string(),
  /** More changes are ready now; request the next page without waiting. */
  hasMore: z.boolean(),
});
