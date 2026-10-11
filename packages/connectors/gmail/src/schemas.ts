import { z } from 'zod';

/** Gmail message, thread, label and attachment IDs: opaque URL-safe tokens. */
export const gmailId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

const header = z.object({ name: z.string(), value: z.string() });

export interface MessagePart {
  partId?: string | undefined;
  mimeType?: string | undefined;
  filename?: string | undefined;
  headers?: { name: string; value: string }[] | undefined;
  body?:
    | {
        attachmentId?: string | undefined;
        size?: number | undefined;
        data?: string | undefined;
      }
    | undefined;
  parts?: MessagePart[] | undefined;
}

const messagePart: z.ZodType<MessagePart> = z.lazy(() =>
  z.object({
    partId: z.string().max(256).optional(),
    mimeType: z.string().max(256).optional(),
    filename: z.string().max(1024).optional(),
    headers: z.array(header).max(1000).optional(),
    body: z
      .object({
        attachmentId: z.string().max(4096).optional(),
        size: z.number().int().nonnegative().optional(),
        data: z.string().optional(),
      })
      .optional(),
    parts: z.array(messagePart).max(500).optional(),
  }),
);

export const message = z.object({
  id: gmailId,
  threadId: gmailId,
  labelIds: z.array(z.string().max(256)).max(500).optional(),
  historyId: z.string().max(64).optional(),
  /** Milliseconds since the epoch, as a decimal string. */
  internalDate: z.string().regex(/^\d{1,16}$/),
  payload: messagePart.optional(),
  sizeEstimate: z.number().int().nonnegative().optional(),
});

export type GmailMessage = z.infer<typeof message>;

export const messageList = z.object({
  messages: z
    .array(z.object({ id: gmailId, threadId: gmailId }))
    .max(500)
    .optional(),
  nextPageToken: z.string().min(1).max(4096).optional(),
  resultSizeEstimate: z.number().int().nonnegative().optional(),
});

export const thread = z.object({
  id: gmailId,
  historyId: z.string().max(64).optional(),
  messages: z.array(message).max(1000).optional(),
});

export const profile = z.object({
  emailAddress: z.string().min(3).max(320),
  historyId: z.string().max(64).optional(),
});

export const labels = z.object({
  labels: z
    .array(
      z.object({
        id: z.string().min(1).max(256),
        name: z.string().max(1024),
        type: z.string().optional(),
      }),
    )
    .max(10000)
    .optional(),
});

export const attachment = z.object({
  size: z.number().int().nonnegative().optional(),
  data: z.string(),
});

export const sent = z.object({
  id: gmailId,
  threadId: gmailId,
  labelIds: z.array(z.string()).optional(),
});

export const watch = z.object({
  historyId: z.string().max(64),
  /** Milliseconds since the epoch, as a decimal string. */
  expiration: z.string().regex(/^\d{1,16}$/),
});

export const errorBody = z.object({
  error: z.object({
    code: z.number().optional(),
    status: z.string().optional(),
    errors: z
      .array(z.object({ reason: z.string().optional() }).passthrough())
      .optional(),
    details: z
      .array(z.object({ reason: z.string().optional() }).passthrough())
      .optional(),
  }),
});
