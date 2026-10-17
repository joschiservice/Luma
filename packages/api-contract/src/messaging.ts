import { z } from 'zod';

import {
  collectionGroupKeyParameter,
  collectionGroupLimitParameter,
  collectionGroupParameter,
  collectionTimeZoneParameter,
  collectionWhereParameter,
} from './collections.js';

const id = z.string().uuid();
const instant = z.string().datetime();
const revision = z.number().int().min(1);
const address = z.string().trim().toLowerCase().email().max(320);
const domain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/);

const messageAddressSchema = z.object({
  address: z.string(),
  name: z.string().nullable(),
});

/** Who a mailbox rule says the matching correspondent is. */
const rulePartySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('supplier'), supplierId: id }).strict(),
  z.object({ kind: z.literal('customer') }).strict(),
  z.object({ kind: z.literal('other') }).strict(),
]);

const mailboxRuleKindSchema = z.enum([
  'sender_domain',
  'sender_address',
  'recipient_address',
  'label',
]);

export const mailboxRuleInputSchema = z
  .discriminatedUnion('kind', [
    z.object({
      id,
      kind: z.literal('sender_domain'),
      value: domain,
      party: rulePartySchema,
    }),
    z.object({
      id,
      kind: z.literal('sender_address'),
      value: address,
      party: rulePartySchema,
    }),
    z.object({
      id,
      kind: z.literal('recipient_address'),
      value: address,
      party: rulePartySchema,
    }),
    z.object({
      id,
      kind: z.literal('label'),
      value: z.string().trim().min(1).max(225),
      party: rulePartySchema,
    }),
  ])
  .refine((rule) => rule.kind !== 'label' || rule.party.kind !== 'supplier', {
    message: 'Label rules cannot name a supplier',
  });

const mailboxRuleSchema = z.object({
  id,
  kind: mailboxRuleKindSchema,
  value: z.string(),
  party: rulePartySchema,
  /** Supplier name for supplier rules; null when the supplier no longer exists. */
  partyLabel: z.string().nullable(),
  /** When older messages for this rule were read; null while waiting for the first read. */
  backfilledAt: instant.nullable(),
  createdBy: z.string(),
  createdAt: instant,
});

const mailboxSettingsSchema = z.object({
  /** How far back the first read of a mailbox or a new rule goes. */
  backfillDays: z.number().int().min(1).max(365),
  /** Hours after an unanswered inbound message until a reply is due. */
  replyHours: z.number().int().min(1).max(720),
  /** Every outgoing reply needs approval, not only consequential ones. */
  approveAll: z.boolean(),
  paused: z.boolean(),
});

export const mailboxSettingsInputSchema = mailboxSettingsSchema
  .extend({ expectedRevision: revision })
  .strict();

const mailboxSyncStateSchema = z.enum([
  /** No rules yet, so nothing is read. */
  'needs_rules',
  'syncing',
  'current',
  'paused',
  /** Reading failed; Luma retries with backoff. */
  'retrying',
  /** Reading cannot continue until someone acts, such as reconnecting. */
  'blocked',
]);

export const mailboxSchema = z.object({
  connectionId: id,
  label: z.string(),
  provider: z.string(),
  address: z.string().nullable(),
  connectionStatus: z.enum([
    'pending',
    'active',
    'degraded',
    'disconnected',
    'revoked',
  ]),
  canSend: z.boolean(),
  state: mailboxSyncStateSchema,
  /** Why reading is blocked or retrying, for people. */
  stateReason: z.string().nullable(),
  lastSyncedAt: instant.nullable(),
  /** Messages are read up to this time. */
  coveredUntil: instant.nullable(),
  settings: mailboxSettingsSchema,
  rules: z.array(mailboxRuleSchema),
  revision,
});

/** Kinds of record a thread can be linked to. */
export const linkedRecordKinds = [
  'order',
  'customer',
  'supplier',
  'purchase_order',
  'case',
] as const;

