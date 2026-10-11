import type { TenantContext } from '@luma/identity';

import type { LinkProposal, ReferenceToken } from '../domain/linking.js';
import {
  handoffOrder,
  mergeLink,
  proposeLinks,
  referenceTokens,
} from '../domain/linking.js';
import type { Mailbox, MailboxRule } from '../domain/mailbox.js';
import type { MessageData } from '../domain/threads.js';
import {
  aggregateThread,
  documentFamily,
  documentIntake,
  matchingRules,
  replyDeadline,
} from '../domain/threads.js';
import type {
  ProcurementHandoff,
  RecordDirectory,
  RecordRef,
} from './ports.js';
import type {
  LinkRow,
  MessagingStore,
  MessagingTransaction,
  ThreadRow,
} from './store.js';

/** Longest message text handed to procurement, which stores at most this much. */
const handoffBodyLimit = 20_000;

export interface IngestDependencies {
  store: MessagingStore;
  directory: RecordDirectory;
  /** Without it, supplier messages stay in the inbox only. */
  handoff?: ProcurementHandoff | undefined;
  now(): Date;
  id(): string;
  digest(value: unknown): string;
  /** A stable UUID derived from a name. */
  uuid(name: string): string;
  /** Days message text and attachment content are kept after receipt. */
  retentionDays: number;
  log(message: string, error?: unknown): void;
}

interface Candidate {
  messageId: string;
  threadId: string;
  data: MessageData;
  suppliers: Set<string>;
}

/**
 * Stores provider messages idempotently and keeps their threads current: aggregates, reply
 * deadlines, reopening, timeline events, document intake and evidenced links. New inbound
 * supplier messages on a purchase-order thread are then handed to procurement once.
 */
