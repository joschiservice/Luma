/** What messaging reads return to people; mirrors the HTTP contract shapes. */

import type { TenantContext } from '@luma/identity';
import { hasPermission } from '@luma/identity';

import type {
  LinkEvidence,
  LinkMethod,
  RecordKind,
} from '../domain/linking.js';
import type {
  MailboxRule,
  MailboxSettings,
  RuleParty,
  SyncState,
} from '../domain/mailbox.js';
import type { Citation } from '../domain/replies.js';
import { replyActions, stateMessages } from '../domain/replies.js';
import type { Address, ThreadStatus } from '../domain/threads.js';
import { awaitingReply } from '../domain/threads.js';
import type {
  DocumentRow,
  DocumentState,
  EventRow,
  EventType,
  LinkRow,
  MessageRow,
  OutboundRow,
  OutboundState,
  ThreadRow,
} from './store.js';

export interface RuleView {
  id: string;
  kind: MailboxRule['kind'];
  value: string;
  party: RuleParty;
  partyLabel: string | null;
  backfilledAt: string | null;
  createdBy: string;
  createdAt: string;
}

export interface MailboxView {
  connectionId: string;
  label: string;
  provider: string;
  address: string | null;
  connectionStatus:
    'pending' | 'active' | 'degraded' | 'disconnected' | 'revoked';
  canSend: boolean;
  state: SyncState;
  stateReason: string | null;
  lastSyncedAt: string | null;
  coveredUntil: string | null;
  settings: MailboxSettings & { paused: boolean };
  rules: RuleView[];
  revision: number;
}

export interface RecordView {
  kind: RecordKind;
  id: string;
  label: string | null;
}

export interface ThreadSummary {
  id: string;
  connectionId: string;
  mailboxLabel: string;
  subject: string;
  correspondent: Address | null;
  snippet: string;
  status: ThreadStatus;
  ownerId: string | null;
  replyDueAt: string | null;
  replyDueSource: 'automatic' | 'manual' | null;
  overdue: boolean;
  awaitingReply: boolean;
  lastMessageAt: string;
  messageCount: number;
  links: RecordView[];
  attachmentCount: number;
  factsToReview: number;
  revision: number;
}

export interface LinkView {
  id: string;
  record: RecordView;
  method: LinkMethod;
  state: 'active' | 'suggested';
  evidence: LinkEvidence;
  createdBy: string;
  createdAt: string;
}

export interface MessageView {
  id: string;
  threadId: string;
  direction: 'inbound' | 'outbound';
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  text: string | null;
  truncated: boolean;
  sentAt: string;
  receivedAt: string;
  source: { provider: string; messageId: string; rfcMessageId: string | null };
  origin: 'sync' | 'luma';
  attachments: {
    filename: string;
    mimeType: string;
    size: number;
    documentId: string | null;
  }[];
  retainUntil: string;
  purgedAt: string | null;
}

export interface EventView {
  id: string;
  type: EventType;
  actor: { kind: 'user' | 'luma'; id: string };
  details: Record<string, string>;
  occurredAt: string;
}

export interface DocumentSummary {
  id: string;
  messageId: string;
  threadId: string;
  filename: string;
  mimeType: string;
  size: number;
  sha256: string | null;
  version: number;
  previousId: string | null;
  duplicateOf: string | null;
  state: DocumentState;
  stateReason: string | null;
  factsToReview: number;
  receivedAt: string;
}

