import { createHash, randomUUID } from 'node:crypto';

import type { AuditLog } from '@luma/audit';
import type { TenantContext } from '@luma/identity';
import type { ModelGateway, TenantDatabase } from '@luma/platform';
import { createFailureLog } from '@luma/platform';

import type {
  AttachmentReader,
  DocumentDirectory,
} from './application/document-ports.js';
import { createDocuments } from './application/documents.js';
import { createIngest } from './application/ingest.js';
import { createMessagingService } from './application/messaging.js';
import type {
  MailboxConnections,
  MemberDirectory,
  MessageReader,
  ProcurementHandoff,
  RecordDirectory,
} from './application/ports.js';
import { createReplies } from './application/replies.js';
import type {
  RecordStates,
  ReplyAdmission,
} from './application/reply-ports.js';
import type { BackgroundPass } from './application/sync.js';
import { createMailboxSync } from './application/sync.js';
import { createFactExtractor } from './infrastructure/extraction.js';
import { represent } from './infrastructure/representation/index.js';
import { createMessagingStore } from './infrastructure/store.js';

export { documentExtractionProfile } from './infrastructure/extraction.js';

export { purgeExpiredMessaging } from './infrastructure/store.js';

export {
  replyCitations,
  replyEvidence,
} from './infrastructure/reply-evidence.js';

const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Derives a stable UUID (version 5 layout) from a name. */
function nameUuid(name: string) {
  const hex = createHash('sha256')
    .update(`luma:messaging:${name}`)
    .digest('hex');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

export interface MessagingOptions {
  audit: (db: TenantDatabase) => AuditLog;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  /** Reauthorizes the member a mailbox is read as, for background reads. */
  resolveContext(
    userId: string,
    tenantId: string,
    requestId: string,
  ): Promise<TenantContext>;
  connections: MailboxConnections;
  directory: RecordDirectory;
  members: MemberDirectory;
  /** Without a reader, mailboxes are listed and managed but not read. */
  reader?: MessageReader | undefined;
  handoff?: ProcurementHandoff | undefined;
  /** Days message text and attachment content are kept; defaults to 365. */
  retentionDays?: number | undefined;
  /** Time between reads of a current mailbox; defaults to two minutes. */
  pollMs?: number | undefined;
  /** Work run after each workspace's mailboxes, such as reading documents. */
  passes?: BackgroundPass[] | undefined;
  /** Current state of linked records for reply drafts. */
  records?: RecordStates | undefined;
  /** Action Admission for sending replies; without it, replies are drafted only. */
  replyAdmission?: ReplyAdmission | null | undefined;
  /** Reading attachments as documents and matching their facts. */
  documents?:
    | {
        /** Without it, documents stay pending until a process that can read them runs. */
        attachments?: AttachmentReader | undefined;
        directory: DocumentDirectory;
        /** The model route for `document-extraction`; without it, people add facts by hand. */
        extraction?:
          | {
              gateway: ModelGateway | null;
              available: boolean;
              reason: string | null;
            }
          | undefined;
      }
    | undefined;
  log?: ((message: string, error?: unknown) => void) | undefined;
  /** Idempotent record-owner handoff for outgoing supplier messages. */
  settled?: import('./application/replies.js').ReplyDependencies['settled'];
  eligibleOwner?: import('./application/replies.js').ReplyDependencies['eligibleOwner'];
}

/**
 * Composes the operations inbox over messaging storage: the service for HTTP and other owners,
 * replies, and the background runner that reads mailboxes and checks replies in flight. The
 * runner needs `reader`.
 */
export function createMessaging(db: TenantDatabase, options: MessagingOptions) {
  const store = createMessagingStore(db, options.audit);
  const log = options.log ?? createFailureLog();
  const now = () => new Date();
  const ingest = createIngest({
    store,
    directory: options.directory,
    handoff: options.handoff,
    now,
    id: randomUUID,
    digest,
    uuid: nameUuid,
    retentionDays: options.retentionDays ?? 365,
    log,
  });
  const service = createMessagingService({
    store,
    connections: options.connections,
    directory: options.directory,
    members: options.members,
    reader: options.reader,
    ingest,
    refreshContext: options.refreshContext,
    now,
    id: randomUUID,
    digest,
  });
  const replies = createReplies({
    decodeAttachment: (base64) => new Uint8Array(Buffer.from(base64, 'base64')),
    attachments: options.documents?.attachments,
    store,
    connections: options.connections,
    directory: options.directory,
    records: options.records,
    admission: options.replyAdmission,
    reader: options.reader,
    ingest,
    refreshContext: options.refreshContext,
    resolveContext: options.resolveContext,
    now,
    id: randomUUID,
    digest,
    uuid: nameUuid,
    log,
    retentionDays: options.retentionDays ?? 365,
    settled: options.settled,
    eligibleOwner: options.eligibleOwner,
  });
  const documents = createDocuments({
    store,
    directory: options.directory,
    documents: options.documents?.directory ?? {
      skus: async () => new Set(),
      suppliers: async () => [],
    },
    attachments: options.documents?.attachments,
    represent,
    extractor: createFactExtractor(
      options.documents?.extraction ?? {
        gateway: null,
        available: false,
        reason: null,
      },
    ),
    refreshContext: options.refreshContext,
    now,
    id: randomUUID,
    digest,
    sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
    log,
  });
  // Replies in flight are checked and pending documents read after each workspace's mailboxes.
  const passes: BackgroundPass[] = [
    ...(options.passes ?? []),
    (context) => replies.pass(context),
    (context) => documents.pass(context),
  ];
  const sync = options.reader
    ? createMailboxSync({
        store,
        connections: options.connections,
        reader: options.reader,
        ingest,
        resolveContext: options.resolveContext,
        now,
        id: randomUUID,
        log,
        ...(options.pollMs ? { pollMs: options.pollMs } : {}),
        passes,
      })
    : null;

  return { service, replies, documents: documents.service, sync, store };
}