export const linkedRecordKindSchema = z.enum(linkedRecordKinds);

const recordRefSchema = z.object({
  kind: linkedRecordKindSchema,
  id: z.string().min(1).max(200),
  /** Display reference, such as an order number; null when the record is not readable. */
  label: z.string().nullable(),
});

const linkMethodSchema = z.enum(['rule', 'address', 'reference', 'manual']);

const threadLinkSchema = z.object({
  id,
  record: recordRefSchema,
  method: linkMethodSchema,
  /**
   * `suggested`: the evidence matched several records, or came from a sender address the
   * mailbox provider did not authenticate; never acted on until someone confirms it.
   */
  state: z.enum(['active', 'suggested']),
  evidence: z.object({
    messageId: id.nullable(),
    ruleId: id.nullable(),
    /** Exact text that caused the link, such as a matched address or order number. */
    text: z.string().nullable(),
    span: z
      .object({ start: z.number().int().min(0), end: z.number().int().min(0) })
      .nullable(),
    /** The link came from the address of a sender the mailbox provider did not authenticate. */
    senderUnverified: z.boolean(),
  }),
  createdBy: z.string(),
  createdAt: instant,
});

/** Where a thread stands: open, waiting on someone else, or closed. */
export const threadStatuses = ['open', 'waiting', 'closed'] as const;

const threadStatusSchema = z.enum(threadStatuses);

export const threadSummarySchema = z.object({
  id,
  connectionId: id,
  mailboxLabel: z.string(),
  subject: z.string(),
  /** Latest correspondent outside the mailbox. */
  correspondent: messageAddressSchema.nullable(),
  snippet: z.string(),
  status: threadStatusSchema,
  ownerId: z.string().nullable(),
  replyDueAt: instant.nullable(),
  /** `manual`: set by a person; `automatic`: from the mailbox's reply hours. Null without a deadline. */
  replyDueSource: z.enum(['automatic', 'manual']).nullable(),
  overdue: z.boolean(),
  /** Inbound message newer than the latest reply. */
  awaitingReply: z.boolean(),
  lastMessageAt: instant,
  messageCount: z.number().int().min(0),
  links: z.array(recordRefSchema),
  attachmentCount: z.number().int().min(0),
  /** Document facts waiting for review. */
  factsToReview: z.number().int().min(0),
  revision,
});

const attachmentSchema = z.object({
  filename: z.string(),
  mimeType: z.string(),
  size: z.number().int().min(0),
  /** Set when Luma read the attachment as a document. */
  documentId: id.nullable(),
});

const messageSchema = z.object({
  id,
  threadId: id,
  direction: z.enum(['inbound', 'outbound']),
  from: messageAddressSchema,
  /**
   * Whether the mailbox provider authenticated the From address's domain, for inbound
   * messages; null for messages the mailbox sent. `aligned`: authenticated (DMARC, or a DKIM
   * signature by the mailbox's own domain). `unaligned`: checked and not authenticated, so the
   * From address may be forged. `unknown`: no result, as for imported mail. Only `aligned`
   * identifies the sender.
   */
  senderAuthentication: z.enum(['aligned', 'unaligned', 'unknown']).nullable(),
  to: z.array(messageAddressSchema),
  cc: z.array(messageAddressSchema),
  subject: z.string(),
  /** Null after the text was removed by retention or on request. */
  text: z.string().nullable(),
  truncated: z.boolean(),
  sentAt: instant,
  receivedAt: instant,
  /** Provider identity, so people can find the message in the mailbox. */
  source: z.object({
    provider: z.string(),
    messageId: z.string(),
    rfcMessageId: z.string().nullable(),
  }),
  /** `luma`: sent from Luma and confirmed by a fresh read of the thread. */
  origin: z.enum(['sync', 'luma']),
  attachments: z.array(attachmentSchema),
  retainUntil: instant,
  purgedAt: instant.nullable(),
});

