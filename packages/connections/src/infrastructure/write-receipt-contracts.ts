import { z } from 'zod';

/** Validates the provider records a write acceptance names: identities only, never payloads. */
export const acceptedRecordsSchema = z
  .array(
    z
      .object({
        resource: z.string().min(1).max(100),
        externalId: z.string().min(1).max(500),
      })
      .strict(),
  )
  .max(20);
