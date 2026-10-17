import { z } from 'zod';

import { collectionGroupSchema } from '../collections.js';
import { endpoint, organizationParamsSchema, requires } from '../common.js';
import {
  assignInputSchema,
  commandInputSchema,
  deadlineInputSchema,
  documentDetailSchema,
  draftInputSchema,
  factInputSchema,
  factReviewInputSchema,
  factSchema,
  linkedRecordKindSchema,
  mailboxRuleInputSchema,
  mailboxSchema,
  mailboxSettingsInputSchema,
  noteInputSchema,
  outboundDecisionInputSchema,
  outboundDeliveryInputSchema,
  outboundInputSchema,
  outboundSchema,
  statusInputSchema,
  threadDetailSchema,
  threadLinkInputSchema,
  threadQuerySchema,
  threadSummarySchema,
} from '../messaging.js';

const path = '/v1/organizations/{organizationId}/messaging';
const mailboxParams = organizationParamsSchema.extend({
  connectionId: z.string().uuid(),
});
const ruleParams = mailboxParams.extend({ ruleId: z.string().uuid() });
const threadParams = organizationParamsSchema.extend({
  threadId: z.string().uuid(),
});
const linkParams = threadParams.extend({ linkId: z.string().uuid() });
const messageParams = threadParams.extend({ messageId: z.string().uuid() });
const documentParams = organizationParamsSchema.extend({
  documentId: z.string().uuid(),
});
const factParams = organizationParamsSchema.extend({
  factId: z.string().uuid(),
});
const outboundParams = organizationParamsSchema.extend({
  outboundId: z.string().uuid(),
});
const recordParams = organizationParamsSchema.extend({
  kind: linkedRecordKindSchema,
  recordId: z.string().min(1).max(200),
});

const errors = [401, 403, 404, 409, 503] as const;
const retry = 'Retry with the same ID and body after an uncertain response.';