const noteSchema = z.object({
  id,
  authorId: z.string(),
  body: z.string(),
  createdAt: instant,
});

const threadEventSchema = z.object({
  id,
  type: z.enum([
    'received',
    'sent',
    'assigned',
    'deadline_set',
    'status_changed',
    'linked',
    'unlinked',
    'note_added',
    /** An inbound supplier message was recorded on its purchase order; `details.outcome` says how. */
    'handed_off',
    'reply_requested',
    'reply_approved',
    'reply_rejected',
    'reply_withheld',
    /** Delivery of an uncertain send was settled; `details.outcome` and `details.source` say how. */
    'delivery_resolved',
    'text_removed',
    /** Someone confirmed, corrected or rejected a document fact; `details.outcome` says which. */
    'fact_reviewed',
  ]),
  actor: z.object({
    kind: z.enum(['user', 'luma']),
    id: z.string(),
  }),
  /**
   * Stable keys for people-facing text: `ownerId` (assigned; absent when unassigned),
   * `replyDueAt` and `automatic` (deadline_set), `status` and `reason` (status_changed),
   * `record` (a display label, absent when the reader can't read it) for linked, unlinked and
   * handed_off, `outcome` for handed_off and fact_reviewed, `documentId`, `factId` and `kind` for fact_reviewed,
   * `reason` for reply_withheld, and `outboundId`, `outcome` (`delivered` or `not_delivered`) and
   * `source` (`person` or `reply`) for delivery_resolved.
   */
  details: z.record(z.string(), z.string()),
  occurredAt: instant,
});

const factMoneySchema = z.object({
  amount: z.string().regex(/^-?\d{1,14}(\.\d{1,6})?$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

/** The structured content of a document fact. */
export const factValueSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('party'),
      role: z.enum(['supplier', 'customer']),
      name: z.string().trim().min(1).max(200),
      email: z.string().trim().max(320).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('reference'),
      role: z.enum([
        'purchase_order',
        'order',
        'invoice',
        'delivery_note',
        'other',
      ]),
      text: z.string().trim().min(1).max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal('line'),
      sku: z.string().trim().min(1).max(200).nullable(),
      description: z.string().trim().max(500).nullable(),
      quantity: z
        .string()
        .regex(/^\d{1,14}(\.\d{1,6})?$/)
        .nullable(),
      unit: z.string().trim().min(1).max(40).nullable(),
      unitPrice: factMoneySchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('date'),
      role: z.enum(['delivery', 'shipping', 'order', 'due', 'other']),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal('amount'),
      role: z.enum(['total', 'other']),
      money: factMoneySchema,
    })
    .strict(),
]);

/** Where a fact is in its source: a text span (on a page) or spreadsheet cells. */
const factLocatorSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('text'),
      /** 1-based page for paged documents; null for message text and plain files. */
      page: z.number().int().min(1).nullable(),
      start: z.number().int().min(0),
      end: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      kind: z.literal('cells'),
      sheet: z.string().max(200),
      /** 1-based rows and columns, inclusive. */
      row: z.number().int().min(1),
      rowEnd: z.number().int().min(1),
      column: z.number().int().min(1),
      columnEnd: z.number().int().min(1),
    })
    .strict(),
]);

const factMatchSchema = z.object({
  /** `ambiguous` blocks confirmation until someone corrects the fact. */
  state: z.enum(['matched', 'ambiguous', 'unmatched', 'not_applicable']),
  record: recordRefSchema.nullable(),
  candidates: z.array(recordRefSchema).max(10),
});

