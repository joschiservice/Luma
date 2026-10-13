import type { AuditEntry } from '@luma/audit';
import type { Permission, TenantContext } from '@luma/identity';
import {
  IdentityError,
  MembershipSuspendedError,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import { canonicalJson } from '@luma/platform';

import { consequentialReasons } from '../domain/consequential.js';
import type { Mailbox, MailboxRule } from '../domain/mailbox.js';
import type { RecordState, ReplyBasis } from '../domain/replies.js';
import {
  composeReply,
  liveStates,
  replyActions,
  replySubject,
  stateMessages,
} from '../domain/replies.js';
import type { Address } from '../domain/threads.js';
import type { Ingest } from './ingest.js';
import type {
  MailboxConnections,
  MessageReader,
  RecordDirectory,
} from './ports.js';
import type {
  RecordStates,
  ReplyAction,
  ReplyAdmission,
  ReplyExecution,
  ReplyMessage,
} from './reply-ports.js';
import type {
  EventType,
  MessageRow,
  MessagingStore,
  MessagingTransaction,
  OutboundRow,
  ThreadRow,
} from './store.js';
import { outboundView, recordKey } from './views.js';

export interface ReplyDependencies {
  store: MessagingStore;
  connections: MailboxConnections;
  directory: RecordDirectory;
  /** Without it, drafts state that no linked record could be confirmed. */
  records?: RecordStates | undefined;
  /** Without it, replies are drafted but cannot be sent. */
  admission?: ReplyAdmission | null | undefined;
  /** Reads threads to verify sends; without it, sends stay unconfirmed. */
  reader?: MessageReader | undefined;
  ingest: Ingest;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  /** Resolves the requester's current membership to send or check as them. */
  resolveContext(
    userId: string,
    tenantId: string,
    requestId: string,
  ): Promise<TenantContext>;
  now(): Date;
  id(): string;
  digest(value: unknown): string;
  uuid(name: string): string;
  log(message: string, error?: unknown): void;
  retentionDays?: number;
  /** Idempotent handoff to the record owner, after a verified send or failure. */
  settled?:
    | ((context: TenantContext, outbound: OutboundRow) => Promise<void>)
    | undefined;
  /** Rechecks record-owner authority and the reviewed state immediately before dispatch. */
  eligibleOwner?:
    | ((context: TenantContext, outbound: OutboundRow) => Promise<boolean>)
    | undefined;
}

export interface ReplyEdit {
  expectedRevision: number;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
}

const hour = 3_600_000;

/** A `sending` reply older than this without an execution record never reached dispatch. */
const sendingGraceMs = 2 * 60_000;

const observeOnlyReason =
  'Observe-only. Writes are off for this workspace or mailbox, so nothing was sent. Draft a new reply once writes are enabled.';

function conflict(message: string): never {
  throw new IdentityError(409, 'CONFLICT', message);
}

function notFound(message: string): never {
  throw new IdentityError(404, 'NOT_FOUND', message);
}

function unavailable(message: string): never {
  throw new IdentityError(503, 'SERVICE_UNAVAILABLE', message);
}

/** The exact content a requested reply binds; any change makes it a different reply. */
function replyContent(outbound: OutboundRow, providerThreadId: string) {
  const document = outbound.document;

  return {
    outboundId: outbound.id,
    connectionId: outbound.connectionId,
    thread: providerThreadId,
    to: document.to.map((a) => [a.address, a.name]),
    cc: document.cc.map((a) => [a.address, a.name]),
    subject: document.subject,
    text: document.text,
    inReplyTo: document.inReplyTo ?? null,
    references: document.references ?? [],
    attachments: document.attachments ?? [],
    procurement: document.procurement ?? null,
  };
}

/**
 * The action a requested reply asks Action Admission to perform. Parameters carry identities
 * and a digest of the content, never the text; the effect maps the stored reply at dispatch.
 */
function replyAction(
  outbound: OutboundRow,
  thread: Pick<ThreadRow, 'id' | 'providerThreadId'>,
  tenantId: string,
): ReplyAction {
  const document = outbound.document;

  return {
    schemaVersion: 1,
    id: outbound.actionId!,
    tenantId,
    capability: 'messages.send',
    capabilityVersion: '0',
    connectionId: outbound.connectionId,
    target: { kind: 'message_outbound', id: outbound.id },
    parameters: {
      outboundId: outbound.id,
      connectionId: outbound.connectionId,
      thread: thread.providerThreadId,
      contentDigest: document.contentDigest ?? null,
      recipients: document.to.length + document.cc.length,
    },
    preconditions: {
      evidenceRefs: [thread.id, outbound.id],
      validUntil: document.expiresAt!,
    },
    expectedPostcondition: { rfcMessageIdPrefix: `luma.${outbound.id}@` },
    risk: document.risk ?? 'high',
    proposedBy: { kind: 'user', id: outbound.requestedBy },
    expiresAt: document.expiresAt!,
  };
}

/** The stored message of a sent reply, found by the Message-ID the mailbox app derives. */
function sentMessage(messages: readonly MessageRow[], outboundId: string) {
  const prefix = `luma.${outboundId}@`;

  return messages.find((m) => m.rfcMessageId?.toLowerCase().startsWith(prefix));
}

function basis(message: MessageRow): ReplyBasis {
  return {
    direction: message.direction,
    from: message.document.from,
    replyTo: message.document.replyTo,
    subject: message.document.subject,
    text: message.text,
    rfcMessageId: message.rfcMessageId,
    references: message.document.references,
    receivedAt: message.receivedAt,
  };
}

/**
 * Owns replies: drafts composed from linked records with citations, edits, the consequential
 * policy, approval by someone else, a single send through Action Admission and verification by
 * a fresh read of the thread. Uncertain sends are only ever checked by reading.
 */
export function createReplies(deps: ReplyDependencies) {
  async function authorize(context: TenantContext, permission: Permission) {
    requireTenant(context, context.tenantId);
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    requirePermission(fresh, permission);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Sign in again to continue.');

    return fresh;
  }

  function audit(
    context: TenantContext | null,
    tenantId: string,
    input: {
      type: string;
      key: string;
      outbound: OutboundRow;
      details: Record<string, string>;
    },
  ): AuditEntry {
    return {
      id: deps.id(),
      tenantId,
      eventKey: `messaging:${input.type}:${input.key}`,
      eventType: `messaging.${input.type}`,
      schemaVersion: 1,
      occurredAt: deps.now().toISOString(),
      actor: context
        ? { kind: 'user', id: context.actor.id }
        : { kind: 'service', id: 'messaging' },
      correlationId: context?.requestId ?? input.outbound.id,
      proposalId: input.outbound.id,
      actionHash: deps.digest({ type: input.type, ...input.details }),
      connectionId: input.outbound.connectionId,
      evidenceRefs: [input.outbound.threadId, input.outbound.id],
      details: {
        outboundId: input.outbound.id,
        threadId: input.outbound.threadId,
        ...input.details,
      },
    };
  }

  async function event(
    tx: MessagingTransaction,
    outbound: OutboundRow,
    type: EventType,
    actor: { kind: 'user' | 'luma'; id: string },
    details: Record<string, string>,
  ) {
    await tx.events.insert({
      id: deps.id(),
      threadId: outbound.threadId,
      type,
      actor,
      details: { outboundId: outbound.id, ...details },
      occurredAt: deps.now().toISOString(),
    });
  }

  /** Saves a change with a new revision; returns the saved row. */
  async function save(
    tx: MessagingTransaction,
    outbound: OutboundRow,
    patch: Partial<Pick<OutboundRow, 'state' | 'actionId'>> & {
      document?: Partial<OutboundRow['document']>;
    },
  ) {
    const next: OutboundRow = {
      ...outbound,
      ...(patch.state ? { state: patch.state } : {}),
      ...(patch.actionId !== undefined ? { actionId: patch.actionId } : {}),
      document: { ...outbound.document, ...patch.document },
      revision: outbound.revision + 1,
      updatedAt: deps.now().toISOString(),
    };
    await tx.outbound.update(next);

    return next;
  }

  async function load(tenantId: string, outboundId: string) {
    const outbound = await deps.store.transaction(tenantId, (tx) =>
      tx.outbound.get(outboundId),
    );
    if (!outbound) notFound('Reply not found');

    return outbound!;
  }

  async function present(context: TenantContext, outboundId: string) {
    return outboundView(await load(context.tenantId, outboundId), context);
  }

  async function sendingConnection(
    context: TenantContext,
    connectionId: string,
  ) {
    const connection = (await deps.connections.list(context)).find(
      (c) => c.id === connectionId,
    );
    if (!connection || connection.status !== 'active' || !connection.canSend)
      conflict(
        'This mailbox can’t send replies. Reconnect it with permission to send in Apps.',
      );
  }

  /** Runs a command once per ID; an exact retry returns false, a changed one fails. */
  async function once(
    tx: MessagingTransaction,
    context: TenantContext,
    id: string,
    request: unknown,
  ) {
    const digest = deps.digest({ actorId: context.actor.id, request });
    const prior = await tx.commands.get(id);
    if (prior) {
      if (prior.digest !== digest)
        conflict(
          'This request ID was already used for another change. Refresh and try again.',
        );

      return false;
    }
    await tx.commands.save(id, digest, { ok: true });

    return true;
  }

  /** Records what execution reported. Only replies still in flight change. */
  async function settle(
    context: TenantContext,
    outboundId: string,
    execution: ReplyExecution,
  ) {
    if (execution.state === 'not_started') return;
    await deps.store.transaction(context.tenantId, async (tx) => {
      const current = await tx.outbound.get(outboundId, true);
      if (!current || !liveStates.includes(current.state)) return;
      if (
        execution.state === 'not_executed' ||
        execution.state === 'withheld'
      ) {
        const reason =
          execution.state === 'withheld' ? execution.reason : observeOnlyReason;
        const saved = await save(tx, current, {
          state: 'withheld',
          document: { stateReason: reason },
        });
        await event(
          tx,
          saved,
          'reply_withheld',
          { kind: 'luma', id: 'luma' },
          {
            reason:
              execution.state === 'withheld' ? 'withheld' : 'observe_only',
          },
        );
        await tx.audit(
          audit(null, context.tenantId, {
            type: 'reply.withheld',
            key: outboundId,
            outbound: saved,
            details: {
              reason:
                execution.state === 'withheld' ? 'withheld' : 'observe_only',
            },
          }),
        );

        return;
      }
      if (execution.state === 'failed') {
        const saved = await save(tx, current, {
          state: 'failed',
          document: { stateReason: execution.reason },
        });
        await tx.audit(
          audit(null, context.tenantId, {
            type: 'reply.failed',
            key: outboundId,
            outbound: saved,
            details: {},
          }),
        );

        return;
      }
      const found =
        execution.state === 'verified'
          ? sentMessage(
              await tx.messages.forThread(current.threadId),
              outboundId,
            )
          : undefined;
      if (!found) {
        if (current.state !== 'uncertain')
          await save(tx, current, {
            state: 'uncertain',
            document: { stateReason: null },
          });

        return;
      }
      await tx.outbound.markMessageSent(found.id);
      const saved = await save(tx, current, {
        state: 'sent',
        document: { sentMessageId: found.id, stateReason: null },
      });
      await tx.audit(
        audit(null, context.tenantId, {
          type: 'reply.sent',
          key: outboundId,
          outbound: saved,
          details: { messageId: found.id },
        }),
      );
    });
  }

  async function notifyOwner(context: TenantContext, outboundId: string) {
    if (!deps.settled) return;
    const outbound = await load(context.tenantId, outboundId);
    if (!outbound.document.procurement) return;
    if (
      outbound.document.ownerHandoffAt &&
      ['sent', 'failed'].includes(outbound.state)
    )
      return;
    try {
      await deps.settled(context, outbound);
    } catch (error) {
      if (
        !(error instanceof IdentityError) ||
        error.statusCode !== 409 ||
        outbound.state !== 'sent'
      )
        throw error;
      await deps.store.transaction(context.tenantId, async (tx) => {
        const current = await tx.outbound.get(outboundId, true);
        if (current?.state === 'sent')
          await save(tx, current, {
            document: {
              stateReason:
                'The email was sent, but the order or its deadline changed before the follow-up could be recorded. Review the order.',
              ownerHandoffAt: deps.now().toISOString(),
            },
          });
      });

      return;
    }
    if (['sent', 'failed'].includes(outbound.state))
      await deps.store.transaction(context.tenantId, async (tx) => {
        const current = await tx.outbound.get(outboundId, true);
        if (current && current.state === outbound.state)
          await save(tx, current, {
            document: { ownerHandoffAt: deps.now().toISOString() },
          });
      });
  }

  /** Sends once as `context`, which must be the requester. */
  async function dispatch(context: TenantContext, outboundId: string) {
    const admission = deps.admission!;
    const outbound = await deps.store.transaction(
      context.tenantId,
      async (tx) => {
        const current = await tx.outbound.get(outboundId, true);
        if (
          current &&
          (current.state === 'approved' ||
            current.state === 'approval_required')
        )
          return save(tx, current, { state: 'sending' });

        return current;
      },
    );
    if (!outbound?.actionId) return;
    let execution: ReplyExecution;
    try {
      execution = await admission.execute(context, outboundId);
    } catch (error) {
      deps.log('A reply could not be sent; checking its state.', error);
      execution = await admission
        .get(context, outbound.actionId)
        .catch(() => ({ state: 'uncertain' }) as const);
      if (execution.state === 'not_started')
        execution = {
          state: 'failed',
          reason: 'The reply could not be sent. Nothing was dispatched.',
        };
    }
    await settle(context, outboundId, execution);
    await notifyOwner(context, outboundId);
  }

  /** Reads the requester's current membership; suspended requesters block sends and checks. */
  async function requester(
    outbound: OutboundRow,
    tenantId: string,
    requestId: string,
  ) {
    return deps
      .resolveContext(outbound.requestedBy, tenantId, requestId)
      .catch((error: unknown) => {
        if (error instanceof MembershipSuspendedError)
          conflict(
            'The person who requested this reply can’t access this workspace right now. Luma checks it after their access is restored.',
          );
        throw error;
      });
  }

  async function reconcile(
    context: TenantContext,
    outbound: OutboundRow,
  ): Promise<ReplyExecution> {
    if (!outbound.actionId) return { state: 'not_started' };

    return deps.admission!.reconcile(context, outbound.actionId);
  }

  /** Reads every page of a thread and stores new messages; false when the read failed. */
  async function readThread(
    context: TenantContext,
    tx: { thread: ThreadRow; mailbox: Mailbox; rules: MailboxRule[] },
  ) {
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const result = await deps.reader!.thread(
        context,
        tx.thread.connectionId,
        {
          thread: {
            externalId:
              tx.thread.document.resolvedProviderThreadId ??
              tx.thread.providerThreadId,
            scopeKey: '',
          },
          cursor,
        },
      );
      if (!result.ok) return false;
      await deps.ingest(context, tx.mailbox, tx.rules, result.items);
      if (!result.nextCursor) return true;
      cursor = result.nextCursor;
    }

    return true;
  }

  /**
   * The reply an action belongs to and the message it sends, for execution adapters; null
   * when the stored content no longer matches the digest the action binds.
   */
  async function forAction(context: TenantContext, outboundId: string) {
    return deps.store.transaction(context.tenantId, async (tx) => {
      const outbound = await tx.outbound.get(outboundId);
      const thread = outbound ? await tx.threads.get(outbound.threadId) : null;
      if (
        !outbound?.actionId ||
        !thread ||
        !outbound.document.contentDigest ||
        deps.digest(replyContent(outbound, thread.providerThreadId)) !==
          outbound.document.contentDigest
      )
        return null;
      const document = outbound.document;
      const message: ReplyMessage = {
        outboundId: outbound.id,
        thread:
          thread.providerThreadId.startsWith('outbound:') &&
          !thread.document.resolvedProviderThreadId
            ? null
            : {
                externalId:
                  thread.document.resolvedProviderThreadId ??
                  thread.providerThreadId,
                scopeKey: '',
              },
        inReplyTo: document.inReplyTo ?? null,
        references: document.references ?? [],
        to: document.to,
        cc: document.cc,
        subject: document.subject,
        text: document.text,
        attachments: document.attachments ?? [],
      };

      return {
        state: outbound.state,
        action: replyAction(outbound, thread, context.tenantId),
        message,
      };
    });
  }

  return {
    /**
     * Composes a new message, or a reply on an existing operational thread, from a record
     * owner's deterministic content. Linked records must be readable. Attachments and owner
     * metadata become part of the exact content that approval binds.
     */
    async compose(
      context: TenantContext,
      input: {
        id: string;
        connectionId: string;
        threadId?: string;
        to: Address[];
        subject: string;
        text: string;
        language: 'en' | 'de';
        records: { kind: 'purchase_order' | 'supplier'; id: string }[];
        attachments?: { filename: string; mimeType: string; base64: string }[];
        procurement: NonNullable<OutboundRow['document']['procurement']>;
      },
    ) {
      context = await authorize(context, 'messages.send');
      requirePermission(context, 'procurement.manage');
      requirePermission(context, 'procurement.read');
      await sendingConnection(context, input.connectionId);
      const labels = await deps.directory.labels(context, input.records);
      if (input.records.some((ref) => !labels.has(recordKey(ref))))
        notFound('Linked record not found');
      if (
        !input.to.length ||
        input.to.some((a) => !/^[^\s@<>]+@[^\s@<>]+$/.test(a.address)) ||
        /[\r\n]/.test(input.subject)
      )
        conflict('Invalid message');
      const requestDigest = deps.digest({
        ...input,
        actorId: context.actor.id,
      });
      const outbound = await deps.store.transaction(
        context.tenantId,
        async (tx) => {
          if (
            !(await once(tx, context, input.id, { compose: requestDigest }))
          ) {
            const prior = await tx.outbound.get(input.id);
            if (!prior) conflict('Message draft not found');

            return prior!;
          }
          const mailbox = await tx.mailboxes.get(input.connectionId);
          if (!mailbox) notFound('Mailbox not found');
          const at = deps.now().toISOString();
          const rules = await tx.rules.active(input.connectionId);
          const supplierAddress = input.to[0]!.address.toLowerCase();
          const domain = supplierAddress.slice(
            supplierAddress.lastIndexOf('@') + 1,
          );
          const covered = rules.some(
            (rule) =>
              (rule.kind === 'sender_address' &&
                rule.value === supplierAddress) ||
              (rule.kind === 'sender_domain' &&
                (domain === rule.value || domain.endsWith(`.${rule.value}`))) ||
              (rule.kind === 'recipient_address' &&
                rule.value === mailbox!.address),
          );
          if (!covered) {
            requirePermission(context, 'messages.manage');
            await tx.rules.insert({
              id: deps.id(),
              connectionId: input.connectionId,
              kind: 'sender_address',
              value: supplierAddress,
              party: {
                kind: 'supplier',
                supplierId: input.procurement.supplierId,
              },
              backfilledAt: null,
              createdBy: context.actor.id,
              createdAt: at,
            });
            await tx.mailboxes.update({
              ...mailbox!,
              hintAt: at,
              dueAt: at,
              updatedAt: at,
            });
          }
          const threadId =
            input.threadId ??
            deps.uuid(`compose-thread:${context.tenantId}:${input.id}`);
          let thread = input.threadId ? await tx.threads.get(threadId) : null;
          if (
            input.threadId &&
            (!thread || thread.connectionId !== input.connectionId)
          )
            notFound('Thread not found');
          if (!thread) {
            thread = {
              id: threadId,
              connectionId: input.connectionId,
              providerThreadId: `outbound:${input.id}`,
              subject: input.subject,
              document: {
                participants: input.to,
                correspondent: input.to[0] ?? null,
                snippet: '',
                attachmentCount: input.attachments?.length ?? 0,
              },
              status: 'open',
              ownerId: context.actor.id,
              manualDueAt: null,
              replyDueAt: null,
              lastMessageAt: at,
              lastInboundAt: null,
              lastOutboundAt: null,
              messageCount: 0,
              revision: 1,
              createdAt: at,
              updatedAt: at,
            };
            await tx.threads.insert(thread);
          }
          const messages = await tx.messages.forThread(threadId);
          const latest = messages
            .filter((m) => !m.document.deliveryFailure)
            .at(-1);
          const lastInbound = messages
            .filter(
              (m) => m.direction === 'inbound' && !m.document.deliveryFailure,
            )
            .at(-1);
          const recipient =
            lastInbound?.document.replyTo[0] ?? lastInbound?.document.from;
          const to =
            recipient && recipient.address !== mailbox!.address
              ? [recipient]
              : input.to;
          const row: OutboundRow = {
            id: input.id,
            threadId,
            connectionId: input.connectionId,
            document: {
              to,
              cc: [],
              subject: input.threadId
                ? replySubject(latest?.document.subject ?? thread.subject)
                : input.subject,
              text: input.text,
              language: input.language,
              references: latest
                ? [
                    ...latest.document.references,
                    ...(latest.rfcMessageId ? [latest.rfcMessageId] : []),
                  ].slice(-100)
                : [],
              inReplyTo: latest?.rfcMessageId ?? null,
              attachments: input.attachments ?? [],
              procurement: input.procurement,
              composeDigest: requestDigest,
              attachmentsExpireAt: new Date(
                deps.now().getTime() + (deps.retentionDays ?? 365) * 86_400_000,
              ).toISOString(),
              consequential: ['workspace_policy'],
              citations: [],
            },
            state: 'draft',
            actionId: null,
            requestedBy: context.actor.id,
            revision: 1,
            createdAt: at,
            updatedAt: at,
          };
          await tx.outbound.insert(row);
          for (const ref of input.records) {
            const existing = await tx.links.latest(threadId, ref.kind, ref.id);
            if (existing?.state === 'active') continue;
            if (existing)
              conflict(
                'The operational record was removed from this thread. Link it again before drafting.',
              );
            await tx.links.insert({
              id: deps.id(),
              threadId,
              kind: ref.kind,
              recordId: ref.id,
              method: 'manual',
              state: 'active',
              evidence: {
                messageId: null,
                ruleId: null,
                text: null,
                span: null,
              },
              createdBy: context.actor.id,
              createdAt: at,
              removedBy: null,
              removedAt: null,
            });
          }
          await tx.audit(
            audit(context, context.tenantId, {
              type: 'reply.drafted',
              key: input.id,
              outbound: row,
              details: {
                language: input.language,
                attachments: String(input.attachments?.length ?? 0),
              },
            }),
          );

          return row;
        },
      );

      return outboundView(outbound, context);
    },
    /** Reads one person's draft or a requested message without exposing attachment bytes. */
    /** Reads the exact persisted order PDF for review, restricted to its linked tenant order. */
    async supplierAttachment(
      context: TenantContext,
      purchaseOrderId: string,
      outboundId: string,
    ) {
      context = await authorize(context, 'messages.read');
      requirePermission(context, 'procurement.read');

      return deps.store.transaction(context.tenantId, async (tx) => {
        const row = await tx.outbound.get(outboundId);
        const attached = row?.document.attachments?.find(
          (a) => a.mimeType === 'application/pdf',
        );
        if (
          !row ||
          row.document.procurement?.purchaseOrderId !== purchaseOrderId ||
          !attached
        )
          notFound('Order document not found');

        return attached!;
      });
    },
    /** Reads stored supplier work on threads linked to one purchase order, for its owner. */
    async supplierWork(context: TenantContext, purchaseOrderId: string) {
      context = await authorize(context, 'messages.read');
      requirePermission(context, 'procurement.read');

      return deps.store.transaction(context.tenantId, async (tx) => {
        const threads = await tx.threads.forRecord(
          'purchase_order',
          purchaseOrderId,
        );
        const rows = (
          await Promise.all(
            threads.map((thread) => tx.outbound.forThread(thread.id)),
          )
        ).flat();

        return rows
          .filter(
            (row) =>
              row.document.procurement?.purchaseOrderId === purchaseOrderId,
          )
          .map((row) => ({
            outbound: outboundView(row, context),
            work: row.document.procurement!,
          }));
      });
    },
    async get(context: TenantContext, outboundId: string) {
      context = await authorize(context, 'messages.read');

      return present(context, outboundId);
    },
    /**
     * Drafts a reply to the latest inbound message from the current state of the thread's
     * linked records, citing each one. The ID identifies the draft; an exact retry returns it.
     */
    async draft(
      context: TenantContext,
      threadId: string,
      input: { id: string },
    ) {
      context = await authorize(context, 'messages.send');
      const prior = await deps.store.transaction(context.tenantId, (tx) =>
        tx.outbound.get(input.id),
      );
      if (prior) {
        if (
          prior.threadId !== threadId ||
          prior.requestedBy !== context.actor.id
        )
          conflict('This request ID was already used. Refresh and try again.');

        return outboundView(prior, context);
      }
      const data = await deps.store.transaction(
        context.tenantId,
        async (tx) => {
          const thread = await tx.threads.get(threadId);
          if (!thread) notFound('Thread not found');

          return {
            thread: thread!,
            messages: await tx.messages.forThread(threadId),
            links: (await tx.links.forThreads([threadId])).filter(
              (link) => link.state === 'active',
            ),
            mailbox: await tx.mailboxes.get(thread!.connectionId),
          };
        },
      );
      if (!data.mailbox) notFound('Mailbox not found');
      await sendingConnection(context, data.thread.connectionId);
      const inbound = data.messages.filter((m) => m.direction === 'inbound');
      const latestInbound = inbound.at(-1);
      if (!latestInbound)
        conflict('There is no message to reply to in this thread.');
      const refs = data.links.map((link) => ({
        kind: link.kind,
        id: link.recordId,
      }));
      const [labels, states] = refs.length
        ? await Promise.all([
            deps.directory.labels(context, refs),
            deps.records?.read(context, refs) ?? new Map<string, RecordState>(),
          ])
        : [new Map<string, string>(), new Map<string, RecordState>()];
      const now = deps.now();
      const composed = composeReply({
        latestInbound: basis(latestInbound!),
        latest: basis(data.messages.at(-1)!),
        mailboxAddress: data.mailbox!.address,
        records: refs.map((ref) => ({
          ...ref,
          label: labels.get(recordKey(ref)) ?? null,
          state: states.get(recordKey(ref)) ?? null,
        })),
        now,
      });
      if (!composed.to.length)
        conflict('The message has no address Luma can reply to.');
      const at = now.toISOString();
      const outbound: OutboundRow = {
        id: input.id,
        threadId,
        connectionId: data.thread.connectionId,
        document: {
          to: composed.to,
          cc: composed.cc,
          subject: composed.subject,
          text: composed.text,
          citations: composed.citations,
          consequential: consequentialReasons({
            subject: composed.subject,
            text: composed.text,
            approveAll: data.mailbox!.settings.approveAll,
          }),
          language: composed.language,
          inReplyTo: composed.inReplyTo,
          references: composed.references,
          stateReason: null,
          decisionId: null,
          approverId: null,
          sentMessageId: null,
        },
        state: 'draft',
        actionId: null,
        requestedBy: context.actor.id,
        revision: 1,
        createdAt: at,
        updatedAt: at,
      };
      await deps.store.transaction(context.tenantId, async (tx) => {
        await tx.outbound.insert(outbound);
        await tx.audit(
          audit(context, context.tenantId, {
            type: 'reply.drafted',
            key: input.id,
            outbound,
            details: {
              citations: String(composed.citations.length),
              missing: String(
                composed.citations.filter((c) => c.freshness !== 'fresh')
                  .length,
              ),
              language: composed.language,
            },
          }),
        );
      });

      return outboundView(outbound, context);
    },
    /**
     * Changes a draft when `expectedRevision` is current and recomputes why it needs approval.
     * Citations whose statement no longer appears in the text are dropped.
     */
    async update(context: TenantContext, outboundId: string, input: ReplyEdit) {
      context = await authorize(context, 'messages.send');
      await deps.store.transaction(context.tenantId, async (tx) => {
        const outbound = await tx.outbound.get(outboundId, true);
        if (!outbound) notFound('Reply not found');
        if (outbound!.requestedBy !== context.actor.id)
          conflict('Only the person who drafted this reply can change it.');
        if (outbound!.state !== 'draft')
          conflict('Only drafts can change. Draft a new reply instead.');
        if (outbound!.revision !== input.expectedRevision)
          conflict('This reply changed. Refresh and try again.');
        if (outbound!.document.procurement)
          requirePermission(context, 'procurement.manage');
        const mailbox = await tx.mailboxes.get(outbound!.connectionId);
        const known = new Map(
          [...outbound!.document.to, ...outbound!.document.cc].map((a) => [
            a.address,
            a.name,
          ]),
        );
        const addresses = (list: string[], skip: Set<string>) => {
          const result: Address[] = [];
          for (const value of list) {
            const address = value.trim().toLowerCase();
            if (skip.has(address)) continue;
            skip.add(address);
            result.push({ address, name: known.get(address) ?? null });
          }

          return result;
        };
        const seen = new Set<string>();
        const to = addresses(input.to, seen);
        const cc = addresses(input.cc, seen);
        if (!to.length) conflict('Add at least one recipient.');
        const subject = input.subject.replace(/[\r\n]+/g, ' ').trim();
        const text = input.text.trim();
        const saved = await save(tx, outbound!, {
          document: {
            to,
            cc,
            subject,
            text,
            citations: (outbound!.document.citations ?? []).filter((c) =>
              text.includes(c.statement),
            ),
            consequential: consequentialReasons({
              subject,
              text,
              approveAll:
                !!outbound!.document.procurement ||
                (mailbox?.settings.approveAll ?? false),
            }),
          },
        });
        await tx.audit(
          audit(context, context.tenantId, {
            type: 'reply.edited',
            key: `${outboundId}:${saved.revision}`,
            outbound: saved,
            details: { revision: String(saved.revision) },
          }),
        );
      });

      return present(context, outboundId);
    },
    /**
     * Requests the reply: binds its exact content to a send action and evaluates policy.
     * Consequential replies wait for approval by someone else; others are sent at once.
     */
    async request(
      context: TenantContext,
      outboundId: string,
      input: { id: string },
    ) {
      context = await authorize(context, 'messages.send');
      if (!deps.admission)
        unavailable('Sending replies is unavailable on this server.');
      const outbound = await load(context.tenantId, outboundId);
      if (outbound.document.procurement)
        requirePermission(context, 'procurement.manage');
      await sendingConnection(context, outbound.connectionId);
      const prepared = await deps.store.transaction(
        context.tenantId,
        async (tx) => {
          if (
            !(await once(tx, context, input.id, {
              command: 'request',
              outboundId,
            }))
          )
            return null;
          const current = await tx.outbound.get(outboundId, true);
          if (!current) notFound('Reply not found');
          if (current!.requestedBy !== context.actor.id)
            conflict('Only the person who drafted this reply can send it.');
          if (current!.state !== 'draft')
            conflict('This reply was already requested. Refresh it.');
          const thread = await tx.threads.get(current!.threadId);
          const mailbox = await tx.mailboxes.get(current!.connectionId);
          if (!thread || !mailbox) notFound('Thread not found');
          const reasons = consequentialReasons({
            subject: current!.document.subject,
            text: current!.document.text,
            approveAll:
              !!current!.document.procurement || mailbox!.settings.approveAll,
          });
          const now = deps.now();
          const pending: OutboundRow = {
            ...current!,
            actionId: deps.uuid(
              `reply-action:${context.tenantId}:${current!.id}`,
            ),
          };
          const saved = await save(tx, current!, {
            state: 'approval_required',
            actionId: pending.actionId,
            document: {
              consequential: reasons,
              risk: reasons.length ? 'high' : 'low',
              contentDigest: deps.digest(
                replyContent(pending, thread!.providerThreadId),
              ),
              requestedAt: now.toISOString(),
              expiresAt: new Date(now.getTime() + 24 * hour).toISOString(),
              stateReason: null,
            },
          });
          await event(
            tx,
            saved,
            'reply_requested',
            {
              kind: 'user',
              id: context.actor.id,
            },
            {
              risk: saved.document.risk!,
              reasons: reasons.join(','),
            },
          );
          await tx.audit(
            audit(context, context.tenantId, {
              type: 'reply.requested',
              key: input.id,
              outbound: saved,
              details: {
                actionId: saved.actionId!,
                risk: saved.document.risk!,
                reasons: reasons.join(','),
                contentDigest: saved.document.contentDigest!,
              },
            }),
          );

          return { outbound: saved, thread: thread! };
        },
      );
      if (!prepared) return present(context, outboundId);
      let decision;
      try {
        decision = await deps.admission!.prepare(
          context,
          outboundId,
          replyAction(prepared.outbound, prepared.thread, context.tenantId),
        );
      } catch (error) {
        deps.log('A reply send could not be prepared.', error);
        await deps.store.transaction(context.tenantId, async (tx) => {
          const current = await tx.outbound.get(outboundId, true);
          if (current?.state === 'approval_required')
            await save(tx, current, {
              state: 'failed',
              document: {
                stateReason:
                  'Sending could not be requested. Nothing was sent.',
              },
            });
        });
        unavailable(
          'Sending could not be requested. Nothing was sent. Try again.',
        );
      }
      const saved = await deps.store.transaction(
        context.tenantId,
        async (tx) => {
          const current = (await tx.outbound.get(outboundId, true))!;

          return save(tx, current, {
            ...(decision.outcome === 'denied'
              ? { state: 'failed' as const }
              : decision.outcome === 'allowed'
                ? { state: 'approved' as const }
                : {}),
            document: {
              decisionId: decision.id,
              permission: decision.permission ?? null,
              ...(decision.outcome === 'denied'
                ? {
                    stateReason:
                      'Policy or the mailbox no longer allows this reply. Nothing was sent.',
                  }
                : {}),
            },
          });
        },
      );
      if (
        saved.state === 'approved' ||
        (saved.state === 'approval_required' &&
          (await deps.admission!.writeMode(context, saved.connectionId)) ===
            'observe_only')
      )
        await dispatch(context, outboundId);

      return present(context, outboundId);
    },
    /**
     * Approves or rejects a reply. The approver must be someone other than the requester; Luma
     * then sends it once as the requester, whose membership is checked again.
     */
    async decide(
      context: TenantContext,
      outboundId: string,
      input: { decisionId: string; outcome: 'approved' | 'rejected' },
    ) {
      context = await authorize(context, 'decisions.respond');
      if (!deps.admission)
        unavailable('Sending replies is unavailable on this server.');
      const outbound = await load(context.tenantId, outboundId);
      const view = outboundView(outbound, context);
      if (!view.canApprove || outbound.document.decisionId !== input.decisionId)
        conflict(
          'This reply changed, expired or needs a different approver. Refresh it.',
        );
      await deps.admission!.respond(
        context,
        input.decisionId,
        input.outcome,
        outbound.document.expiresAt!,
      );
      const decided = await deps.store.transaction(
        context.tenantId,
        async (tx) => {
          const current = (await tx.outbound.get(outboundId, true))!;
          if (current.state !== 'approval_required') return current;
          const saved = await save(tx, current, {
            state: input.outcome === 'approved' ? 'approved' : 'rejected',
            document: { approverId: context.actor.id },
          });
          await event(
            tx,
            saved,
            input.outcome === 'approved' ? 'reply_approved' : 'reply_rejected',
            { kind: 'user', id: context.actor.id },
            {},
          );
          await tx.audit(
            audit(context, context.tenantId, {
              type: `reply.${input.outcome}`,
              key: input.decisionId,
              outbound: saved,
              details: { decisionId: input.decisionId },
            }),
          );

          return saved;
        },
      );
      if (decided.state === 'approved') {
        // Approval gives the approver no authority to send; the requester's current
        // membership is resolved and admission checks it again.
        try {
          await dispatch(
            await requester(decided, context.tenantId, `reply:${outboundId}`),
            outboundId,
          );
        } catch (error) {
          deps.log(
            'An approved reply was not sent yet; retrying later.',
            error,
          );
        }
      }

      return present(context, outboundId);
    },
    /** Sends an approved reply now. Only the requester can; a repeat returns the recorded state. */
    async send(
      context: TenantContext,
      outboundId: string,
      input: { id: string },
    ) {
      context = await authorize(context, 'messages.send');
      if (!deps.admission)
        unavailable('Sending replies is unavailable on this server.');
      const outbound = await load(context.tenantId, outboundId);
      if (['sending', 'uncertain', 'sent'].includes(outbound.state))
        return outboundView(outbound, context);
      if (!outboundView(outbound, context).canSend)
        conflict('Only the requester can send an approved reply.');
      await deps.store.transaction(context.tenantId, (tx) =>
        once(tx, context, input.id, { command: 'send', outboundId }),
      );
      await dispatch(context, outboundId);

      return present(context, outboundId);
    },
    /**
     * Checks whether an unconfirmed reply was sent by reading the thread; never sends again.
     * Reading is safe to repeat, so the check needs no command ID.
     */
    async check(context: TenantContext, outboundId: string) {
      context = await authorize(context, 'messages.send');
      if (!deps.admission)
        unavailable('Sending replies is unavailable on this server.');
      const outbound = await load(context.tenantId, outboundId);
      if (!['sending', 'uncertain'].includes(outbound.state))
        return outboundView(outbound, context);
      const principal = await requester(
        outbound,
        context.tenantId,
        `reply-check:${outboundId}`,
      );
      await settle(principal, outboundId, await reconcile(principal, outbound));
      await notifyOwner(principal, outboundId);

      return present(context, outboundId);
    },
    /**
     * Discards a draft or withdraws a reply waiting for approval. Without an approved send its
     * action is never eligible again, so nothing can be sent.
     */
    async discard(
      context: TenantContext,
      outboundId: string,
      input: { id: string },
    ) {
      context = await authorize(context, 'messages.send');
      await deps.store.transaction(context.tenantId, async (tx) => {
        const outbound = await tx.outbound.get(outboundId, true);
        if (!outbound) notFound('Reply not found');
        if (outbound!.state === 'discarded') return;
        if (outbound!.requestedBy !== context.actor.id)
          conflict('Only the person who drafted this reply can discard it.');
        if (!['draft', 'approval_required'].includes(outbound!.state))
          conflict(
            'Only drafts and replies waiting for approval can be discarded.',
          );
        if (
          !(await once(tx, context, input.id, {
            command: 'discard',
            outboundId,
          }))
        )
          return;
        const saved = await save(tx, outbound!, {
          state: 'discarded',
          document: { stateReason: null },
        });
        await tx.audit(
          audit(context, context.tenantId, {
            type: 'reply.discarded',
            key: input.id,
            outbound: saved,
            details: { from: outbound!.state },
          }),
        );
      });

      return present(context, outboundId);
    },
    /**
     * Replies that need a person, for Needs you: approvals, approved replies their requester
     * sends, and unconfirmed sends to check. Reads stored state only.
     */
    async pending(context: TenantContext) {
      context = await authorize(context, 'messages.read');
      const now = deps.now();
      const live = await deps.store.transaction(context.tenantId, (tx) =>
        tx.outbound.live(200),
      );

      return live.flatMap((outbound) => {
        const actions = replyActions(
          {
            state: outbound.state,
            requestedBy: outbound.requestedBy,
            expiresAt: outbound.document.expiresAt ?? null,
            approverId: outbound.document.approverId ?? null,
            permission: outbound.document.permission ?? null,
          },
          {
            id: context.actor.id,
            can: (permission) => context.permissions.has(permission),
          },
          now,
        );
        if (actions.state === 'expired') return [];
        if (
          actions.state === 'approved' &&
          outbound.requestedBy !== context.actor.id
        )
          return [];

        return [
          {
            outboundId: outbound.id,
            threadId: outbound.threadId,
            subject: outbound.document.subject,
            to: outbound.document.to.map((a) => a.address).join(', '),
            reasons: outbound.document.consequential ?? [],
            state: actions.state as
              'approval_required' | 'approved' | 'sending' | 'uncertain',
            requestedBy: outbound.requestedBy,
            requestedAt: outbound.document.requestedAt ?? outbound.updatedAt,
            expiresAt: outbound.document.expiresAt ?? null,
            response:
              actions.canApprove &&
              (!outbound.document.procurement ||
                context.permissions.has('procurement.manage'))
                ? ('decide' as const)
                : actions.canSend
                  ? ('run' as const)
                  : actions.canCheck
                    ? ('check' as const)
                    : outbound.requestedBy === context.actor.id &&
                        actions.state === 'approval_required'
                      ? ('awaiting_other' as const)
                      : ('view_only' as const),
          },
        ];
      });
    },
    /**
     * Background step for the member a mailbox is read as: expires old approval requests,
     * sends approved replies as their requester and checks unconfirmed sends by reading only.
     */
    async pass(context: TenantContext) {
      if (!deps.admission) return;
      const now = deps.now();
      const { live, mailboxes } = await deps.store.transaction(
        context.tenantId,
        async (tx) => ({
          live: await tx.outbound.live(100),
          mailboxes: await tx.mailboxes.list(),
        }),
      );
      const own = new Set(
        mailboxes
          .filter((m) => m.principalId === context.actor.id)
          .map((m) => m.connectionId),
      );
      const supplierChecks = await deps.store.transaction(
        context.tenantId,
        (tx) => tx.outbound.supplierChecks?.(100) ?? Promise.resolve([]),
      );
      for (const outbound of supplierChecks.filter((o) =>
        own.has(o.connectionId),
      )) {
        try {
          const principal = await requester(
            outbound,
            context.tenantId,
            `supplier-mail-check:${outbound.id}`,
          );
          // Refresh permissions for every mailbox read; a check never sends again.
          requirePermission(principal, 'messages.read');
          if (outbound.state === 'sent') {
            const data = await deps.store.transaction(
              context.tenantId,
              async (tx) => {
                const thread = await tx.threads.get(outbound.threadId);
                const mailbox = await tx.mailboxes.get(outbound.connectionId);

                return thread && mailbox
                  ? {
                      thread,
                      mailbox,
                      rules: await tx.rules.active(outbound.connectionId),
                    }
                  : null;
              },
            );
            if (data && deps.reader) await readThread(principal, data);
            await deps.store.transaction(context.tenantId, async (tx) => {
              const current = await tx.outbound.get(outbound.id, true);
              if (current)
                await save(tx, current, {
                  document: { deliveryCheckedAt: deps.now().toISOString() },
                });
            });
          }
          await notifyOwner(principal, outbound.id);
        } catch (error) {
          deps.log(
            'Supplier mail evidence could not be checked; retrying.',
            error,
          );
        }
      }
      for (const outbound of live.filter((o) => own.has(o.connectionId))) {
        try {
          if (outbound.state === 'approval_required') {
            if (
              outbound.document.expiresAt &&
              Date.parse(outbound.document.expiresAt) <= now.getTime()
            )
              await deps.store.transaction(context.tenantId, async (tx) => {
                const current = await tx.outbound.get(outbound.id, true);
                if (current?.state === 'approval_required')
                  await save(tx, current, {
                    state: 'expired',
                    document: { stateReason: stateMessages.expired },
                  });
              });
            continue;
          }
          const principal = await deps.resolveContext(
            outbound.requestedBy,
            context.tenantId,
            `reply-pass:${outbound.id}`,
          );
          if (outbound.state === 'approved') {
            await dispatch(principal, outbound.id);
            continue;
          }
          const stale =
            now.getTime() - Date.parse(outbound.updatedAt) > sendingGraceMs;
          if (outbound.state === 'sending' && !stale) continue;
          const execution = await reconcile(principal, outbound);
          // Execution reserves before it dispatches, so a send without an execution record was
          // never dispatched and is started once now; recorded attempts are only read.
          if (execution.state === 'not_started' && outbound.state === 'sending')
            await dispatch(principal, outbound.id);
          else await settle(principal, outbound.id, execution);
          await notifyOwner(principal, outbound.id);
        } catch (error) {
          deps.log('A reply could not be checked; retrying.', error);
        }
      }
    },
    /** Admission hook: the bound reply must still be in flight with exactly this content. */
    async eligible(
      context: TenantContext,
      step: { subject?: { kind: string; id: string }; action: unknown },
    ) {
      if (step.subject?.kind !== 'message_outbound') return false;
      const bound = await forAction(context, step.subject.id);

      return (
        !!bound &&
        ['approval_required', 'approved', 'sending'].includes(bound.state) &&
        canonicalJson(bound.action) === canonicalJson(step.action) &&
        (!deps.eligibleOwner ||
          (await deps.eligibleOwner(
            context,
            await load(context.tenantId, step.subject.id),
          )))
      );
    },
    forAction,
    /**
     * Verification for the execution adapter: reads the thread again and looks for the message
     * with the Message-ID derived from the reply. New messages are stored as any thread read.
     */
    async verify(context: TenantContext, outboundId: string) {
      const data = await deps.store.transaction(
        context.tenantId,
        async (tx) => {
          const outbound = await tx.outbound.get(outboundId);
          const thread = outbound
            ? await tx.threads.get(outbound.threadId)
            : null;
          const mailbox = thread
            ? await tx.mailboxes.get(thread.connectionId)
            : null;

          return thread && mailbox
            ? {
                thread,
                mailbox,
                rules: await tx.rules.active(thread.connectionId),
              }
            : null;
        },
      );
      if (!data || !deps.reader)
        return {
          outcome: 'inconclusive' as const,
          observationRefs: [outboundId],
        };
      if (!(await readThread(context, data)))
        return {
          outcome: 'inconclusive' as const,
          observationRefs: [data.thread.id],
        };
      const found = sentMessage(
        await deps.store.transaction(context.tenantId, (tx) =>
          tx.messages.forThread(data.thread.id),
        ),
        outboundId,
      );

      return found
        ? { outcome: 'passed' as const, observationRefs: [found.id] }
        : {
            outcome: 'inconclusive' as const,
            observationRefs: [data.thread.id],
          };
    },
  };
}

export type Replies = ReturnType<typeof createReplies>;