export interface OutboundView {
  id: string;
  threadId: string;
  connectionId: string;
  to: Address[];
  cc: Address[];
  subject: string;
  text: string;
  citations: Citation[];
  consequential: ('date' | 'quantity' | 'money' | 'workspace_policy')[];
  state: OutboundState;
  stateReason: string | null;
  requestedBy: string;
  decisionId: string | null;
  approverId: string | null;
  sentMessageId: string | null;
  canEdit: boolean;
  canRequest: boolean;
  canApprove: boolean;
  canSend: boolean;
  canCheck: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadDetail {
  thread: ThreadSummary;
  messages: MessageView[];
  links: LinkView[];
  notes: { id: string; authorId: string; body: string; createdAt: string }[];
  events: EventView[];
  documents: DocumentSummary[];
  outbound: OutboundView[];
  permissions: { canManage: boolean; canSend: boolean };
}

/** The permission that lets someone see a linked record of each kind. */
export const recordPermission = {
  order: 'orders.read',
  customer: 'customers.read',
  supplier: 'procurement.read',
  purchase_order: 'procurement.read',
  case: 'issues.read',
} as const satisfies Record<RecordKind, string>;

/** The `kind:id` key labels are stored under. */
export const recordKey = (record: { kind: RecordKind; id: string }) =>
  `${record.kind}:${record.id}`;

/** A record reference with its label when the reader may read the record. */
export function recordView(
  context: TenantContext,
  kind: RecordKind,
  id: string,
  labels: ReadonlyMap<string, string>,
): RecordView {
  return {
    kind,
    id,
    label: hasPermission(context, recordPermission[kind])
      ? (labels.get(recordKey({ kind, id })) ?? null)
      : null,
  };
}

/** The record an event names, so its label can be read with the thread's other records. */
export function eventRecord(
  event: EventRow,
): { kind: RecordKind; id: string } | null {
  const { kind, recordId, purchaseOrderId } = event.details;
  if ((event.type === 'linked' || event.type === 'unlinked') && recordId)
    return Object.hasOwn(recordPermission, kind ?? '')
      ? { kind: kind as RecordKind, id: recordId }
      : null;
  if (event.type === 'handed_off' && purchaseOrderId)
    return { kind: 'purchase_order', id: purchaseOrderId };

  return null;
}

/**
 * Presents a timeline event. Details use stable keys for people-facing text: `ownerId` for
 * assignments, `replyDueAt` and `automatic` for deadlines, `status` and `reason` for status
 * changes, `record` (a display label, omitted when the reader can't read the record) for links
 * and handoffs, and `outcome` or `reason` where the event has one.
 */
export function eventView(
  context: TenantContext,
  event: EventRow,
  labels: ReadonlyMap<string, string>,
): EventView {
  const details = event.details;
  const record = eventRecord(event);
  const label = record
    ? recordView(context, record.kind, record.id, labels).label
    : null;
  const presented: Record<string, string> = (() => {
    switch (event.type) {
      case 'assigned':
        return details.to ? { ownerId: details.to } : {};
      case 'deadline_set':
        return {
          ...(details.replyDueAt ? { replyDueAt: details.replyDueAt } : {}),
          automatic: details.automatic ?? 'false',
        };
      case 'status_changed':
        return {
          status: details.to ?? '',
          ...(details.reason ? { reason: details.reason } : {}),
        };
      case 'linked':
      case 'unlinked':
        return label ? { record: label } : {};
      case 'handed_off':
        return {
          ...(label ? { record: label } : {}),
          ...(details.outcome ? { outcome: details.outcome } : {}),
        };
      case 'fact_reviewed':
        return {
          ...(details.documentId ? { documentId: details.documentId } : {}),
          ...(details.factId ? { factId: details.factId } : {}),
          ...(details.kind ? { kind: details.kind } : {}),
          ...(details.outcome ? { outcome: details.outcome } : {}),
        };
      default:
        return details.reason ? { reason: details.reason } : {};
    }
  })();

  return {
    id: event.id,
    type: event.type,
    actor: event.actor,
    details: presented,
    occurredAt: event.occurredAt,
  };
}

/** Presents a thread for lists; `overdue` compares the deadline with `now`. */
export function threadSummary(
  context: TenantContext,
  thread: ThreadRow,
  input: {
    mailboxLabel: string;
    links: readonly LinkRow[];
    labels: ReadonlyMap<string, string>;
    factsToReview: number;
    now: Date;
  },
): ThreadSummary {
  return {
    id: thread.id,
    connectionId: thread.connectionId,
    mailboxLabel: input.mailboxLabel,
    subject: thread.subject,
    correspondent: thread.document.correspondent,
    snippet: thread.document.snippet,
    status: thread.status,
    ownerId: thread.ownerId,
    replyDueAt: thread.replyDueAt,
    replyDueSource: thread.replyDueAt
      ? thread.manualDueAt
        ? 'manual'
        : 'automatic'
      : null,
    overdue:
      thread.status !== 'closed' &&
      !!thread.replyDueAt &&
      Date.parse(thread.replyDueAt) < input.now.getTime(),
    awaitingReply: awaitingReply(thread),
    lastMessageAt: thread.lastMessageAt,
    messageCount: thread.messageCount,
    links: input.links
      .filter((link) => link.threadId === thread.id && link.state === 'active')
      .map((link) =>
        recordView(context, link.kind, link.recordId, input.labels),
      ),
    attachmentCount: thread.document.attachmentCount,
    factsToReview: input.factsToReview,
    revision: thread.revision,
  };
}

/** Presents a stored message with its provider identity and document references. */
export function messageView(
  message: MessageRow,
  provider: string,
  documents: readonly DocumentRow[],
): MessageView {
  const document = message.document;

  return {
    id: message.id,
    threadId: message.threadId,
    direction: message.direction,
    from: document.from,
    to: document.to,
    cc: document.cc,
    subject: document.subject,
    text: message.text,
    truncated: document.truncated,
    sentAt: document.sentAt,
    receivedAt: document.receivedAt,
    source: {
      provider,
      messageId: message.providerMessageId,
      rfcMessageId: message.rfcMessageId,
    },
    origin: message.origin,
    attachments: document.attachments.map((attachment) => ({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
      documentId:
        documents.find(
          (d) =>
            d.messageId === message.id &&
            d.providerAttachmentId === attachment.attachment.externalId,
        )?.id ?? null,
    })),
    retainUntil: message.retainUntil,
    purgedAt: message.purgedAt,
  };
}

/** Presents a current or suggested link with its evidence. */
export function linkView(
  context: TenantContext,
  link: LinkRow,
  labels: ReadonlyMap<string, string>,
): LinkView {
  return {
    id: link.id,
    record: recordView(context, link.kind, link.recordId, labels),
    method: link.method,
    state: link.state === 'suggested' ? 'suggested' : 'active',
    evidence: link.evidence,
    createdBy: link.createdBy,
    createdAt: link.createdAt,
  };
}

const documentReasons: Record<string, string> = {
  unsupported_type: 'Luma reads PDF, CSV, XLSX and plain text files.',
  too_large: 'The file is larger than 10 MB, so Luma does not read it.',
  read_failed:
    'Luma could not get the file from the mailbox. Read it again to retry.',
  connection:
    'The mailbox connection cannot read files. Reconnect it, then read the file again.',
  not_found: 'The file is no longer in the mailbox.',
  read_rejected: 'The mailbox would not return this file.',
  content_mismatch:
    'The file changed while Luma read it. Read it again to retry.',
  content_removed: 'The file’s content was removed before Luma read it.',
  parse_failed: 'Luma could not read this file. Read it again to retry.',
  encrypted: 'The file is password-protected.',
  no_text:
    'The PDF has no text layer, such as a scan. Luma does not read scans.',
  damaged: 'The file is damaged or not in the format its name says.',
  empty: 'The file is empty.',
  truncated:
    'The file is long, so Luma kept the first 300 pages, or 5,000 rows and 100 columns of each sheet.',
};

/** Presents a document with a reason for people when it was not read. */
export function documentSummary(
  document: DocumentRow,
  receivedAt: string,
  factsToReview: number,
): DocumentSummary {
  return {
    id: document.id,
    messageId: document.messageId,
    threadId: document.threadId,
    filename: document.filename,
    mimeType: document.mimeType,
    size: document.size,
    sha256: document.sha256,
    version: document.version,
    previousId: document.previousId,
    duplicateOf: document.duplicateOf,
    state: document.state,
    stateReason: document.failure
      ? (documentReasons[document.failure] ?? 'Luma could not read this file.')
      : null,
    factsToReview,
    receivedAt,
  };
}

/**
 * Presents a stored reply with what the reader can do now. Citation labels follow the same
 * record permissions as links; an expired approval request shows as expired.
 */
export function outboundView(
  outbound: OutboundRow,
  context: TenantContext,
  now: Date = new Date(),
): OutboundView {
  const document = outbound.document;
  const actions = replyActions(
    {
      state: outbound.state,
      requestedBy: outbound.requestedBy,
      expiresAt: document.expiresAt ?? null,
      approverId: document.approverId ?? null,
      permission: document.permission ?? null,
    },
    {
      id: context.actor.id,
      can: (permission) => context.permissions.has(permission),
    },
    now,
  );

  return {
    id: outbound.id,
    threadId: outbound.threadId,
    connectionId: outbound.connectionId,
    to: document.to,
    cc: document.cc,
    subject: document.subject,
    text: document.text,
    citations: (document.citations ?? []).map((citation) => ({
      ...citation,
      record: {
        ...citation.record,
        label: hasPermission(context, recordPermission[citation.record.kind])
          ? citation.record.label
          : null,
      },
    })),
    consequential: document.consequential ?? [],
    state: actions.state,
    stateReason:
      document.stateReason ??
      (outbound.state === 'draft' ? null : stateMessages[actions.state]),
    requestedBy: outbound.requestedBy,
    decisionId: document.decisionId ?? null,
    approverId: document.approverId ?? null,
    sentMessageId: document.sentMessageId ?? null,
    canEdit: actions.canEdit,
    canRequest: actions.canRequest,
    canApprove: actions.canApprove,
    canSend: actions.canSend,
    canCheck: actions.canCheck,
    revision: outbound.revision,
    createdAt: outbound.createdAt,
    updatedAt: outbound.updatedAt,
  };
}