export function createIngest(deps: IngestDependencies) {
  async function signals(
    context: TenantContext,
    mailbox: Mailbox,
    items: readonly { data: MessageData }[],
  ) {
    const tokens = new Map<MessageData, ReferenceToken[]>();
    const keys = new Set<string>();
    const emails = new Set<string>();
    const own = mailbox.address?.toLowerCase() ?? null;
    for (const { data } of items) {
      const found = referenceTokens(data.subject, data.text);
      tokens.set(data, found);
      for (const token of found) keys.add(token.key);
      for (const address of correspondents(data))
        if (address !== own) emails.add(address);
    }
    const [references, customers] = await Promise.all([
      keys.size
        ? deps.directory.references(context, [...keys])
        : Promise.resolve([]),
      emails.size
        ? deps.directory.customers(context, [...emails])
        : Promise.resolve([]),
    ]);

    return { tokens, references, customers, own };
  }

  async function applyLinks(
    tx: MessagingTransaction,
    threadId: string,
    proposals: LinkProposal[],
    at: string,
  ) {
    for (const proposal of proposals) {
      const existing = await tx.links.latest(
        threadId,
        proposal.kind,
        proposal.recordId,
      );
      const change = mergeLink(existing, proposal);
      if (change === 'keep') continue;
      if (change === 'activate')
        await tx.links.update({
          ...existing!,
          state: 'active',
          method: existing!.method,
          evidence: proposal.evidence,
        });
      else
        await tx.links.insert({
          id: deps.id(),
          threadId,
          kind: proposal.kind,
          recordId: proposal.recordId,
          method: proposal.method,
          state: proposal.state,
          evidence: proposal.evidence,
          createdBy: 'luma',
          createdAt: at,
          removedBy: null,
          removedAt: null,
        });
      if (proposal.state === 'active')
        await tx.events.insert({
          id: deps.id(),
          threadId,
          type: 'linked',
          actor: { kind: 'luma', id: 'luma' },
          details: {
            kind: proposal.kind,
            recordId: proposal.recordId,
            method: proposal.method,
          },
          occurredAt: at,
        });
    }
  }

  /** Recomputes a thread from its stored messages; new inbound messages reopen it. */
  async function refresh(
    tx: MessagingTransaction,
    thread: ThreadRow,
    mailbox: Mailbox,
    reopen: boolean,
    at: string,
  ) {
    const messages = await tx.messages.forThread(thread.id);
    const aggregate = aggregateThread(messages);
    if (!aggregate) return;
    const status = reopen ? 'open' : thread.status;
    const updated: ThreadRow = {
      ...thread,
      ...aggregate,
      status,
      replyDueAt: replyDeadline({
        ...aggregate,
        manualDueAt: thread.manualDueAt,
        replyHours: mailbox.settings.replyHours,
      }),
      revision:
        status !== thread.status ? thread.revision + 1 : thread.revision,
      updatedAt: at,
    };
    await tx.threads.update(updated);
    if (status !== thread.status)
      await tx.events.insert({
        id: deps.id(),
        threadId: thread.id,
        type: 'status_changed',
        actor: { kind: 'luma', id: 'luma' },
        details: { from: thread.status, to: status, reason: 'new_message' },
        occurredAt: at,
      });
  }

  async function handOff(
    context: TenantContext,
    candidates: readonly Candidate[],
    links: readonly LinkRow[],
  ) {
    if (!deps.handoff || !candidates.length) return;
    const orders = [
      ...new Set(
        links
          .filter((l) => l.kind === 'purchase_order' && l.state === 'active')
          .map((l) => l.recordId),
      ),
    ];
    if (!orders.length) return;
    const supplierOf = await deps.directory.orderSuppliers(context, orders);
    for (const candidate of candidates) {
      const purchaseOrderId = handoffOrder({
        links: links.filter((l) => l.threadId === candidate.threadId),
        supplierOf,
        senderSuppliers: candidate.suppliers,
      });
      if (!purchaseOrderId) continue;
      const body = candidate.data.text.trim().slice(0, handoffBodyLimit);
      let outcome: 'recorded' | 'duplicate' | 'forbidden' | 'empty' = 'empty';
      try {
        if (
          await deps.store.transaction(context.tenantId, (tx) =>
            tx.events.forMessage('handed_off', candidate.messageId),
          )
        )
          continue;
        if (body)
          outcome = await deps.handoff.record(context, {
            purchaseOrderId,
            id: deps.uuid(
              `messaging:handoff:${context.tenantId}:${candidate.messageId}`,
            ),
            from: candidate.data.from.address,
            subject: candidate.data.subject.slice(0, 500),
            body,
            receivedAt: candidate.data.receivedAt,
            messageId: candidate.data.rfcMessageId?.slice(0, 250) ?? null,
          });
      } catch (error) {
        deps.log(
          'A supplier message could not be handed to procurement.',
          error,
        );
        continue;
      }
      await deps.store.transaction(context.tenantId, (tx) =>
        tx.events.insert({
          id: deps.id(),
          threadId: candidate.threadId,
          type: 'handed_off',
          actor: { kind: 'luma', id: 'luma' },
          details: {
            messageId: candidate.messageId,
            purchaseOrderId,
            outcome,
          },
          occurredAt: deps.now().toISOString(),
        }),
      );
    }
  }

  /**
   * Stores one page of messages for a mailbox. Returns the number of messages that were new.
   * Repeated pages change nothing; removed links and removed text are not restored.
   */
  return async function ingest(
    context: TenantContext,
    mailbox: Mailbox,
    rules: readonly MailboxRule[],
    items: readonly { providerMessageId: string; data: MessageData }[],
  ) {
    if (!items.length) return 0;
    const lookup = await signals(context, mailbox, items);
    const ordered = [...items].sort((a, b) =>
      a.data.receivedAt.localeCompare(b.data.receivedAt),
    );
    const { inserted, candidates, links } = await deps.store.transaction(
      context.tenantId,
      async (tx) => {
        const now = deps.now();
        const at = now.toISOString();
        const touched = new Map<
          string,
          { thread: ThreadRow; reopen: boolean }
        >();
        const candidates: Candidate[] = [];
        let inserted = 0;
        for (const { providerMessageId, data } of ordered) {
          const thread = await threadFor(tx, mailbox, data, at);
          const entry = touched.get(thread.id) ?? { thread, reopen: false };
          touched.set(thread.id, entry);
          const messageId = deps.id();
          const { text, ...snapshot } = data;
          const retainUntil = new Date(
            Math.max(Date.parse(data.receivedAt), 0) +
              deps.retentionDays * 86_400_000,
          ).toISOString();
          const created = await tx.messages.insert({
            id: messageId,
            threadId: thread.id,
            connectionId: mailbox.connectionId,
            providerMessageId,
            rfcMessageId: data.rfcMessageId,
            direction: data.direction,
            fromAddress: data.from.address.toLowerCase(),
            document: { ...snapshot, digest: deps.digest(data) },
            text: Date.parse(retainUntil) > now.getTime() ? text : null,
            origin: 'sync',
            receivedAt: data.receivedAt,
            retainUntil,
            purgedAt: null,
            purgeReason: null,
            createdAt: at,
          });
          if (!created) continue;
          inserted++;
          await tx.events.insert({
            id: deps.id(),
            threadId: thread.id,
            type: data.direction === 'inbound' ? 'received' : 'sent',
            actor: { kind: 'luma', id: 'luma' },
            details: {
              messageId,
              ...(data.direction === 'inbound'
                ? { from: data.from.address }
                : { to: data.to.map((a) => a.address).join(', ') }),
            },
            occurredAt: data.receivedAt,
          });
          for (const attachment of data.attachments) {
            const intake = documentIntake(attachment);
            if (!intake) continue;
            await tx.documents.insert({
              id: deps.id(),
              messageId,
              threadId: thread.id,
              providerAttachmentId: attachment.attachment.externalId,
              filename: attachment.filename.slice(0, 500) || 'attachment',
              mimeType:
                attachment.mimeType.slice(0, 200) || 'application/octet-stream',
              size: attachment.size,
              sha256: null,
              familyKey: documentFamily(attachment.filename, thread.id),
              version: 1,
              previousId: null,
              duplicateOf: null,
              state: intake.state,
              failure: intake.state === 'unsupported' ? intake.failure : null,
              attempts: 0,
              retainUntil,
              purgedAt: null,
              createdAt: at,
              updatedAt: at,
            });
          }
          const matched = matchingRules(data, rules);
          await applyLinks(
            tx,
            thread.id,
            proposeLinks({
              messageId,
              rules: matched,
              customers: correspondents(data)
                .filter((address) => address !== lookup.own)
                .map((address) => ({
                  address,
                  ids: lookup.customers
                    .filter((c) => c.email === address)
                    .map((c) => c.id),
                }))
                .filter((c) => c.ids.length),
              references: (lookup.tokens.get(data) ?? []).map((token) => ({
                token,
                records: lookup.references
                  .filter((r) => r.key === token.key)
                  .map((r): RecordRef => ({ kind: r.kind, id: r.id })),
              })),
            }),
            at,
          );
          if (data.direction === 'inbound') {
            entry.reopen ||= entry.thread.status !== 'open';
            candidates.push({
              messageId,
              threadId: thread.id,
              data,
              suppliers: new Set(
                matched.flatMap(({ rule }) =>
                  rule.party.kind === 'supplier' ? [rule.party.supplierId] : [],
                ),
              ),
            });
          }
        }
        for (const { thread, reopen } of touched.values())
          await refresh(
            tx,
            (await tx.threads.get(thread.id, true)) ?? thread,
            mailbox,
            reopen,
            at,
          );

        return {
          inserted,
          candidates,
          links: candidates.length
            ? await tx.links.forThreads([
                ...new Set(candidates.map((c) => c.threadId)),
              ])
            : [],
        };
      },
    );
    await handOff(context, candidates, links);

    return inserted;
  };

  /** The thread for a provider thread, created on its first message and locked. */
  async function threadFor(
    tx: MessagingTransaction,
    mailbox: Mailbox,
    data: MessageData,
    at: string,
  ): Promise<ThreadRow> {
    const existing = await tx.threads.byProvider(
      mailbox.connectionId,
      data.thread.externalId,
      true,
    );
    if (existing) return existing;
    await tx.threads.insert({
      id: deps.id(),
      connectionId: mailbox.connectionId,
      providerThreadId: data.thread.externalId,
      subject: data.subject,
      document: {
        participants: [],
        correspondent: null,
        snippet: '',
        attachmentCount: 0,
      },
      status: 'open',
      ownerId: null,
      manualDueAt: null,
      replyDueAt: null,
      lastMessageAt: data.receivedAt,
      lastInboundAt: null,
      lastOutboundAt: null,
      messageCount: 0,
      revision: 1,
      createdAt: at,
      updatedAt: at,
    });

    return (await tx.threads.byProvider(
      mailbox.connectionId,
      data.thread.externalId,
      true,
    ))!;
  }
}

/** Addresses of the other party: senders and reply-to when inbound, recipients when sent. */
function correspondents(data: MessageData) {
  const addresses =
    data.direction === 'inbound'
      ? [data.from, ...data.replyTo]
      : [...data.to, ...data.cc];

  return [...new Set(addresses.map((a) => a.address.toLowerCase()))];
}

export type Ingest = ReturnType<typeof createIngest>;
