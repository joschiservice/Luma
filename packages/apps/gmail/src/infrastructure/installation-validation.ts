import { z } from 'zod';

/** Capabilities a Gmail connection can hold. */
export const gmailCapabilities = [
  'messages.read',
  'message-threads.read',
  'message-attachments.read',
  'messages.send',
] as const;

/** Read capabilities granted together by Gmail's read-only scope. */
export const gmailReads = [
  'messages.read',
  'message-threads.read',
  'message-attachments.read',
] as const;

const header = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/);

export const emailAddress = z
  .string()
  .max(320)
  .regex(
    /^[a-z0-9._%+'-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/,
  );

export const installationTarget = z
  .object({ kind: z.literal('gmail'), emailAddress })
  .strict();

export const installationCredentials = z.object({ token: header }).strict();

export const storedCredentials = installationCredentials.extend({
  gmail: z
    .object({
      /** `<environment>:<client ID>` of the OAuth app that issued the tokens. */
      app: z.string().min(1),
      refreshToken: header,
      expiresAt: z.string().datetime(),
      scopes: z.array(z.string().max(512)).max(50),
      emailAddress,
    })
    .strict()
    .optional(),
});

export type StoredCredentials = z.infer<typeof storedCredentials>;

/** Validates a token-based installation, used by simulators and deployments without OAuth. */
export const installationInput = z
  .object({
    label: z.string().trim().min(1).max(120),
    target: installationTarget,
    permissions: z
      .array(z.enum(gmailCapabilities))
      .min(1)
      .max(4)
      .refine((v) => new Set(v).size === v.length),
    credentials: installationCredentials,
  })
  .strict();