export const factSchema = z.object({
  id,
  documentId: id,
  value: factValueSchema,
  locator: factLocatorSchema,
  /** The exact source text or cell values the fact cites. */
  quote: z.string(),
  confidence: z.enum(['high', 'low']),
  match: factMatchSchema,
  /**
   * `needs_correction`: low confidence or an ambiguous match; it can only be confirmed with a
   * correction. Confirmed facts are proposals for later work; they never authorize an action.
   */
  status: z.enum(['proposed', 'needs_correction', 'confirmed', 'rejected']),
  origin: z.enum(['model', 'table', 'manual']),
  /** Compared with the previous version of the document. */
  change: z.enum(['new', 'changed', 'unchanged']).nullable(),
  review: z
    .object({
      outcome: z.enum(['confirmed', 'corrected', 'rejected']),
      by: z.string(),
      at: instant,
      /** The value before a correction. */
      original: factValueSchema.nullable(),
    })
    .nullable(),
  createdAt: instant,
});

const documentStateSchema = z.enum([
  'pending',
  'reading',
  'ready',
  /** Reading failed; it can be retried. */
  'failed',
  /** The file type is not read. */
  'unsupported',
  /** The file is damaged, encrypted, or has no readable text. */
  'unreadable',
  /** The same content already arrived; review happens on the original. */
  'duplicate',
]);

const documentSummarySchema = z.object({
  id,
  messageId: id,
  threadId: id,
  filename: z.string(),
  mimeType: z.string(),
  size: z.number().int().min(0),
  sha256: z.string().nullable(),
  version: z.number().int().min(1),
  previousId: id.nullable(),
  duplicateOf: id.nullable(),
  state: documentStateSchema,
  /** Why the document is failed, unreadable or unsupported, for people. */
  stateReason: z.string().nullable(),
  factsToReview: z.number().int().min(0),
  receivedAt: instant,
});

const documentRepresentationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    /** One entry per page; plain files have one page. */
    pages: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('sheets'),
    sheets: z.array(
      z.object({
        name: z.string(),
        rows: z.array(z.array(z.string())),
      }),
    ),
  }),
]);

export const documentDetailSchema = z.object({
  document: documentSummarySchema,
  /** Null after retention removed the content, or before it was read. */
  representation: documentRepresentationSchema.nullable(),
  facts: z.array(factSchema),
  /** Facts of the previous version no longer present in this one. */
  removedFacts: z.array(factSchema),
  extraction: z.object({
    available: z.boolean(),
    reason: z.string().nullable(),
  }),
  canReview: z.boolean(),
});

const citationSchema = z.object({
  record: recordRefSchema,
  /** What the draft states from this record. */
  statement: z.string(),
  observedAt: instant.nullable(),
  /** Older than a day, or the record could not be read; the draft says so. */
  freshness: z.enum(['fresh', 'stale', 'missing']),
});

const outboundStateSchema = z.enum([
  'draft',
  'approval_required',
  'approved',
  'rejected',
  'expired',
  'sending',
  /** Luma cannot tell whether the provider sent it; it only checks by reading. */
  'uncertain',
  'sent',
  'failed',
  /** Policy, write controls or a changed thread stopped it before sending. */
  'withheld',
  'discarded',
]);

/** A person's or the recipient's answer to whether an uncertain send arrived. */
const deliveryOutcomeSchema = z.enum(['delivered', 'not_delivered']);