export const messagingContract = {
  mailboxes: endpoint
    .route({
      method: 'GET',
      path: `${path}/mailboxes`,
      summary: 'List connected mailboxes',
      description:
        'Returns each connected mailbox with its reading state and the rules that decide which messages Luma reads. Luma reads only messages that match a rule.',
    })
    .meta({ access: requires('messages.read'), errors })
    .input(z.object({ params: organizationParamsSchema }))
    .output(
      z.object({ items: z.array(mailboxSchema), canManage: z.boolean() }),
    ),
  updateMailbox: endpoint
    .route({
      method: 'PUT',
      path: `${path}/mailboxes/{connectionId}/settings`,
      summary: 'Change mailbox settings',
      description:
        'Requires `messages.manage`. Fails with 409 when `expectedRevision` is not current.',
    })
    .meta({ access: requires('messages.manage'), errors })
    .input(
      z.object({ params: mailboxParams, body: mailboxSettingsInputSchema }),
    )
    .output(mailboxSchema),
  addRule: endpoint
    .route({
      method: 'POST',
      path: `${path}/mailboxes/{connectionId}/rules`,
      summary: 'Add a mailbox rule',
      description: `Requires \`messages.manage\`. Luma then reads matching messages from the mailbox's backfill window. ${retry}`,
    })
    .meta({ access: requires('messages.manage'), errors })
    .input(z.object({ params: mailboxParams, body: mailboxRuleInputSchema }))
    .output(mailboxSchema),
  removeRule: endpoint
    .route({
      method: 'POST',
      path: `${path}/mailboxes/{connectionId}/rules/{ruleId}/remove`,
      summary: 'Remove a mailbox rule',
      description:
        'Requires `messages.manage`. Luma stops reading new matching messages; threads already read stay.',
    })
    .meta({ access: requires('messages.manage'), errors })
    .input(z.object({ params: ruleParams, body: commandInputSchema }))
    .output(mailboxSchema),
  syncMailbox: endpoint
    .route({
      method: 'POST',
      path: `${path}/mailboxes/{connectionId}/sync`,
      summary: 'Read a mailbox now',
      description:
        'Requires `messages.manage`. Schedules a read within seconds; the response does not wait for it.',
    })
    .meta({ access: requires('messages.manage'), errors })
    .input(z.object({ params: mailboxParams }))
    .output(mailboxSchema),
  threads: endpoint
    .route({
      method: 'GET',
      path: `${path}/threads`,
      summary: 'List message threads',
      description:
        'Lists threads read from connected mailboxes, newest activity first unless `sort` says otherwise. `overdue` lists threads whose reply deadline passed; `review` lists threads with document facts to review. Conditions use structured thread properties only, never message text. View counts follow the search and mailbox but not the conditions.',
    })
    .meta({ access: requires('messages.read'), errors })
    .input(
      z.object({ params: organizationParamsSchema, query: threadQuerySchema }),
    )
    .output(
      z.object({
        items: z.array(threadSummarySchema),
        nextCursor: z.string().nullable(),
        counts: z.object({
          open: z.number().int(),
          mine: z.number().int(),
          unassigned: z.number().int(),
          overdue: z.number().int(),
          review: z.number().int(),
        }),
        groups: z
          .array(collectionGroupSchema)
          .optional()
          .describe(
            'With `group`: each group in display order with its exact count and first rows, whose threads are in `items`. With `groupKey`: the one group, with this page of its rows.',
          ),
        groupsTruncated: z
          .boolean()
          .optional()
          .describe(
            'More than 50 groups match; narrow the conditions to see the rest.',
          ),
      }),
    ),
  thread: endpoint
    .route({
      method: 'GET',
      path: `${path}/threads/{threadId}`,
      summary: 'Read a message thread',
      description:
        'Returns messages with their source identity, linked records, internal notes, the thread timeline, documents and replies.',
    })
    .meta({ access: requires('messages.read'), errors })
    .input(z.object({ params: threadParams }))
    .output(threadDetailSchema),
  recordThreads: endpoint
    .route({
      method: 'GET',
      path: `${path}/records/{kind}/{recordId}/threads`,
      summary: 'List threads linked to a record',
      description:
        'Requires `messages.read` and permission to read the record. Suggested links are not included.',
    })
    .meta({ access: requires('messages.read'), errors })
    .input(z.object({ params: recordParams }))
    .output(z.object({ items: z.array(threadSummarySchema) })),
  assign: endpoint
    .route({
      method: 'POST',
      path: `${path}/threads/{threadId}/assignment`,
      summary: 'Assign a thread',
      description: `Requires \`messages.manage\`. The owner must be a workspace member who can read messages. ${retry}`,
    })
    .meta({ access: requires('messages.manage'), errors })
    .input(z.object({ params: threadParams, body: assignInputSchema }))
    .output(threadSummarySchema),
  setDeadline: endpoint
    .route({
      method: 'POST',
      path: `${path}/threads/{threadId}/deadline`,
      summary: 'Set a reply deadline',
      description: `Requires \`messages.manage\`. Null returns to the automatic deadline. ${retry}`,
    })
    .meta({ access: requires('messages.manage'), errors })
    .input(z.object({ params: threadParams, body: deadlineInputSchema }))
    .output(threadSummarySchema),
  setStatus: endpoint
    .route({
      method: 'POST',
      path: `${path}/threads/{threadId}/status`,
      summary: 'Change thread status',
      description: `Requires \`messages.manage\`. A new inbound message reopens a closed thread. ${retry}`,
    })
    .meta({ access: requires('messages.manage'), errors })
    .input(z.object({ params: threadParams, body: statusInputSchema }))
    .output(threadSummarySchema),
  addNote: endpoint
    .route({
      method: 'POST',
      path: `${path}/threads/{threadId}/notes`,
      summary: 'Add an internal note',
      description: `Requires \`messages.manage\`. Notes stay in Luma and are never sent. ${retry}`,
    })
    .meta({ access: requires('messages.manage'), errors })
    .input(z.object({ params: threadParams, body: noteInputSchema }))
    .output(threadDetailSchema),
  link: endpoint
    .route({
      method: 'POST',
      path: `${path}/threads/{threadId}/links`,
      summary: 'Link a thread to a record',
      description: `Requires \`messages.manage\` and permission to read the record. Confirms a suggested link to the same record. ${retry}`,
    })
    .meta({ access: requires('messages.manage'), errors })
    .input(z.object({ params: threadParams, body: threadLinkInputSchema }))
    .output(threadDetailSchema),
  unlink: endpoint
    .route({
      method: 'POST',
      path: `${path}/threads/{threadId}/links/{linkId}/remove`,
      summary: 'Remove a record link',
      description: `Requires \`messages.manage\`. Luma does not add the same automatic link again. ${retry}`,
    })
    .meta({ access: requires('messages.manage'), errors })
    .input(z.object({ params: linkParams, body: commandInputSchema }))
    .output(threadDetailSchema),
  removeMessageText: endpoint
    .route({
      method: 'POST',
      path: `${path}/threads/{threadId}/messages/{messageId}/remove-text`,
      summary: 'Remove a message text',
      description:
        'Requires `messages.manage`. Removes the text and attachment content; metadata, links and reviewed facts remain.',
    })
    .meta({ access: requires('messages.manage'), errors })
    .input(z.object({ params: messageParams, body: commandInputSchema }))
    .output(threadDetailSchema),
  document: endpoint
    .route({
      method: 'GET',
      path: `${path}/documents/{documentId}`,
      summary: 'Read a document and its facts',
      description:
        'Returns the document content beside the facts proposed from it. Each fact cites its page, text span or cells.',
    })
    .meta({ access: requires('messages.read'), errors })
    .input(z.object({ params: documentParams }))
    .output(documentDetailSchema),
  readDocument: endpoint
    .route({
      method: 'POST',
      path: `${path}/documents/{documentId}/read`,
      summary: 'Read a document again',
      description:
        'Requires `messages.manage`. Retries a failed read; reviewed facts are kept.',
    })
    .meta({ access: requires('messages.manage'), errors })
    .input(z.object({ params: documentParams, body: commandInputSchema }))
    .output(documentDetailSchema),
  addFact: endpoint
    .route({
      method: 'POST',
      path: `${path}/documents/{documentId}/facts`,
      summary: 'Add a fact by hand',
      description: `Requires \`messages.manage\`. The locator must point to text or cells in the document. ${retry}`,
    })
    .meta({ access: requires('messages.manage'), errors })
    .input(z.object({ params: documentParams, body: factInputSchema }))
    .output(documentDetailSchema),
  reviewFact: endpoint
    .route({
      method: 'POST',
      path: `${path}/facts/{factId}/review`,
      summary: 'Confirm, correct or reject a fact',
      description: `Requires \`messages.manage\`. Facts that need correction cannot be confirmed unchanged. ${retry}`,
    })
    .meta({ access: requires('messages.manage'), errors })
    .input(z.object({ params: factParams, body: factReviewInputSchema }))
    .output(factSchema),
  draft: endpoint
    .route({
      method: 'POST',
      path: `${path}/threads/{threadId}/drafts`,
      summary: 'Draft a reply',
      description: `Requires \`messages.send\`. Builds the draft from the current state of the linked records and cites each one; missing or stale evidence is stated in the draft. ${retry}`,
    })
    .meta({ access: requires('messages.send'), errors })
    .input(z.object({ params: threadParams, body: draftInputSchema }))
    .output(outboundSchema),
  updateOutbound: endpoint
    .route({
      method: 'PUT',
      path: `${path}/outbound/{outboundId}`,
      summary: 'Edit a draft reply',
      description:
        'Requires `messages.send`. Only drafts can change; fails with 409 when `expectedRevision` is not current.',
    })
    .meta({ access: requires('messages.send'), errors })
    .input(z.object({ params: outboundParams, body: outboundInputSchema }))
    .output(outboundSchema),
  requestOutbound: endpoint
    .route({
      method: 'POST',
      path: `${path}/outbound/{outboundId}/request`,
      summary: 'Send a reply or request approval',
      description:
        'Requires `messages.send`. Replies that confirm a date or quantity, mention money, or fall under the workspace rule need approval from someone else; others are sent at once. Sending is confirmed by a fresh read of the thread.',
    })
    .meta({ access: requires('messages.send'), errors })
    .input(z.object({ params: outboundParams, body: commandInputSchema }))
    .output(outboundSchema),
  decideOutbound: endpoint
    .route({
      method: 'POST',
      path: `${path}/outbound/{outboundId}/decision`,
      summary: 'Approve or reject a reply',
      description:
        'Requires `decisions.respond` and the mailbox app’s send permission. The requester cannot approve their own reply.',
    })
    .meta({ access: requires('decisions.respond'), errors })
    .input(
      z.object({ params: outboundParams, body: outboundDecisionInputSchema }),
    )
    .output(outboundSchema),
  sendOutbound: endpoint
    .route({
      method: 'POST',
      path: `${path}/outbound/{outboundId}/send`,
      summary: 'Send an approved reply',
      description:
        'Requires `messages.send`; only the requester can send. Sends at most once; repeating returns the recorded result.',
    })
    .meta({ access: requires('messages.send'), errors })
    .input(z.object({ params: outboundParams, body: commandInputSchema }))
    .output(outboundSchema),
  checkOutbound: endpoint
    .route({
      method: 'POST',
      path: `${path}/outbound/{outboundId}/check`,
      summary: 'Check whether a reply was sent',
      description:
        'Requires `messages.send`. Reads the thread again; never sends.',
    })
    .meta({ access: requires('messages.send'), errors })
    .input(z.object({ params: outboundParams, body: commandInputSchema }))
    .output(outboundSchema),
  resolveOutboundDelivery: endpoint
    .route({
      method: 'POST',
      path: `${path}/outbound/{outboundId}/delivery`,
      summary: 'Mark an uncertain supplier email as delivered or not delivered',
      description: `Requires \`messages.send\` and \`procurement.manage\`. Records a person's decision after checking with the supplier; nothing is sent. \`delivered\` settles the email as sent; \`not_delivered\` as failed, so the order's submission can be drafted again. Only supplier emails in the \`uncertain\` state can be resolved; fails with 409 when \`expectedRevision\` is not current. ${retry}`,
    })
    .meta({ access: requires('messages.send'), errors })
    .input(
      z.object({ params: outboundParams, body: outboundDeliveryInputSchema }),
    )
    .output(outboundSchema),
  discardOutbound: endpoint
    .route({
      method: 'POST',
      path: `${path}/outbound/{outboundId}/discard`,
      summary: 'Discard a draft reply',
      description:
        'Requires `messages.send`. Only drafts and replies waiting for approval can be discarded.',
    })
    .meta({ access: requires('messages.send'), errors })
    .input(z.object({ params: outboundParams, body: commandInputSchema }))
    .output(outboundSchema),
};
