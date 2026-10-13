import { gmailId, mailboxFilter } from '@luma/connector-gmail';
import { z } from 'zod';

const timestamp = z.string().datetime({ offset: true });

const externalId = z
  .object({
    externalId: z.string().min(1).max(256),
    scopeKey: z.string().max(256),
  })
  .strict();

const gmailRef = z
  .object({ externalId: gmailId, scopeKey: z.literal('') })
  .strict();

const page = {
  cursor: z.string().min(1).max(8192).optional(),
  limit: z.number().int().min(1).max(100),
};

/** A message ID as written in headers, without angle brackets. */
const rfcId = z.string().regex(/^[\x21-\x3b\x3d\x3f-\x7e]{1,900}$/);

/** An address Luma may write into a header; display names cannot contain line breaks. */
const outboundAddress = z
  .object({
    address: z
      .string()
      .max(320)
      .regex(
        /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/,
      ),
    name: z
      .string()
      .max(200)
      .regex(/^[^\r\n]*$/)
      .nullable(),
  })
  .strict();

export const inputs = {
  'messages.read': z
    .object({ ...page, filter: mailboxFilter, receivedSince: timestamp })
    .strict(),
  'message-threads.read': z
    .object({
      ...page,
      thread: z
        .object({
          externalId: z.union([
            gmailId,
            z.string().regex(/^outbound:[A-Za-z0-9-]{1,64}$/),
          ]),
          scopeKey: z.literal(''),
        })
        .strict(),
    })
    .strict(),
  'message-attachments.read': z
    .object({
      message: gmailRef,
      attachment: z
        .object({
          externalId: z.string().regex(/^(?:root|[0-9]+(?:\.[0-9]+)*)$/),
          scopeKey: z.string().max(256),
        })
        .strict(),
      maxBytes: z
        .number()
        .int()
        .min(1)
        .max(50 * 1024 * 1024),
    })
    .strict(),
  'messages.send': z
    .object({
      outboundId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
      thread: gmailRef.nullable(),
      inReplyTo: rfcId.nullable(),
      references: z.array(rfcId).max(100),
      to: z.array(outboundAddress).max(100),
      cc: z.array(outboundAddress).max(100),
      subject: z
        .string()
        .max(998)
        .regex(/^[^\r\n]*$/),
      text: z.string().max(500_000),
      attachments: z
        .array(
          z
            .object({
              filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._ -]{0,199}$/),
              mimeType: z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/),
              base64: z.string().max(14_000_000),
            })
            .strict(),
        )
        .max(10)
        .optional(),
    })
    .strict()
    .refine((value) => value.to.length + value.cc.length > 0),
};

const address = z
  .object({ address: z.string().max(320), name: z.string().nullable() })
  .strict();

const message = z
  .object({
    id: z.string().regex(/^gmail:[^:]+:message:[A-Za-z0-9_-]+$/),
    source: externalId.extend({
      tenantId: z.string().min(1),
      connectionId: z.string().min(1),
      provider: z.literal('gmail'),
      resource: z.literal('message'),
    }),
    kind: z.literal('snapshot'),
    observedAt: timestamp,
    sourceUpdatedAt: z.null(),
    sourceRevision: z.string().nullable(),
    adapterVersion: z.string(),
    schemaVersion: z.literal(1),
    data: z
      .object({
        thread: externalId,
        rfcMessageId: z.string().nullable(),
        inReplyTo: z.string().nullable(),
        references: z.array(z.string()),
        direction: z.enum(['inbound', 'outbound']),
        from: address,
        to: z.array(address),
        cc: z.array(address),
        replyTo: z.array(address),
        deliveryFailure: z
          .object({
            originalMessageId: rfcId,
            recipient: z.string(),
            status: z.string().regex(/^5\.\d{1,3}\.\d{1,3}$/),
          })
          .strict()
          .optional(),
        subject: z.string(),
        text: z.string().max(100_000),
        truncated: z.boolean(),
        sentAt: timestamp,
        receivedAt: timestamp,
        labels: z.array(z.string()),
        attachments: z.array(
          z
            .object({
              attachment: externalId,
              filename: z.string().min(1),
              mimeType: z.string().min(1),
              size: z.number().int().nonnegative(),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();

const messagePage = z
  .object({
    items: z.array(message),
    nextCursor: z.string().nullable(),
    completeness: z.literal('complete'),
  })
  .strict();

const receipt = z
  .object({
    status: z.literal('accepted'),
    evidenceRefs: z.array(z.string().uuid()).length(1),
    providerRequestId: z.null(),
  })
  .strict();

export const outputs = {
  'messages.read': messagePage,
  'message-threads.read': messagePage,
  'message-attachments.read': z
    .object({
      filename: z.string().min(1),
      mimeType: z.string().min(1),
      size: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      base64: z.string(),
    })
    .strict(),
  'messages.send': receipt,
};