export const outboundSchema = z.object({
  purchaseOrderId: id.optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string(),
        mimeType: z.string(),
        size: z.number().int().min(0),
      }),
    )
    .optional(),
  id,
  threadId: id,
  connectionId: id,
  to: z.array(messageAddressSchema),
  cc: z.array(messageAddressSchema),
  subject: z.string(),
  text: z.string(),
  citations: z.array(citationSchema),
  /** Why the reply needs approval; empty when it does not. */
  consequential: z.array(
    z.enum(['date', 'quantity', 'money', 'workspace_policy']),
  ),
  state: outboundStateSchema,
  stateReason: z.string().nullable(),
  requestedBy: z.string(),
  decisionId: z.string().nullable(),
  approverId: z.string().nullable(),
  sentMessageId: id.nullable(),
  /** Delivery evidence for a sent message beyond the provider's acceptance. */
  delivery: z.object({
    /**
     * A delivery report from a sender the mail provider did not authenticate. It leaves
     * delivery uncertain; `recipient` and `status` are what the report claims.
     */
    report: z.object({ recipient: z.string(), status: z.string() }).nullable(),
    /**
     * How uncertain delivery was settled: by a person after checking with the recipient, or
     * by the recipient's reply from an authenticated address. `by` is the deciding member.
     */
    resolution: z
      .object({
        outcome: deliveryOutcomeSchema,
        source: z.enum(['person', 'reply']),
        by: z.string().nullable(),
        at: instant,
        /** Internal note from the person who decided; never sent. */
        note: z.string().nullable(),
      })
      .nullable(),
  }),
  canEdit: z.boolean(),
  canRequest: z.boolean(),
  canApprove: z.boolean(),
  canSend: z.boolean(),
  canCheck: z.boolean(),
  /** Whether the reader may mark this uncertain supplier email as delivered or not delivered. */
  canResolveDelivery: z.boolean(),
  revision,
  createdAt: instant,
  updatedAt: instant,
});

export const threadDetailSchema = z.object({
  thread: threadSummarySchema,
  messages: z.array(messageSchema),
  links: z.array(threadLinkSchema),
  notes: z.array(noteSchema),
  events: z.array(threadEventSchema),
  documents: z.array(documentSummarySchema),
  outbound: z.array(outboundSchema),
  permissions: z.object({
    canManage: z.boolean(),
    canSend: z.boolean(),
  }),
});

export const threadViewSchema = z.enum([
  'open',
  'mine',
  'unassigned',
  'overdue',
  'review',
  'closed',
  'all',
]);

/** Orders the thread list accepts. */
const threadSorts = ['activity', 'due'] as const;

