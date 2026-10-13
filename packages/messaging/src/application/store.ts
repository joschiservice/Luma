import type { AuditEntry } from '@luma/audit';

import type { ConsequentialReason } from '../domain/consequential.js';
import type {
  LinkEvidence,
  LinkMethod,
  LinkState,
  RecordKind,
} from '../domain/linking.js';
import type { Mailbox, MailboxRule } from '../domain/mailbox.js';
import type {
  Citation,
  OutboundState,
  ReplyLanguage,
} from '../domain/replies.js';
import type {
  Address,
  MessageDocument,
  ThreadDocument,
  ThreadStatus,
} from '../domain/threads.js';
import type { DocumentReadingRepository } from './documents-store.js';

export interface ThreadRow {
  id: string;
  connectionId: string;
  providerThreadId: string;
  subject: string;
  document: ThreadDocument;
  status: ThreadStatus;
  ownerId: string | null;
  /** A person's deadline; null uses the automatic one. */
  manualDueAt: string | null;
  replyDueAt: string | null;
  lastMessageAt: string;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  messageCount: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRow {
  id: string;
  threadId: string;
  connectionId: string;
  providerMessageId: string;
  rfcMessageId: string | null;
  direction: 'inbound' | 'outbound';
  fromAddress: string;
  document: MessageDocument;
  /** Null after retention, a removal request or erasure. */
  text: string | null;
  origin: 'sync' | 'luma';
  receivedAt: string;
  retainUntil: string;
  purgedAt: string | null;
  purgeReason: 'retention' | 'request' | 'erasure' | null;
  createdAt: string;
}

export interface LinkRow {
  id: string;
  threadId: string;
  kind: RecordKind;
  recordId: string;
  method: LinkMethod;
  state: LinkState;
  evidence: LinkEvidence;
  createdBy: string;
  createdAt: string;
  removedBy: string | null;
  removedAt: string | null;
}

export interface NoteRow {
  id: string;
  threadId: string;
  authorId: string;
  body: string;
  createdAt: string;
}

export type EventType =
  | 'received'
  | 'sent'
  | 'assigned'
  | 'deadline_set'
  | 'status_changed'
  | 'linked'
  | 'unlinked'
  | 'note_added'
  | 'handed_off'
  | 'reply_requested'
  | 'reply_approved'
  | 'reply_rejected'
  | 'reply_withheld'
  | 'text_removed'
  | 'fact_reviewed';

export interface EventRow {
  id: string;
  threadId: string;
  type: EventType;
  actor: { kind: 'user' | 'luma'; id: string };
  details: Record<string, string>;
  occurredAt: string;
}

export type DocumentState =
  | 'pending'
  | 'reading'
  | 'ready'
  | 'failed'
  | 'unsupported'
  | 'unreadable'
  | 'duplicate';

/** A document row without its content; readers load content separately. */
export interface DocumentRow {
  id: string;
  messageId: string;
  threadId: string;
  providerAttachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
  sha256: string | null;
  familyKey: string;
  version: number;
  previousId: string | null;
  duplicateOf: string | null;
  state: DocumentState;
  /** Controlled failure code, such as `unsupported_type` or `too_large`. */
  failure: string | null;
  attempts: number;
  retainUntil: string;
  purgedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type { OutboundState } from '../domain/replies.js';

/** The stored reply document; the reply owner fills it. */
interface OutboundDocument {
  to: Address[];
  cc: Address[];
  subject: string;
  text: string;
  attachments?: { filename: string; mimeType: string; base64: string }[];
  composeDigest?: string;
  ownerHandoffAt?: string | null;
  attachmentsExpireAt?: string;
  deliveryCheckedAt?: string;
  /** Supplier work metadata is bound with the exact approved content. */
  procurement?: {
    purchaseOrderId: string;
    supplierId: string;
    kind: 'submission' | 'follow_up';
    requestedDeliveryDate?: string;
    attentionKey?: string;
    nextCheckAt?: string;
    reason?: string;
    orderRevision?: number;
    supplierRevision?: number;
    requestDigest?: string;
  };
  citations?: Citation[];
  consequential?: ConsequentialReason[];
  stateReason?: string | null;
  decisionId?: string | null;
  approverId?: string | null;
  sentMessageId?: string | null;
  language?: ReplyLanguage;
  inReplyTo?: string | null;
  references?: string[];
  /** Set when the reply is requested; the action binds these. */
  risk?: 'low' | 'high';
  contentDigest?: string;
  requestedAt?: string;
  expiresAt?: string;
  /** The permission policy required, which approvers also need. */
  permission?: string | null;
}

export interface OutboundRow {
  id: string;
  threadId: string;
  connectionId: string;
  document: OutboundDocument;
  state: OutboundState;
  actionId: string | null;
  requestedBy: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type ThreadView =
  'open' | 'mine' | 'unassigned' | 'overdue' | 'review' | 'closed' | 'all';

export interface ThreadFilter {
  view: ThreadView;
  actorId: string;
  now: string;
  connectionId?: string | undefined;
  q?: string | undefined;
  after?: { lastMessageAt: string; id: string } | undefined;
  limit: number;
}

interface MailboxRepository {
  list(): Promise<Mailbox[]>;
  /** `lock` holds the row until the transaction ends. */
  get(connectionId: string, lock?: boolean): Promise<Mailbox | null>;
  /** Returns false when the mailbox already exists. */
  insert(mailbox: Mailbox): Promise<boolean>;
  /** Writes every mutable field. */
  update(mailbox: Mailbox): Promise<void>;
  /**
   * Leases the most overdue mailbox of `principalId` that is due or hinted, unpaused, unblocked
   * and not leased; null when none is.
   */
  claim(
    principalId: string,
    token: string,
    leaseMs: number,
  ): Promise<Mailbox | null>;
  /** The mailbox while `token` still holds its lease, locked; null when the lease was lost. */
  leased(connectionId: string, token: string): Promise<Mailbox | null>;
  /** Blocks every mailbox read as `principalId`. */
  blockPrincipal(principalId: string, reason: string): Promise<void>;
}

interface RuleRepository {
  /** Active rules, of one mailbox when given. */
  active(connectionId?: string): Promise<MailboxRule[]>;
  get(id: string): Promise<(MailboxRule & { removedAt: string | null }) | null>;
  /** Returns false when the same active rule exists. */
  insert(rule: MailboxRule): Promise<boolean>;
  remove(id: string, by: string, at: string): Promise<void>;
  markBackfilled(ids: string[], at: string): Promise<void>;
}

interface ThreadRepository {
  get(id: string, lock?: boolean): Promise<ThreadRow | null>;
  byProvider(
    connectionId: string,
    providerThreadId: string,
    lock?: boolean,
  ): Promise<ThreadRow | null>;
  insert(thread: ThreadRow): Promise<void>;
  /** Writes every mutable field. */
  update(thread: ThreadRow): Promise<void>;
  /** One page, newest activity first, after the keyset position. */
  list(filter: ThreadFilter): Promise<ThreadRow[]>;
  counts(filter: Omit<ThreadFilter, 'view' | 'after' | 'limit'>): Promise<{
    open: number;
    mine: number;
    unassigned: number;
    overdue: number;
    review: number;
  }>;
  /** Threads with an active link to the record. */
  forRecord(kind: RecordKind, recordId: string): Promise<ThreadRow[]>;
  /** Open threads whose reply deadline is before `until`, earliest first. */
  due(until: string, limit: number): Promise<ThreadRow[]>;
}

interface MessageRepository {
  /** Returns false when the provider message is already stored. */
  insert(message: MessageRow): Promise<boolean>;
  get(id: string): Promise<MessageRow | null>;
  forThread(threadId: string): Promise<MessageRow[]>;
  /** Removes the text and keeps metadata. */
  purge(id: string, reason: 'request', at: string): Promise<void>;
}

interface LinkRepository {
  forThreads(threadIds: string[]): Promise<LinkRow[]>;
  get(id: string): Promise<LinkRow | null>;
  /** The current link, or the latest removed one when no current link exists. */
  latest(
    threadId: string,
    kind: RecordKind,
    recordId: string,
  ): Promise<LinkRow | null>;
  insert(link: LinkRow): Promise<void>;
  /** Writes state, evidence and removal fields. */
  update(link: LinkRow): Promise<void>;
}

interface NoteRepository {
  forThread(threadId: string): Promise<NoteRow[]>;
  insert(note: NoteRow): Promise<void>;
}

interface EventRepository {
  forThread(threadId: string): Promise<EventRow[]>;
  insert(event: EventRow): Promise<void>;
  /** Whether an event of this type names the message in `details.messageId`. */
  forMessage(type: EventType, messageId: string): Promise<boolean>;
}

interface DocumentRepository {
  forThreads(threadIds: string[]): Promise<DocumentRow[]>;
  /** Returns false when the attachment is already a document. */
  insert(document: DocumentRow): Promise<boolean>;
  /** Removes content and representation of a message's documents. */
  purgeForMessage(messageId: string, at: string): Promise<void>;
}

interface FactRepository {
  /** Facts waiting for review per thread. */
  toReview(threadIds: string[]): Promise<Map<string, number>>;
  /** Facts waiting for review per document. */
  toReviewByDocument(documentIds: string[]): Promise<Map<string, number>>;
}

export interface OutboundRepository {
  forThread(threadId: string): Promise<OutboundRow[]>;
  /** `lock` holds the row until the transaction ends. */
  get(id: string, lock?: boolean): Promise<OutboundRow | null>;
  insert(outbound: OutboundRow): Promise<void>;
  /** Writes document, state, action, revision and update time. */
  update(outbound: OutboundRow): Promise<void>;
  /** Replies waiting for approval, sending or a check, oldest first. */
  live(limit: number): Promise<OutboundRow[]>;
  /** Marks a stored message as sent by Luma. */
  markMessageSent(messageId: string): Promise<void>;
  /** Supplier sends needing an owner handoff or a later read for delivery failures. */
  supplierChecks?(limit: number): Promise<OutboundRow[]>;
}

interface CommandRepository {
  get(id: string): Promise<{ digest: string; result: unknown } | null>;
  save(id: string, digest: string, result: unknown): Promise<void>;
}

/**
 * One tenant transaction over messaging tables. Repositories share the transaction, so records,
 * timeline events, command receipts and audit entries commit or roll back together. Document
 * reading and replies extend this interface with their own repositories.
 */
export interface MessagingTransaction {
  mailboxes: MailboxRepository;
  rules: RuleRepository;
  threads: ThreadRepository;
  messages: MessageRepository;
  links: LinkRepository;
  notes: NoteRepository;
  events: EventRepository;
  documents: DocumentRepository;
  facts: FactRepository;
  /** Reading document content and reviewing its facts. */
  reading: DocumentReadingRepository;
  outbound: OutboundRepository;
  commands: CommandRepository;
  /** Appends audit evidence in the business transaction. */
  audit(entry: AuditEntry): Promise<void>;
}

export interface MessagingStore {
  transaction<T>(
    tenantId: string,
    operation: (tx: MessagingTransaction) => Promise<T>,
  ): Promise<T>;
  /** Routing identities of due mailboxes across workspaces; reveals no content. */
  scopes(): Promise<{ tenantId: string; principalId: string }[]>;
}
