import type { AuditLog } from '@luma/audit';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';

import type {
  DocumentRow,
  EventRow,
  LinkRow,
  MessageRow,
  MessagingStore,
  MessagingTransaction,
  NoteRow,
  ThreadFilter,
  ThreadRow,
} from '../application/store.js';
import type { Mailbox, MailboxRule } from '../domain/mailbox.js';
import { documentReading } from './documents-store.js';
import { outboundRepository } from './outbound-store.js';

/** Discovery reads routing identities only; it needs a tenant setting but no tenant data. */
const discoveryTenant = '00000000-0000-4000-8000-000000000000';

type Row = Record<string, unknown>;

const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : (value as string);

const isoOrNull = (value: unknown) =>
  value === null || value === undefined ? null : iso(value);

function mailbox(row: Row): Mailbox {
  const document = row.document as {
    label: string;
    provider: string;
    address: string | null;
    settings: Mailbox['settings'];
  };

  return {
    tenantId: row.tenant_id as string,
    connectionId: row.connection_id as string,
    principalId: row.principal_id as string,
    label: document.label,
    provider: document.provider,
    address: document.address,
    settings: document.settings,
    cursor: row.cursor as Mailbox['cursor'],
    paused: row.paused as boolean,
    blocked: row.blocked as Mailbox['blocked'],
    dueAt: iso(row.due_at),
    hintAt: isoOrNull(row.hint_at),
    leaseToken: (row.lease_token as string | null) ?? null,
    leaseUntil: isoOrNull(row.lease_until),
    attempts: row.attempts as number,
    lastSyncedAt: isoOrNull(row.last_synced_at),
    lastError: (row.last_error as string | null) ?? null,
    revision: row.revision as number,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function rule(row: Row): MailboxRule & { removedAt: string | null } {
  return {
    id: row.id as string,
    connectionId: row.connection_id as string,
    kind: row.kind as MailboxRule['kind'],
    value: row.value as string,
    party: row.party as MailboxRule['party'],
    backfilledAt: isoOrNull(row.backfilled_at),
    createdBy: row.created_by as string,
    createdAt: iso(row.created_at),
    removedAt: isoOrNull(row.removed_at),
  };
}

function thread(row: Row): ThreadRow {
  return {
    id: row.id as string,
    connectionId: row.connection_id as string,
    providerThreadId: row.provider_thread_id as string,
    subject: row.subject as string,
    document: row.document as ThreadRow['document'],
    status: row.status as ThreadRow['status'],
    ownerId: (row.owner_id as string | null) ?? null,
    manualDueAt: isoOrNull(row.manual_due_at),
    replyDueAt: isoOrNull(row.reply_due_at),
    lastMessageAt: iso(row.last_message_at),
    lastInboundAt: isoOrNull(row.last_inbound_at),
    lastOutboundAt: isoOrNull(row.last_outbound_at),
    messageCount: row.message_count as number,
    revision: row.revision as number,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function message(row: Row): MessageRow {
  return {
    id: row.id as string,
    threadId: row.thread_id as string,
    connectionId: row.connection_id as string,
    providerMessageId: row.provider_message_id as string,
    rfcMessageId: (row.rfc_message_id as string | null) ?? null,
    direction: row.direction as MessageRow['direction'],
    fromAddress: row.from_address as string,
    document: row.document as MessageRow['document'],
    text: (row.body as string | null) ?? null,
    origin: row.origin as MessageRow['origin'],
    receivedAt: iso(row.received_at),
    retainUntil: iso(row.retain_until),
    purgedAt: isoOrNull(row.purged_at),
    purgeReason: (row.purge_reason as MessageRow['purgeReason']) ?? null,
    createdAt: iso(row.created_at),
  };
}

function link(row: Row): LinkRow {
  return {
    id: row.id as string,
    threadId: row.thread_id as string,
    kind: row.record_kind as LinkRow['kind'],
    recordId: row.record_id as string,
    method: row.method as LinkRow['method'],
    state: row.state as LinkRow['state'],
    evidence: row.evidence as LinkRow['evidence'],
    createdBy: row.created_by as string,
    createdAt: iso(row.created_at),
    removedBy: (row.removed_by as string | null) ?? null,
    removedAt: isoOrNull(row.removed_at),
  };
}

function event(row: Row): EventRow {
  return {
    id: row.id as string,
    threadId: row.thread_id as string,
    type: row.type as EventRow['type'],
    actor: row.actor as EventRow['actor'],
    details: row.details as EventRow['details'],
    occurredAt: iso(row.occurred_at),
  };
}

function document(row: Row): DocumentRow {
  return {
    id: row.id as string,
    messageId: row.message_id as string,
    threadId: row.thread_id as string,
    providerAttachmentId: row.provider_attachment_id as string,
    filename: row.filename as string,
    mimeType: row.mime_type as string,
    size: row.size as number,
    sha256: (row.sha256 as string | null) ?? null,
    familyKey: row.family_key as string,
    version: row.version as number,
    previousId: (row.previous_id as string | null) ?? null,
    duplicateOf: (row.duplicate_of as string | null) ?? null,
    state: row.state as DocumentRow['state'],
    failure: (row.failure as string | null) ?? null,
    attempts: row.attempts as number,
    retainUntil: iso(row.retain_until),
    purgedAt: isoOrNull(row.purged_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** SQL conditions for each thread view; `$2` is the reader and `$3` the current time. */
const viewConditions: Record<ThreadFilter['view'], string> = {
  open: "t.status<>'closed'",
  mine: "t.status<>'closed' AND t.owner_id=$2",
  unassigned: "t.status<>'closed' AND t.owner_id IS NULL",
  overdue: "t.status<>'closed' AND t.reply_due_at<$3::timestamptz",
  review:
    "EXISTS (SELECT 1 FROM messaging_facts f JOIN messaging_documents d ON d.tenant_id=f.tenant_id AND d.id=f.document_id WHERE f.tenant_id=t.tenant_id AND d.thread_id=t.id AND f.status IN ('proposed','needs_correction'))",
  closed: "t.status='closed'",
  all: 'true',
};

/** Escapes LIKE wildcards in a search term. */
const like = (q: string | undefined) =>
  q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;

/** Shared filters of lists and counts; `$4` connection, `$5` search pattern. */
const listFilter = `t.tenant_id=$1 AND ($4::uuid IS NULL OR t.connection_id=$4)
  AND ($5::text IS NULL OR t.subject ILIKE $5 OR t.document->'correspondent'->>'address' ILIKE $5
   OR t.document->'correspondent'->>'name' ILIKE $5)`;

/** Builds one transaction's repositories over the tenant-scoped connection. */
function repositories(
  tx: SqlTransaction,
  tenantId: string,
  log: AuditLog,
): MessagingTransaction {
  const rows = async (sql: string, values: unknown[]) =>
    (await tx.query<Row>(sql, values)).rows;

  return {
    mailboxes: {
      async list() {
        return (
          await rows(
            'SELECT * FROM messaging_mailboxes WHERE tenant_id=$1 ORDER BY connection_id',
            [tenantId],
          )
        ).map(mailbox);
      },
      async get(connectionId, lock = false) {
        const [row] = await rows(
          `SELECT * FROM messaging_mailboxes WHERE tenant_id=$1 AND connection_id=$2${lock ? ' FOR UPDATE' : ''}`,
          [tenantId, connectionId],
        );

        return row ? mailbox(row) : null;
      },
      async insert(m) {
        const result = await tx.query(
          `INSERT INTO messaging_mailboxes(tenant_id,connection_id,principal_id,document,cursor,paused,blocked,
            due_at,hint_at,attempts,revision,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,
          [
            tenantId,
            m.connectionId,
            m.principalId,
            {
              label: m.label,
              provider: m.provider,
              address: m.address,
              settings: m.settings,
            },
            m.cursor,
            m.paused,
            m.blocked,
            m.dueAt,
            m.hintAt,
            m.attempts,
            m.revision,
            m.createdAt,
            m.updatedAt,
          ],
        );

        return (result.rowCount ?? 0) > 0;
      },
      async update(m) {
        await tx.query(
          `UPDATE messaging_mailboxes SET principal_id=$3,document=$4,cursor=$5,paused=$6,blocked=$7,due_at=$8,
            hint_at=$9,lease_token=$10,lease_until=$11,attempts=$12,last_synced_at=$13,last_error=$14,revision=$15,
            updated_at=$16 WHERE tenant_id=$1 AND connection_id=$2`,
          [
            tenantId,
            m.connectionId,
            m.principalId,
            {
              label: m.label,
              provider: m.provider,
              address: m.address,
              settings: m.settings,
            },
            m.cursor,
            m.paused,
            m.blocked,
            m.dueAt,
            m.hintAt,
            m.leaseToken,
            m.leaseUntil,
            m.attempts,
            m.lastSyncedAt,
            m.lastError,
            m.revision,
            m.updatedAt,
          ],
        );
      },
      async claim(principalId, token, leaseMs) {
        const [row] = await rows(
          `WITH candidate AS (
            SELECT connection_id FROM messaging_mailboxes
            WHERE tenant_id=$1 AND principal_id=$2 AND NOT paused AND blocked IS NULL
              AND (lease_until IS NULL OR lease_until<now()) AND (due_at<=now() OR hint_at<=now())
            ORDER BY LEAST(due_at,COALESCE(hint_at,'infinity')),connection_id
            LIMIT 1 FOR UPDATE SKIP LOCKED
          )
          UPDATE messaging_mailboxes m SET lease_token=$3,
            lease_until=now()+($4::integer*interval '1 millisecond'),updated_at=now()
          FROM candidate c WHERE m.tenant_id=$1 AND m.connection_id=c.connection_id RETURNING m.*`,
          [tenantId, principalId, token, leaseMs],
        );

        return row ? mailbox(row) : null;
      },
      async leased(connectionId, token) {
        const [row] = await rows(
          'SELECT * FROM messaging_mailboxes WHERE tenant_id=$1 AND connection_id=$2 AND lease_token=$3 FOR UPDATE',
          [tenantId, connectionId, token],
        );

        return row ? mailbox(row) : null;
      },
      async blockPrincipal(principalId, reason) {
        await tx.query(
          `UPDATE messaging_mailboxes SET blocked=$3,lease_token=NULL,lease_until=NULL,updated_at=now()
          WHERE tenant_id=$1 AND principal_id=$2 AND blocked IS NULL`,
          [tenantId, principalId, reason],
        );
      },
    },
    rules: {
      async active(connectionId) {
        return (
          await rows(
            `SELECT * FROM messaging_rules WHERE tenant_id=$1 AND removed_at IS NULL
            AND ($2::uuid IS NULL OR connection_id=$2) ORDER BY created_at,id`,
            [tenantId, connectionId ?? null],
          )
        ).map(rule);
      },
      async get(id) {
        const [row] = await rows(
          'SELECT * FROM messaging_rules WHERE tenant_id=$1 AND id=$2',
          [tenantId, id],
        );

        return row ? rule(row) : null;
      },
      async insert(r) {
        const result = await tx.query(
          `INSERT INTO messaging_rules(tenant_id,id,connection_id,kind,value,party,backfilled_at,created_by,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
          [
            tenantId,
            r.id,
            r.connectionId,
            r.kind,
            r.value,
            r.party,
            r.backfilledAt,
            r.createdBy,
            r.createdAt,
          ],
        );

        return (result.rowCount ?? 0) > 0;
      },
      async remove(id, by, at) {
        await tx.query(
          'UPDATE messaging_rules SET removed_by=$3,removed_at=$4 WHERE tenant_id=$1 AND id=$2 AND removed_at IS NULL',
          [tenantId, id, by, at],
        );
      },
      async markBackfilled(ids, at) {
        if (!ids.length) return;
        await tx.query(
          'UPDATE messaging_rules SET backfilled_at=$3 WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND backfilled_at IS NULL',
          [tenantId, ids, at],
        );
      },
    },
    threads: {
      async get(id, lock = false) {
        const [row] = await rows(
          `SELECT * FROM messaging_threads WHERE tenant_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`,
          [tenantId, id],
        );

        return row ? thread(row) : null;
      },
      async byProvider(connectionId, providerThreadId, lock = false) {
        const [row] = await rows(
          `SELECT * FROM messaging_threads WHERE tenant_id=$1 AND connection_id=$2 AND (provider_thread_id=$3 OR document->>'resolvedProviderThreadId'=$3)${lock ? ' FOR UPDATE' : ''}`,
          [tenantId, connectionId, providerThreadId],
        );

        return row ? thread(row) : null;
      },
      async insert(t) {
        await tx.query(
          `INSERT INTO messaging_threads(tenant_id,id,connection_id,provider_thread_id,subject,document,status,owner_id,
            manual_due_at,reply_due_at,last_message_at,last_inbound_at,last_outbound_at,message_count,revision,
            created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
          ON CONFLICT (tenant_id,connection_id,provider_thread_id) DO NOTHING`,
          [
            tenantId,
            t.id,
            t.connectionId,
            t.providerThreadId,
            t.subject,
            t.document,
            t.status,
            t.ownerId,
            t.manualDueAt,
            t.replyDueAt,
            t.lastMessageAt,
            t.lastInboundAt,
            t.lastOutboundAt,
            t.messageCount,
            t.revision,
            t.createdAt,
            t.updatedAt,
          ],
        );
      },
      async update(t) {
        await tx.query(
          `UPDATE messaging_threads SET subject=$3,document=$4,status=$5,owner_id=$6,manual_due_at=$7,reply_due_at=$8,
            last_message_at=$9,last_inbound_at=$10,last_outbound_at=$11,message_count=$12,revision=$13,updated_at=$14
          WHERE tenant_id=$1 AND id=$2`,
          [
            tenantId,
            t.id,
            t.subject,
            t.document,
            t.status,
            t.ownerId,
            t.manualDueAt,
            t.replyDueAt,
            t.lastMessageAt,
            t.lastInboundAt,
            t.lastOutboundAt,
            t.messageCount,
            t.revision,
            t.updatedAt,
          ],
        );
      },
      async list(filter) {
        return (
          await rows(
            // Every view binds the reader and time, so both parameters are always typed.
            `SELECT t.* FROM messaging_threads t WHERE ${listFilter} AND ${viewConditions[filter.view]}
              AND $2::text IS NOT NULL AND $3::timestamptz IS NOT NULL
              AND ($6::timestamptz IS NULL OR (t.last_message_at,t.id)<($6::timestamptz,$7::uuid))
            ORDER BY t.last_message_at DESC,t.id DESC LIMIT $8`,
            [
              tenantId,
              filter.actorId,
              filter.now,
              filter.connectionId ?? null,
              like(filter.q),
              filter.after?.lastMessageAt ?? null,
              filter.after?.id ?? null,
              filter.limit,
            ],
          )
        ).map(thread);
      },
      async counts(filter) {
        const [row] = await rows(
          `SELECT count(*) FILTER (WHERE ${viewConditions.open})::integer AS open,
            count(*) FILTER (WHERE ${viewConditions.mine})::integer AS mine,
            count(*) FILTER (WHERE ${viewConditions.unassigned})::integer AS unassigned,
            count(*) FILTER (WHERE ${viewConditions.overdue})::integer AS overdue,
            count(*) FILTER (WHERE ${viewConditions.review})::integer AS review
          FROM messaging_threads t WHERE ${listFilter}`,
          [
            tenantId,
            filter.actorId,
            filter.now,
            filter.connectionId ?? null,
            like(filter.q),
          ],
        );

        return {
          open: row!.open as number,
          mine: row!.mine as number,
          unassigned: row!.unassigned as number,
          overdue: row!.overdue as number,
          review: row!.review as number,
        };
      },
      async forRecord(kind, recordId) {
        return (
          await rows(
            `SELECT t.* FROM messaging_threads t WHERE t.tenant_id=$1 AND EXISTS (
              SELECT 1 FROM messaging_links l WHERE l.tenant_id=t.tenant_id AND l.thread_id=t.id
              AND l.record_kind=$2 AND l.record_id=$3 AND l.state='active')
            ORDER BY t.last_message_at DESC,t.id DESC LIMIT 200`,
            [tenantId, kind, recordId],
          )
        ).map(thread);
      },
      async due(until, limit) {
        return (
          await rows(
            `SELECT * FROM messaging_threads WHERE tenant_id=$1 AND status<>'closed'
              AND reply_due_at IS NOT NULL AND reply_due_at<=$2 ORDER BY reply_due_at,id LIMIT $3`,
            [tenantId, until, limit],
          )
        ).map(thread);
      },
    },
    messages: {
      async insert(m) {
        const result = await tx.query(
          `INSERT INTO messaging_messages(tenant_id,id,thread_id,connection_id,provider_message_id,rfc_message_id,
            direction,from_address,document,body,origin,received_at,retain_until,purged_at,purge_reason,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
          ON CONFLICT (tenant_id,connection_id,provider_message_id) DO NOTHING`,
          [
            tenantId,
            m.id,
            m.threadId,
            m.connectionId,
            m.providerMessageId,
            m.rfcMessageId,
            m.direction,
            m.fromAddress,
            m.document,
            m.text,
            m.origin,
            m.receivedAt,
            m.retainUntil,
            m.purgedAt,
            m.purgeReason,
            m.createdAt,
          ],
        );

        return (result.rowCount ?? 0) > 0;
      },
      async get(id) {
        const [row] = await rows(
          'SELECT * FROM messaging_messages WHERE tenant_id=$1 AND id=$2',
          [tenantId, id],
        );

        return row ? message(row) : null;
      },
      async forThread(threadId) {
        return (
          await rows(
            'SELECT * FROM messaging_messages WHERE tenant_id=$1 AND thread_id=$2 ORDER BY received_at,id',
            [tenantId, threadId],
          )
        ).map(message);
      },
      async purge(id, reason, at) {
        await tx.query(
          'UPDATE messaging_messages SET body=NULL,purged_at=$3,purge_reason=$4 WHERE tenant_id=$1 AND id=$2 AND purged_at IS NULL',
          [tenantId, id, at, reason],
        );
      },
    },
    links: {
      async forThreads(threadIds) {
        if (!threadIds.length) return [];

        return (
          await rows(
            "SELECT * FROM messaging_links WHERE tenant_id=$1 AND thread_id=ANY($2::uuid[]) AND state<>'removed' ORDER BY created_at,id",
            [tenantId, threadIds],
          )
        ).map(link);
      },
      async get(id) {
        const [row] = await rows(
          'SELECT * FROM messaging_links WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
          [tenantId, id],
        );

        return row ? link(row) : null;
      },
      async latest(threadId, kind, recordId) {
        const [row] = await rows(
          `SELECT * FROM messaging_links WHERE tenant_id=$1 AND thread_id=$2 AND record_kind=$3 AND record_id=$4
          ORDER BY (state<>'removed') DESC,created_at DESC LIMIT 1 FOR UPDATE`,
          [tenantId, threadId, kind, recordId],
        );

        return row ? link(row) : null;
      },
      async insert(l) {
        await tx.query(
          `INSERT INTO messaging_links(tenant_id,id,thread_id,record_kind,record_id,method,state,evidence,created_by,
            created_at,removed_by,removed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            tenantId,
            l.id,
            l.threadId,
            l.kind,
            l.recordId,
            l.method,
            l.state,
            l.evidence,
            l.createdBy,
            l.createdAt,
            l.removedBy,
            l.removedAt,
          ],
        );
      },
      async update(l) {
        await tx.query(
          'UPDATE messaging_links SET state=$3,evidence=$4,removed_by=$5,removed_at=$6 WHERE tenant_id=$1 AND id=$2',
          [tenantId, l.id, l.state, l.evidence, l.removedBy, l.removedAt],
        );
      },
    },
    notes: {
      async forThread(threadId) {
        return (
          await rows(
            'SELECT * FROM messaging_notes WHERE tenant_id=$1 AND thread_id=$2 ORDER BY created_at,id',
            [tenantId, threadId],
          )
        ).map((row): NoteRow => ({
          id: row.id as string,
          threadId: row.thread_id as string,
          authorId: row.author_id as string,
          body: row.body as string,
          createdAt: iso(row.created_at),
        }));
      },
      async insert(note) {
        await tx.query(
          'INSERT INTO messaging_notes(tenant_id,id,thread_id,author_id,body,created_at) VALUES($1,$2,$3,$4,$5,$6)',
          [
            tenantId,
            note.id,
            note.threadId,
            note.authorId,
            note.body,
            note.createdAt,
          ],
        );
      },
    },
    events: {
      async forThread(threadId) {
        return (
          await rows(
            'SELECT * FROM messaging_events WHERE tenant_id=$1 AND thread_id=$2 ORDER BY occurred_at,id',
            [tenantId, threadId],
          )
        ).map(event);
      },
      async insert(e) {
        await tx.query(
          'INSERT INTO messaging_events(tenant_id,id,thread_id,type,actor,details,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            tenantId,
            e.id,
            e.threadId,
            e.type,
            e.actor,
            e.details,
            e.occurredAt,
          ],
        );
      },
      async forMessage(type, messageId) {
        return (
          (
            await rows(
              "SELECT 1 FROM messaging_events WHERE tenant_id=$1 AND type=$2 AND details->>'messageId'=$3 LIMIT 1",
              [tenantId, type, messageId],
            )
          ).length > 0
        );
      },
    },
    documents: {
      async forThreads(threadIds) {
        if (!threadIds.length) return [];

        return (
          await rows(
            `SELECT id,message_id,thread_id,provider_attachment_id,filename,mime_type,size,sha256,family_key,version,
              previous_id,duplicate_of,state,failure,attempts,retain_until,purged_at,created_at,updated_at
            FROM messaging_documents WHERE tenant_id=$1 AND thread_id=ANY($2::uuid[]) ORDER BY created_at,id`,
            [tenantId, threadIds],
          )
        ).map(document);
      },
      async insert(d) {
        const result = await tx.query(
          `INSERT INTO messaging_documents(tenant_id,id,message_id,thread_id,provider_attachment_id,filename,mime_type,
            size,sha256,family_key,version,previous_id,duplicate_of,state,failure,attempts,retain_until,purged_at,
            created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
          ON CONFLICT (tenant_id,message_id,provider_attachment_id) DO NOTHING`,
          [
            tenantId,
            d.id,
            d.messageId,
            d.threadId,
            d.providerAttachmentId,
            d.filename,
            d.mimeType,
            d.size,
            d.sha256,
            d.familyKey,
            d.version,
            d.previousId,
            d.duplicateOf,
            d.state,
            d.failure,
            d.attempts,
            d.retainUntil,
            d.purgedAt,
            d.createdAt,
            d.updatedAt,
          ],
        );

        return (result.rowCount ?? 0) > 0;
      },
      async purgeForMessage(messageId, at) {
        await tx.query(
          `UPDATE messaging_documents SET content=NULL,representation=NULL,purged_at=$3,updated_at=$3
          WHERE tenant_id=$1 AND message_id=$2 AND purged_at IS NULL`,
          [tenantId, messageId, at],
        );
      },
    },
    facts: {
      async toReview(threadIds) {
        if (!threadIds.length) return new Map();

        return new Map(
          (
            await rows(
              `SELECT d.thread_id,count(*)::integer AS count FROM messaging_facts f
              JOIN messaging_documents d ON d.tenant_id=f.tenant_id AND d.id=f.document_id
              WHERE f.tenant_id=$1 AND d.thread_id=ANY($2::uuid[]) AND f.status IN ('proposed','needs_correction')
              GROUP BY d.thread_id`,
              [tenantId, threadIds],
            )
          ).map((row) => [row.thread_id as string, row.count as number]),
        );
      },
      async toReviewByDocument(documentIds) {
        if (!documentIds.length) return new Map();

        return new Map(
          (
            await rows(
              `SELECT document_id,count(*)::integer AS count FROM messaging_facts
              WHERE tenant_id=$1 AND document_id=ANY($2::uuid[]) AND status IN ('proposed','needs_correction')
              GROUP BY document_id`,
              [tenantId, documentIds],
            )
          ).map((row) => [row.document_id as string, row.count as number]),
        );
      },
    },
    reading: documentReading(tx, tenantId),
    outbound: outboundRepository(tx, tenantId),
    commands: {
      async get(id) {
        const [row] = await rows(
          'SELECT digest,result FROM messaging_commands WHERE tenant_id=$1 AND id=$2',
          [tenantId, id],
        );

        return row
          ? { digest: row.digest as string, result: row.result as unknown }
          : null;
      },
      async save(id, digest, result) {
        await tx.query(
          'INSERT INTO messaging_commands(tenant_id,id,digest,result) VALUES($1,$2,$3,$4)',
          [tenantId, id, digest, result],
        );
      },
    },
    audit: (entry) => log.append(entry),
  };
}

/**
 * Persists messaging records in tenant transactions with forced RLS. Audit entries are written
 * through the same connection, so they commit or roll back with the change.
 */
export function createMessagingStore(
  db: TenantDatabase,
  audit: (db: TenantDatabase) => AuditLog,
): MessagingStore {
  return {
    transaction: (tenantId, operation) =>
      db.transaction(tenantId, async (tx) => {
        const scoped: TenantDatabase = {
          transaction: async (_tenant, fn) => fn(tx),
        };

        return operation(repositories(tx, tenantId, audit(scoped)));
      }),
    scopes: () =>
      db.transaction(discoveryTenant, async (tx) =>
        (
          await tx.query<{ tenant_id: string; principal_id: string }>(
            'SELECT tenant_id,principal_id FROM messaging_sync_scopes()',
          )
        ).rows.map((row) => ({
          tenantId: row.tenant_id,
          principalId: row.principal_id,
        })),
      ),
  };
}

/** Removes message text and attachment content past their retention, across workspaces. */
export async function purgeExpiredMessaging(db: TenantDatabase, batch = 200) {
  return db.transaction(discoveryTenant, async (tx) =>
    Number(
      (
        await tx.query<{ purged: number }>(
          'SELECT purge_expired_messaging($1) AS purged',
          [batch],
        )
      ).rows[0]?.purged ?? 0,
    ),
  );
}