export const threadQuerySchema = z.object({
  view: threadViewSchema.default('open'),
  connectionId: id
    .optional()
    .describe(
      'Threads of one mailbox. Kept for older links; prefer a `mailbox` condition.',
    ),
  q: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe('Matches the subject or the correspondent, ignoring case.'),
  where: collectionWhereParameter.optional(),
  group: collectionGroupParameter.optional(),
  groupKey: collectionGroupKeyParameter.optional(),
  groupLimit: collectionGroupLimitParameter,
  timeZone: collectionTimeZoneParameter,
  sort: z
    .enum(threadSorts)
    .default('activity')
    .describe(
      '`activity` orders by the latest message; `due` by the reply deadline, with threads without one last in both directions.',
    ),
  direction: z
    .enum(['asc', 'desc'])
    .optional()
    .describe(
      'Defaults to newest first for `activity` and earliest first for `due`.',
    ),
  cursor: z.string().max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const command = { id };

export const assignInputSchema = z
  .object({
    ...command,
    expectedRevision: revision,
    ownerId: z.string().min(1).max(200).nullable(),
  })
  .strict();

export const deadlineInputSchema = z
  .object({
    ...command,
    expectedRevision: revision,
    replyDueAt: instant.nullable(),
  })
  .strict();

export const statusInputSchema = z
  .object({
    ...command,
    expectedRevision: revision,
    status: threadStatusSchema,
  })
  .strict();

export const noteInputSchema = z
  .object({ ...command, body: z.string().trim().min(1).max(5000) })
  .strict();

export const threadLinkInputSchema = z
  .object({
    ...command,
    kind: linkedRecordKindSchema,
    recordId: z.string().min(1).max(200),
  })
  .strict();

export const commandInputSchema = z.object(command).strict();

export const factInputSchema = z
  .object({
    ...command,
    value: factValueSchema,
    locator: factLocatorSchema,
  })
  .strict();

export const factReviewInputSchema = z
  .object({
    ...command,
    outcome: z.enum(['confirm', 'correct', 'reject']),
    /** Required for `correct`; replaces the value and, optionally, the matched record. */
    correction: z
      .object({
        value: factValueSchema,
        record: z
          .object({
            kind: linkedRecordKindSchema,
            id: z.string().min(1).max(200),
          })
          .nullable(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((input) => (input.outcome === 'correct') === !!input.correction, {
    message: 'A correction is required exactly when correcting',
  });

export const draftInputSchema = z.object(command).strict();

export const outboundInputSchema = z
  .object({
    expectedRevision: revision,
    to: z.array(address).min(1).max(20),
    cc: z.array(address).max(20),
    subject: z.string().trim().min(1).max(500),
    text: z.string().trim().min(1).max(20000),
  })
  .strict();

/**
 * A person's decision about an uncertain supplier email after checking with the supplier. The
 * note stays internal.
 */
export const outboundDeliveryInputSchema = z
  .object({
    ...command,
    expectedRevision: revision,
    outcome: deliveryOutcomeSchema,
    note: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

export const outboundDecisionInputSchema = z
  .object({
    decisionId: z.string().min(1).max(200),
    outcome: z.enum(['approved', 'rejected']),
  })
  .strict();

export type MessageAddress = z.infer<typeof messageAddressSchema>;

export type RuleParty = z.infer<typeof rulePartySchema>;

export type MailboxRuleKind = z.infer<typeof mailboxRuleKindSchema>;

export type MailboxRuleInput = z.infer<typeof mailboxRuleInputSchema>;

export type MailboxRule = z.infer<typeof mailboxRuleSchema>;

export type MailboxSettingsInput = z.infer<typeof mailboxSettingsInputSchema>;

export type MailboxSyncState = z.infer<typeof mailboxSyncStateSchema>;

export type Mailbox = z.infer<typeof mailboxSchema>;

export type LinkedRecordKind = z.infer<typeof linkedRecordKindSchema>;

export type RecordRef = z.infer<typeof recordRefSchema>;

export type LinkMethod = z.infer<typeof linkMethodSchema>;

export type ThreadLink = z.infer<typeof threadLinkSchema>;

export type ThreadStatus = z.infer<typeof threadStatusSchema>;

export type ThreadSummary = z.infer<typeof threadSummarySchema>;

export type Message = z.infer<typeof messageSchema>;

export type ThreadEvent = z.infer<typeof threadEventSchema>;

export type FactMoney = z.infer<typeof factMoneySchema>;

export type FactValue = z.infer<typeof factValueSchema>;

export type FactLocator = z.infer<typeof factLocatorSchema>;

export type Fact = z.infer<typeof factSchema>;

export type DocumentState = z.infer<typeof documentStateSchema>;

export type DocumentSummary = z.infer<typeof documentSummarySchema>;

export type DocumentDetail = z.infer<typeof documentDetailSchema>;

export type Citation = z.infer<typeof citationSchema>;

export type OutboundState = z.infer<typeof outboundStateSchema>;

export type Outbound = z.infer<typeof outboundSchema>;

export type ThreadDetail = z.infer<typeof threadDetailSchema>;

export type ThreadView = z.infer<typeof threadViewSchema>;

export type AssignInput = z.infer<typeof assignInputSchema>;

export type DeadlineInput = z.infer<typeof deadlineInputSchema>;

export type StatusInput = z.infer<typeof statusInputSchema>;

export type NoteInput = z.infer<typeof noteInputSchema>;

export type ThreadLinkInput = z.infer<typeof threadLinkInputSchema>;

export type FactInput = z.infer<typeof factInputSchema>;

export type FactReviewInput = z.infer<typeof factReviewInputSchema>;

export type OutboundInput = z.infer<typeof outboundInputSchema>;

export type OutboundDecisionInput = z.infer<typeof outboundDecisionInputSchema>;

export type OutboundDeliveryInput = z.infer<typeof outboundDeliveryInputSchema>;
