import type { AuditEntry } from '@luma/audit';
import type { Permission, TenantContext } from '@luma/identity';
import {
  hasPermission,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import {
  conflict,
  forbidden,
  invalid,
  notFound,
  unavailable,
} from '@luma/platform';

import type { RecordKind } from '../domain/linking.js';
import type {
  Mailbox,
  MailboxRule,
  MailboxSettings,
  RuleKind,
  RuleParty,
} from '../domain/mailbox.js';
import { defaultSettings, mailboxState } from '../domain/mailbox.js';
import type { ThreadStatus } from '../domain/threads.js';
import { replyDeadline } from '../domain/threads.js';
import type { Ingest } from './ingest.js';
import type {
  MailboxConnection,
  MailboxConnections,
  MemberDirectory,
  MessageReader,
  RecordDirectory,
} from './ports.js';
import type {
  LinkRow,
  MessagingStore,
  MessagingTransaction,
  ThreadPosition,
  ThreadRow,
  ThreadSort,
  ThreadView,
  ThreadWhere,
} from './store.js';
import type { MailboxView, ThreadDetail, ThreadSummary } from './views.js';
import {
  documentSummary,
  eventRecord,
  eventView,
  linkView,
  messageView,
  outboundView,
  recordKey,
  recordPermission,
  threadSummary,
} from './views.js';

export interface MessagingDependencies {
  store: MessagingStore;
  connections: MailboxConnections;
  directory: RecordDirectory;
  members: MemberDirectory;
  /** Reads provider threads again; without it, threads cannot be refreshed. */
  reader?: MessageReader | undefined;
  ingest: Ingest;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  now(): Date;
  id(): string;
  digest(value: unknown): string;
}

export interface RuleInput {
  id: string;
  kind: RuleKind;
  value: string;
  party: RuleParty;
}

export interface ThreadQuery {
  view: ThreadView;
  connectionId?: string | undefined;
  /** Searches subjects and correspondents; it holds personal data and is never logged. */
  q?: string | undefined;
  /** Conditions on structured thread properties, validated against the inbox catalog. */
  where?: ThreadWhere | undefined;
  group?:
    | { field: string; granularity?: 'day' | 'week' | 'month' | undefined }
    | undefined;
  /** Reads one group's threads, paged by `cursor` and `limit`, instead of every group. */
  groupKey?: string | number | boolean | null | undefined;
  /** Threads per group when reading every group, 1 to 50. */
  groupLimit?: number | undefined;
  timeZone?: string | undefined;
  sort?: ThreadSort | undefined;
  direction?: 'asc' | 'desc' | undefined;
  cursor?: string | undefined;
  limit: number;
}

/** Groups a grouped read returns at most; `groupsTruncated` says when more match. */
const maxThreadGroups = 50;

/** Threads due within this window count for Needs you, as its ranking treats them as urgent. */
const dueSoonMs = 30 * 60_000;

/** A thread's place in the list's sort; threads without a deadline come last for `due`. */
function threadPosition(thread: ThreadRow, sort: ThreadSort): ThreadPosition {
  if (sort === 'activity')
    return { missing: 0, at: thread.lastMessageAt, id: thread.id };

  return thread.replyDueAt
    ? { missing: 0, at: thread.replyDueAt, id: thread.id }
    : { missing: 1, at: new Date(0).toISOString(), id: thread.id };
}

/** Encodes a keyset position within the query whose scope is `context`. */
function encodeCursor(context: string, position: ThreadPosition) {
  return Buffer.from(
    JSON.stringify([context, position.missing, position.at, position.id]),
  ).toString('base64url');
}

/** Decodes a position of the same query; anything else is a 422 validation error. */
function decodeCursor(
  cursor: string | undefined,
  context: string,
): ThreadPosition | undefined {
  if (!cursor) return undefined;
  try {
    const [scope, missing, at, id] = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as unknown[];
    if (
      scope === context &&
      (missing === 0 || missing === 1) &&
      typeof at === 'string' &&
      !Number.isNaN(Date.parse(at)) &&
      typeof id === 'string' &&
      /^[0-9a-f-]{36}$/i.test(id)
    )
      return { missing, at, id };
  } catch {
    // Reported below.
  }
  throw invalid('This list position is not valid. Start from the first page.');
}

/**
 * Owns the operations inbox: connected mailboxes and their rules, threads as work items with
 * owners, deadlines, notes and evidenced record links. Every operation refreshes the caller's
 * membership; writes are idempotent by command ID, revision-checked and audited.
 */
export function createMessagingService(deps: MessagingDependencies) {
  async function authorize(context: TenantContext, permission: Permission) {
    requireTenant(context, context.tenantId);
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    requirePermission(fresh, permission);
    if (fresh.actor.id !== context.actor.id)
      throw forbidden('Sign in again to continue.');

    return fresh;
  }

  /** Runs a write once per command ID; an exact retry skips the write, a changed one fails. */
  async function command(
    context: TenantContext,
    id: string,
    request: unknown,
    operation: (tx: MessagingTransaction) => Promise<void>,
  ) {
    const digest = deps.digest({ actorId: context.actor.id, request });
    await deps.store.transaction(context.tenantId, async (tx) => {
      const prior = await tx.commands.get(id);
      if (prior) {
        if (prior.digest !== digest)
          throw conflict(
            'This request ID was already used for another change. Refresh and try again.',
          );

        return;
      }
      await operation(tx);
      await tx.commands.save(id, digest, { ok: true });
    });
  }

  function audit(
    context: TenantContext,
    input: {
      type: string;
      commandId: string;
      subjectId: string;
      connectionId?: string;
      details: Record<string, string>;
    },
  ): AuditEntry {
    return {
      id: deps.id(),
      tenantId: context.tenantId,
      eventKey: `messaging:${input.type}:${input.commandId}`,
      eventType: `messaging.${input.type}`,
      schemaVersion: 1,
      occurredAt: deps.now().toISOString(),
      actor: { kind: 'user', id: context.actor.id },
      correlationId: context.requestId,
      proposalId: input.subjectId,
      actionHash: deps.digest({ type: input.type, ...input.details }),
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      evidenceRefs: [input.subjectId],
      details: { commandId: input.commandId, ...input.details },
    };
  }

  async function connectionMap(context: TenantContext) {
    return new Map(
      (await deps.connections.list(context)).map((c) => [c.id, c]),
    );
  }

  function mailboxView(
    mailbox: Mailbox,
    connection: MailboxConnection | undefined,
    rules: readonly MailboxRule[],
    labels: ReadonlyMap<string, string>,
  ): MailboxView {
    const own = rules.filter(
      (rule) => rule.connectionId === mailbox.connectionId,
    );
    const state = mailboxState(
      mailbox,
      own,
      connection
        ? { status: connection.status, canRead: connection.canRead }
        : null,
    );

    return {
      connectionId: mailbox.connectionId,
      label: connection?.label ?? mailbox.label,
      provider: connection?.provider ?? mailbox.provider,
      address: connection?.address ?? mailbox.address,
      connectionStatus: connection?.status ?? 'disconnected',
      canSend: !!connection?.canSend && connection.status === 'active',
      state: state.state,
      stateReason: state.reason,
      lastSyncedAt: mailbox.lastSyncedAt,
      coveredUntil: mailbox.cursor.coveredUntil ?? null,
      settings: { ...mailbox.settings, paused: mailbox.paused },
      rules: own.map((rule) => ({
        id: rule.id,
        kind: rule.kind,
        value: rule.value,
        party: rule.party,
        partyLabel:
          rule.party.kind === 'supplier'
            ? (labels.get(
                recordKey({ kind: 'supplier', id: rule.party.supplierId }),
              ) ?? null)
            : null,
        backfilledAt: rule.backfilledAt,
        createdBy: rule.createdBy,
        createdAt: rule.createdAt,
      })),
      revision: mailbox.revision,
    };
  }

  async function ruleLabels(
    context: TenantContext,
    rules: readonly MailboxRule[],
  ) {
    const suppliers = rules.flatMap((rule) =>
      rule.party.kind === 'supplier'
        ? [{ kind: 'supplier' as const, id: rule.party.supplierId }]
        : [],
    );

    return suppliers.length
      ? deps.directory.labels(context, suppliers)
      : new Map<string, string>();
  }

  /** Reads one mailbox view after a change. */
  async function oneMailbox(context: TenantContext, connectionId: string) {
    const connections = await connectionMap(context);
    const { mailbox, rules } = await deps.store.transaction(
      context.tenantId,
      async (tx) => ({
        mailbox: await tx.mailboxes.get(connectionId),
        rules: await tx.rules.active(connectionId),
      }),
    );
    if (!mailbox) throw notFound('Mailbox not found');

    return mailboxView(
      mailbox,
      connections.get(connectionId),
      rules,
      await ruleLabels(context, rules),
    );
  }

  /**
   * Whether the member a mailbox is read as can no longer read messages, so a manager's change
   * should make the manager that member.
   */
  async function principalGone(context: TenantContext, connectionId: string) {
    const mailbox = await deps.store.transaction(context.tenantId, (tx) =>
      tx.mailboxes.get(connectionId),
    );
    if (!mailbox) throw notFound('Mailbox not found');
    if (mailbox.principalId === context.actor.id) return false;

    return (
      mailbox.blocked === 'principal_unavailable' ||
      !(await deps.members.canReadMessages(context, mailbox.principalId))
    );
  }

  function takeOver(
    mailbox: Mailbox,
    context: TenantContext,
    gone: boolean,
  ): Mailbox {
    return gone
      ? {
          ...mailbox,
          principalId: context.actor.id,
          blocked:
            mailbox.blocked === 'principal_unavailable'
              ? null
              : mailbox.blocked,
          attempts: 0,
          lastError: null,
          dueAt: deps.now().toISOString(),
        }
      : mailbox;
  }

  async function requireMailbox(
    tx: MessagingTransaction,
    connectionId: string,
  ) {
    const mailbox = await tx.mailboxes.get(connectionId, true);
    if (!mailbox) throw notFound('Mailbox not found');

    return mailbox;
  }

  async function requireThread(tx: MessagingTransaction, threadId: string) {
    const thread = await tx.threads.get(threadId, true);
    if (!thread) throw notFound('Thread not found');

    return thread;
  }

  async function present(
    context: TenantContext,
    threads: readonly ThreadRow[],
  ): Promise<ThreadSummary[]> {
    if (!threads.length) return [];
    const ids = threads.map((t) => t.id);
    const data = await deps.store.transaction(context.tenantId, async (tx) => ({
      links: await tx.links.forThreads(ids),
      facts: await tx.facts.toReview(ids),
      mailboxes: await tx.mailboxes.list(),
    }));
    const active = data.links.filter((link) => link.state === 'active');
    const labels = await labelsFor(context, active);
    const mailboxLabels = new Map(
      data.mailboxes.map((m) => [m.connectionId, m.label]),
    );
    const now = deps.now();

    return threads.map((thread) =>
      threadSummary(context, thread, {
        mailboxLabel: mailboxLabels.get(thread.connectionId) ?? '',
        links: active,
        labels,
        factsToReview: data.facts.get(thread.id) ?? 0,
        now,
      }),
    );
  }

  async function labelsFor(
    context: TenantContext,
    links: readonly Pick<LinkRow, 'kind' | 'recordId'>[],
  ) {
    const readable = links.filter((link) =>
      hasPermission(context, recordPermission[link.kind]),
    );
    if (!readable.length) return new Map<string, string>();

    return deps.directory.labels(context, [
      ...new Map(
        readable.map((link) => [
          recordKey({ kind: link.kind, id: link.recordId }),
          { kind: link.kind, id: link.recordId },
        ]),
      ).values(),
    ]);
  }

  async function detail(
    context: TenantContext,
    threadId: string,
  ): Promise<ThreadDetail> {
    const data = await deps.store.transaction(context.tenantId, async (tx) => {
      const thread = await tx.threads.get(threadId);
      if (!thread) throw notFound('Thread not found');
      const messages = await tx.messages.forThread(threadId);
      const links = await tx.links.forThreads([threadId]);
      const notes = await tx.notes.forThread(threadId);
      const events = await tx.events.forThread(threadId);
      const documents = await tx.documents.forThreads([threadId]);
      const outbound = await tx.outbound.forThread(threadId);
      const mailbox = await tx.mailboxes.get(thread.connectionId);
      const threadFacts = await tx.facts.toReview([threadId]);
      const documentFacts = await tx.facts.toReviewByDocument(
        documents.map((d) => d.id),
      );

      return {
        thread: thread,
        messages,
        links: links.filter((link) => link.state !== 'removed'),
        notes,
        events,
        documents,
        outbound,
        mailbox,
        threadFacts,
        documentFacts,
      };
    });
    const labels = await labelsFor(context, [
      ...data.links,
      ...data.events.flatMap((event) => {
        const record = eventRecord(event);

        return record ? [{ kind: record.kind, recordId: record.id }] : [];
      }),
    ]);
    const provider = data.mailbox?.provider ?? 'unknown';
    const received = new Map(data.messages.map((m) => [m.id, m.receivedAt]));

    return {
      thread: threadSummary(context, data.thread, {
        mailboxLabel: data.mailbox?.label ?? '',
        links: data.links,
        labels,
        factsToReview: data.threadFacts.get(threadId) ?? 0,
        now: deps.now(),
      }),
      messages: data.messages.map((m) =>
        messageView(m, provider, data.documents),
      ),
      links: data.links.map((link) => linkView(context, link, labels)),
      notes: data.notes.map((note) => ({
        id: note.id,
        authorId: note.authorId,
        body: note.body,
        createdAt: note.createdAt,
      })),
      events: data.events.map((event) => eventView(context, event, labels)),
      documents: data.documents.map((document) =>
        documentSummary(
          document,
          received.get(document.messageId) ?? document.createdAt,
          data.documentFacts.get(document.id) ?? 0,
        ),
      ),
      outbound: data.outbound.map((item) => outboundView(item, context)),
      permissions: {
        canManage: hasPermission(context, 'messages.manage'),
        canSend: hasPermission(context, 'messages.send'),
      },
    };
  }

  async function summary(context: TenantContext, threadId: string) {
    const thread = await deps.store.transaction(context.tenantId, (tx) =>
      tx.threads.get(threadId),
    );
    if (!thread) throw notFound('Thread not found');

    return (await present(context, [thread]))[0]!;
  }

  /** Applies a thread change with its timeline event, audit and new revision. */
  async function changeThread(
    context: TenantContext,
    threadId: string,
    commandId: string,
    request: Record<string, unknown>,
    change: (
      thread: ThreadRow,
      tx: MessagingTransaction,
    ) => Promise<{
      thread: ThreadRow;
      type: 'assigned' | 'deadline_set' | 'status_changed';
      details: Record<string, string>;
    } | null>,
  ) {
    await command(context, commandId, { threadId, ...request }, async (tx) => {
      const thread = await requireThread(tx, threadId);
      const result = await change(thread, tx);
      if (!result) return;
      const at = deps.now().toISOString();
      await tx.threads.update({
        ...result.thread,
        revision: thread.revision + 1,
        updatedAt: at,
      });
      await tx.events.insert({
        id: deps.id(),
        threadId,
        type: result.type,
        actor: { kind: 'user', id: context.actor.id },
        details: result.details,
        occurredAt: at,
      });
      await tx.audit(
        audit(context, {
          type: `thread.${result.type}`,
          commandId,
          subjectId: threadId,
          connectionId: thread.connectionId,
          details: { threadId, ...result.details },
        }),
      );
    });
  }

  function checkRevision(thread: ThreadRow, expected: number) {
    if (thread.revision !== expected)
      throw conflict('This thread changed. Refresh and try again.');
  }

  async function requireRecord(
    context: TenantContext,
    kind: RecordKind,
    recordId: string,
  ) {
    requirePermission(context, recordPermission[kind]);
    const labels = await deps.directory.labels(context, [
      { kind, id: recordId },
    ]);
    if (!labels.has(recordKey({ kind, id: recordId })))
      throw notFound('The record was not found.');
  }

  return {
    /**
     * Lists mailboxes, creating one for each active connection that can read messages. A new
     * mailbox is read as the member who installed the connection, or the first manager who
     * opens it when that is unknown. Writes only when something changed.
     */
    async mailboxes(context: TenantContext) {
      context = await authorize(context, 'messages.read');
      const canManage = hasPermission(context, 'messages.manage');
      const connections = await deps.connections.list(context);
      // Support views read only; their transactions refuse writes.
      const writable = !context.supportView;
      const { mailboxes, rules } = await deps.store.transaction(
        context.tenantId,
        async (tx) => {
          const now = deps.now().toISOString();
          const existing = new Map(
            (await tx.mailboxes.list()).map((m) => [m.connectionId, m]),
          );
          for (const connection of connections) {
            const mailbox = existing.get(connection.id);
            if (!writable) continue;
            if (!mailbox) {
              const principal =
                connection.installerId ?? (canManage ? context.actor.id : null);
              if (
                connection.status !== 'active' ||
                !connection.canRead ||
                !principal
              )
                continue;
              const created: Mailbox = {
                tenantId: context.tenantId,
                connectionId: connection.id,
                principalId: principal,
                label: connection.label,
                provider: connection.provider,
                address: connection.address,
                settings: defaultSettings,
                cursor: {},
                paused: false,
                blocked: null,
                dueAt: now,
                hintAt: null,
                leaseToken: null,
                leaseUntil: null,
                attempts: 0,
                lastSyncedAt: null,
                lastError: null,
                revision: 1,
                createdAt: now,
                updatedAt: now,
              };
              if (await tx.mailboxes.insert(created))
                existing.set(connection.id, created);
              continue;
            }
            const unblock =
              !!mailbox.blocked &&
              mailbox.blocked !== 'principal_unavailable' &&
              connection.status === 'active' &&
              connection.canRead &&
              mailbox.cursor.blockedVersion !== connection.version;
            const renamed =
              mailbox.label !== connection.label ||
              mailbox.address !== connection.address ||
              mailbox.provider !== connection.provider;
            if (!unblock && !renamed) continue;
            const locked = await requireMailbox(tx, connection.id);
            const cursor = { ...locked.cursor };
            if (unblock) delete cursor.blockedVersion;
            const updated: Mailbox = {
              ...locked,
              label: connection.label,
              address: connection.address,
              provider: connection.provider,
              ...(unblock
                ? {
                    blocked: null,
                    attempts: 0,
                    lastError: null,
                    cursor,
                    dueAt: now,
                  }
                : {}),
              updatedAt: now,
            };
            await tx.mailboxes.update(updated);
            existing.set(connection.id, updated);
          }

          return {
            mailboxes: [...existing.values()],
            rules: await tx.rules.active(),
          };
        },
      );
      const byId = new Map(connections.map((c) => [c.id, c]));
      const labels = await ruleLabels(context, rules);

      return {
        items: mailboxes
          .sort(
            (a, b) =>
              a.label.localeCompare(b.label) ||
              a.connectionId.localeCompare(b.connectionId),
          )
          .map((mailbox) =>
            mailboxView(mailbox, byId.get(mailbox.connectionId), rules, labels),
          ),
        canManage,
      };
    },
    /** Changes mailbox settings when `expectedRevision` is current. Resuming reads at once. */
    async updateMailbox(
      context: TenantContext,
      connectionId: string,
      input: MailboxSettings & { paused: boolean; expectedRevision: number },
    ) {
      context = await authorize(context, 'messages.manage');
      const gone = await principalGone(context, connectionId);
      await deps.store.transaction(context.tenantId, async (tx) => {
        const mailbox = await requireMailbox(tx, connectionId);
        if (mailbox.revision !== input.expectedRevision)
          throw conflict(
            'These mailbox settings changed. Refresh and try again.',
          );
        const now = deps.now().toISOString();
        const settings = {
          backfillDays: input.backfillDays,
          replyHours: input.replyHours,
          approveAll: input.approveAll,
        };
        await tx.mailboxes.update({
          ...takeOver(mailbox, context, gone),
          settings,
          paused: input.paused,
          ...(mailbox.paused && !input.paused ? { dueAt: now } : {}),
          revision: mailbox.revision + 1,
          updatedAt: now,
        });
        await tx.audit(
          audit(context, {
            type: 'mailbox.settings_changed',
            commandId: `${connectionId}:${mailbox.revision + 1}`,
            subjectId: connectionId,
            connectionId,
            details: {
              backfillDays: String(settings.backfillDays),
              replyHours: String(settings.replyHours),
              approveAll: String(settings.approveAll),
              paused: String(input.paused),
            },
          }),
        );
      });

      return oneMailbox(context, connectionId);
    },
    /**
     * Adds a rule; Luma then reads matching messages from the backfill window. Supplier rules
     * need an existing supplier. Retrying the same rule ID returns the mailbox unchanged.
     */
    async addRule(
      context: TenantContext,
      connectionId: string,
      input: RuleInput,
    ) {
      context = await authorize(context, 'messages.manage');
      if (input.kind === 'label' && input.party.kind === 'supplier')
        throw conflict('Label rules cannot name a supplier.');
      if (input.party.kind === 'supplier') {
        const supplier = recordKey({
          kind: 'supplier',
          id: input.party.supplierId,
        });
        if (
          !(
            await deps.directory.labels(context, [
              { kind: 'supplier', id: input.party.supplierId },
            ])
          ).has(supplier)
        )
          throw notFound('The supplier was not found.');
      }
      const value =
        input.kind === 'label'
          ? input.value.trim()
          : input.value.trim().toLowerCase();
      const gone = await principalGone(context, connectionId);
      await command(
        context,
        input.id,
        { connectionId, ...input, value },
        async (tx) => {
          const mailbox = await requireMailbox(tx, connectionId);
          const now = deps.now().toISOString();
          const added = await tx.rules.insert({
            id: input.id,
            connectionId,
            kind: input.kind,
            value,
            party: input.party,
            backfilledAt: null,
            createdBy: context.actor.id,
            createdAt: now,
          });
          if (!added) throw conflict('This mailbox already has this rule.');
          await tx.mailboxes.update({
            ...takeOver(mailbox, context, gone),
            hintAt: now,
            revision: mailbox.revision + 1,
            updatedAt: now,
          });
          await tx.audit(
            audit(context, {
              type: 'mailbox.rule_added',
              commandId: input.id,
              subjectId: connectionId,
              connectionId,
              details: {
                ruleId: input.id,
                kind: input.kind,
                value,
                party: input.party.kind,
                ...(input.party.kind === 'supplier'
                  ? { supplierId: input.party.supplierId }
                  : {}),
              },
            }),
          );
        },
      );

      return oneMailbox(context, connectionId);
    },
    /** Stops reading new messages for a rule; threads already read stay. */
    async removeRule(
      context: TenantContext,
      connectionId: string,
      ruleId: string,
      commandId: string,
    ) {
      context = await authorize(context, 'messages.manage');
      await command(
        context,
        commandId,
        { command: 'remove_rule', connectionId, ruleId },
        async (tx) => {
          const mailbox = await requireMailbox(tx, connectionId);
          const rule = await tx.rules.get(ruleId);
          if (!rule || rule.connectionId !== connectionId)
            throw notFound('Rule not found');
          if (rule.removedAt) return;
          const now = deps.now().toISOString();
          await tx.rules.remove(ruleId, context.actor.id, now);
          await tx.mailboxes.update({
            ...mailbox,
            revision: mailbox.revision + 1,
            updatedAt: now,
          });
          await tx.audit(
            audit(context, {
              type: 'mailbox.rule_removed',
              commandId,
              subjectId: connectionId,
              connectionId,
              details: { ruleId, kind: rule.kind, value: rule.value },
            }),
          );
        },
      );

      return oneMailbox(context, connectionId);
    },
    /** Schedules a read within seconds and lifts a block, so someone who fixed it can retry. */
    async syncMailbox(context: TenantContext, connectionId: string) {
      context = await authorize(context, 'messages.manage');
      const gone = await principalGone(context, connectionId);
      await deps.store.transaction(context.tenantId, async (tx) => {
        const mailbox = takeOver(
          await requireMailbox(tx, connectionId),
          context,
          gone,
        );
        const now = deps.now().toISOString();
        const cursor = { ...mailbox.cursor };
        delete cursor.blockedVersion;
        await tx.mailboxes.update({
          ...mailbox,
          cursor,
          blocked: null,
          hintAt: now,
          updatedAt: now,
        });
      });

      return oneMailbox(context, connectionId);
    },
    /**
     * Lists threads of one view in the query's sort (newest activity first by default), or
     * every group's first threads, with counts for every view. View counts follow the search
     * and mailbox, never the conditions, so the built-in views keep their numbers. A page link
     * continues only the same reader's query.
     */
    async threads(context: TenantContext, query: ThreadQuery) {
      context = await authorize(context, 'messages.read');
      if (query.groupKey !== undefined && !query.group)
        throw invalid('Choose a grouping to read one group.');
      if (query.group?.granularity)
        throw invalid('This field cannot be grouped.');
      const groupKey = query.groupKey;
      if (
        groupKey !== undefined &&
        groupKey !== null &&
        typeof groupKey !== 'string'
      )
        throw invalid('This group does not exist.');
      const grouped = !!query.group && groupKey === undefined;
      if (grouped && query.cursor)
        throw invalid('Use a group’s page link together with its group key.');
      const sort = query.sort ?? 'activity';
      const direction =
        query.direction ?? (sort === 'activity' ? 'desc' : 'asc');
      const q = query.q?.trim() || undefined;
      // Within one group the scope leaves out page sizes, so a group's first threads and its
      // later pages may differ in size.
      const scope = (key: string | null | undefined) =>
        deps.digest({
          list: 'threads-v2',
          actorId: context.actor.id,
          view: query.view,
          connectionId: query.connectionId ?? null,
          q: q ?? null,
          where: query.where ?? null,
          group: query.group ?? null,
          timeZone: query.timeZone ?? 'UTC',
          sort,
          direction,
          page: key === undefined ? ['page', query.limit] : ['group', key],
        });
      const after = decodeCursor(query.cursor, scope(groupKey));
      const now = deps.now().toISOString();
      const filter = {
        actorId: context.actor.id,
        now,
        connectionId: query.connectionId,
        q,
      };
      const listed = {
        ...filter,
        view: query.view,
        where: query.where,
        timeZone: query.timeZone,
        sort,
        direction,
      } as const;

      if (grouped && query.group) {
        const field = query.group.field;
        const { result, counts } = await deps.store.transaction(
          context.tenantId,
          async (tx) => ({
            result: await tx.threads.groups({
              ...listed,
              field,
              perGroup: Math.min(Math.max(query.groupLimit ?? 10, 1), 50),
              maxGroups: maxThreadGroups,
            }),
            counts: await tx.threads.counts(filter),
          }),
        );
        const byId = new Map(result.rows.map((row) => [row.id, row]));

        return {
          items: await present(context, result.rows),
          nextCursor: null,
          counts,
          groups: result.groups.map((group) => {
            const last = byId.get(group.ids.at(-1) ?? '');

            return {
              key: group.key,
              count: group.count,
              complete: true,
              itemIds: group.ids,
              nextCursor:
                last && group.count > group.ids.length
                  ? encodeCursor(scope(group.key), threadPosition(last, sort))
                  : null,
              sums: [],
            };
          }),
          groupsTruncated: result.truncated,
        };
      }

      const member =
        query.group && groupKey !== undefined
          ? { field: query.group.field, key: groupKey }
          : undefined;
      const { rows, counts, total } = await deps.store.transaction(
        context.tenantId,
        async (tx) => ({
          rows: await tx.threads.list({
            ...listed,
            member,
            after,
            limit: query.limit + 1,
          }),
          counts: await tx.threads.counts(filter),
          // A group page reports its group's size, as grouped lists do.
          total: member
            ? await tx.threads.count({ ...listed, member })
            : undefined,
        }),
      );
      const page = rows.slice(0, query.limit);
      const nextCursor =
        rows.length > query.limit
          ? encodeCursor(
              scope(groupKey),
              threadPosition(page[page.length - 1]!, sort),
            )
          : null;

      return {
        items: await present(context, page),
        nextCursor,
        counts,
        ...(member
          ? {
              groups: [
                {
                  key: member.key,
                  count: total ?? page.length,
                  complete: true,
                  itemIds: page.map((thread) => thread.id),
                  nextCursor,
                  sums: [],
                },
              ],
            }
          : {}),
      };
    },
    /** Reads a thread with messages, links, notes, timeline, documents and replies. */
    async thread(context: TenantContext, threadId: string) {
      context = await authorize(context, 'messages.read');

      return detail(context, threadId);
    },
    /** Threads actively linked to a record the reader may read. */
    async recordThreads(
      context: TenantContext,
      kind: RecordKind,
      recordId: string,
    ) {
      context = await authorize(context, 'messages.read');
      requirePermission(context, recordPermission[kind]);
      const threads = await deps.store.transaction(context.tenantId, (tx) =>
        tx.threads.forRecord(kind, recordId),
      );

      return { items: await present(context, threads) };
    },
    /** Assigns a thread to a member who can read messages, or releases it. */
    async assign(
      context: TenantContext,
      threadId: string,
      input: { id: string; expectedRevision: number; ownerId: string | null },
    ) {
      context = await authorize(context, 'messages.manage');
      if (
        input.ownerId &&
        !(await deps.members.canReadMessages(context, input.ownerId))
      )
        throw conflict('This person cannot read messages in this workspace.');
      await changeThread(
        context,
        threadId,
        input.id,
        { command: 'assign', ...input },
        async (thread) => {
          checkRevision(thread, input.expectedRevision);
          if (thread.ownerId === input.ownerId) return null;

          return {
            thread: { ...thread, ownerId: input.ownerId },
            type: 'assigned',
            details: { from: thread.ownerId ?? '', to: input.ownerId ?? '' },
          };
        },
      );

      return summary(context, threadId);
    },
    /** Sets a reply deadline; null returns to the automatic deadline. */
    async setDeadline(
      context: TenantContext,
      threadId: string,
      input: {
        id: string;
        expectedRevision: number;
        replyDueAt: string | null;
      },
    ) {
      context = await authorize(context, 'messages.manage');
      await changeThread(
        context,
        threadId,
        input.id,
        { command: 'deadline', ...input },
        async (thread, tx) => {
          checkRevision(thread, input.expectedRevision);
          const mailbox = await tx.mailboxes.get(thread.connectionId);
          const manualDueAt = input.replyDueAt
            ? new Date(input.replyDueAt).toISOString()
            : null;
          const replyDueAt = replyDeadline({
            ...thread,
            manualDueAt,
            replyHours:
              mailbox?.settings.replyHours ?? defaultSettings.replyHours,
          });

          return {
            thread: { ...thread, manualDueAt, replyDueAt },
            type: 'deadline_set',
            details: {
              replyDueAt: replyDueAt ?? '',
              automatic: String(!manualDueAt),
            },
          };
        },
      );

      return summary(context, threadId);
    },
    /** Changes a thread's status. A new inbound message reopens it later. */
    async setStatus(
      context: TenantContext,
      threadId: string,
      input: { id: string; expectedRevision: number; status: ThreadStatus },
    ) {
      context = await authorize(context, 'messages.manage');
      await changeThread(
        context,
        threadId,
        input.id,
        { command: 'status', ...input },
        async (thread) => {
          checkRevision(thread, input.expectedRevision);
          if (thread.status === input.status) return null;

          return {
            thread: { ...thread, status: input.status },
            type: 'status_changed',
            details: { from: thread.status, to: input.status },
          };
        },
      );

      return summary(context, threadId);
    },
    /** Adds an internal note. Notes stay in Luma and are never sent. */
    async addNote(
      context: TenantContext,
      threadId: string,
      input: { id: string; body: string },
    ) {
      context = await authorize(context, 'messages.manage');
      const body = input.body.trim();
      if (!body || body.length > 5000)
        throw conflict('A note needs between 1 and 5,000 characters.');
      await command(
        context,
        input.id,
        { command: 'note', threadId, body },
        async (tx) => {
          const thread = await requireThread(tx, threadId);
          const at = deps.now().toISOString();
          await tx.notes.insert({
            id: input.id,
            threadId,
            authorId: context.actor.id,
            body,
            createdAt: at,
          });
          await tx.events.insert({
            id: deps.id(),
            threadId,
            type: 'note_added',
            actor: { kind: 'user', id: context.actor.id },
            details: { noteId: input.id },
            occurredAt: at,
          });
          await tx.audit(
            audit(context, {
              type: 'thread.note_added',
              commandId: input.id,
              subjectId: threadId,
              connectionId: thread.connectionId,
              details: { threadId, noteId: input.id },
            }),
          );
        },
      );

      return detail(context, threadId);
    },
    /** Links a record the caller may read, or confirms a suggested link to it. */
    async link(
      context: TenantContext,
      threadId: string,
      input: { id: string; kind: RecordKind; recordId: string },
    ) {
      context = await authorize(context, 'messages.manage');
      await requireRecord(context, input.kind, input.recordId);
      await command(
        context,
        input.id,
        { command: 'link', threadId, ...input },
        async (tx) => {
          const thread = await requireThread(tx, threadId);
          const at = deps.now().toISOString();
          const existing = await tx.links.latest(
            threadId,
            input.kind,
            input.recordId,
          );
          if (existing?.state === 'active') return;
          const evidence = {
            messageId: null,
            ruleId: null,
            text: null,
            span: null,
          };
          if (existing?.state === 'suggested')
            await tx.links.update({ ...existing, state: 'active' });
          else
            await tx.links.insert({
              id: input.id,
              threadId,
              kind: input.kind,
              recordId: input.recordId,
              method: 'manual',
              state: 'active',
              evidence,
              createdBy: context.actor.id,
              createdAt: at,
              removedBy: null,
              removedAt: null,
            });
          const linkId =
            existing?.state === 'suggested' ? existing.id : input.id;
          await tx.events.insert({
            id: deps.id(),
            threadId,
            type: 'linked',
            actor: { kind: 'user', id: context.actor.id },
            details: {
              linkId,
              kind: input.kind,
              recordId: input.recordId,
              method: existing?.state === 'suggested' ? 'confirmed' : 'manual',
            },
            occurredAt: at,
          });
          await tx.audit(
            audit(context, {
              type: 'thread.linked',
              commandId: input.id,
              subjectId: threadId,
              connectionId: thread.connectionId,
              details: {
                threadId,
                linkId,
                kind: input.kind,
                recordId: input.recordId,
              },
            }),
          );
        },
      );

      return detail(context, threadId);
    },
    /** Removes a link or dismisses a suggestion; automatic linking never adds it again. */
    async unlink(
      context: TenantContext,
      threadId: string,
      linkId: string,
      commandId: string,
    ) {
      context = await authorize(context, 'messages.manage');
      await command(
        context,
        commandId,
        { command: 'unlink', threadId, linkId },
        async (tx) => {
          const thread = await requireThread(tx, threadId);
          const link = await tx.links.get(linkId);
          if (!link || link.threadId !== threadId)
            throw notFound('Link not found');
          if (link.state === 'removed') return;
          const at = deps.now().toISOString();
          await tx.links.update({
            ...link,
            state: 'removed',
            removedBy: context.actor.id,
            removedAt: at,
          });
          await tx.events.insert({
            id: deps.id(),
            threadId,
            type: 'unlinked',
            actor: { kind: 'user', id: context.actor.id },
            details: { linkId, kind: link.kind, recordId: link.recordId },
            occurredAt: at,
          });
          await tx.audit(
            audit(context, {
              type: 'thread.unlinked',
              commandId,
              subjectId: threadId,
              connectionId: thread.connectionId,
              details: {
                threadId,
                linkId,
                kind: link.kind,
                recordId: link.recordId,
              },
            }),
          );
        },
      );

      return detail(context, threadId);
    },
    /** Removes a message's text and attachment content on request; metadata stays. */
    async removeMessageText(
      context: TenantContext,
      threadId: string,
      messageId: string,
      commandId: string,
    ) {
      context = await authorize(context, 'messages.manage');
      await command(
        context,
        commandId,
        { command: 'remove_text', threadId, messageId },
        async (tx) => {
          const thread = await requireThread(tx, threadId);
          const message = await tx.messages.get(messageId);
          if (!message || message.threadId !== threadId)
            throw notFound('Message not found');
          if (message.purgedAt) return;
          const at = deps.now().toISOString();
          await tx.messages.purge(messageId, 'request', at);
          await tx.documents.purgeForMessage(messageId, at);
          await tx.events.insert({
            id: deps.id(),
            threadId,
            type: 'text_removed',
            actor: { kind: 'user', id: context.actor.id },
            details: { messageId },
            occurredAt: at,
          });
          await tx.audit(
            audit(context, {
              type: 'message.text_removed',
              commandId,
              subjectId: threadId,
              connectionId: thread.connectionId,
              details: { threadId, messageId },
            }),
          );
        },
      );

      return detail(context, threadId);
    },
    /**
     * Reads a thread from the mailbox again and stores new messages, for example to confirm a
     * reply arrived. Requires `messages.read`; returns how many messages were new.
     */
    async refreshThread(context: TenantContext, threadId: string) {
      context = await authorize(context, 'messages.read');
      if (!deps.reader)
        throw unavailable('Reading mailboxes is unavailable. Try again later.');
      const { thread, mailbox, rules } = await deps.store.transaction(
        context.tenantId,
        async (tx) => {
          const thread = await tx.threads.get(threadId);
          if (!thread) throw notFound('Thread not found');

          return {
            thread: thread,
            mailbox: await tx.mailboxes.get(thread.connectionId),
            rules: await tx.rules.active(thread.connectionId),
          };
        },
      );
      if (!mailbox) throw notFound('Mailbox not found');
      let cursor: string | null = null;
      let inserted = 0;
      for (let page = 0; page < 10; page++) {
        const result = await deps.reader.thread(context, thread.connectionId, {
          thread: { externalId: thread.providerThreadId, scopeKey: '' },
          cursor,
        });
        if (!result.ok)
          throw unavailable('The mailbox could not be read. Try again later.');
        inserted += await deps.ingest(context, mailbox, rules, result.items);
        if (!result.nextCursor) return { inserted, complete: true };
        cursor = result.nextCursor;
      }

      return { inserted, complete: false };
    },
    /**
     * Open threads whose reply deadline passed or falls within 30 minutes, owned by the reader
     * or unassigned. Reads stored state only, for Needs you.
     */
    async dueReplies(context: TenantContext) {
      context = await authorize(context, 'messages.read');
      const until = new Date(deps.now().getTime() + dueSoonMs).toISOString();
      const { threads, mailboxes } = await deps.store.transaction(
        context.tenantId,
        async (tx) => ({
          threads: await tx.threads.due(until, 200),
          mailboxes: await tx.mailboxes.list(),
        }),
      );
      const labels = new Map(mailboxes.map((m) => [m.connectionId, m.label]));
      const canManage = hasPermission(context, 'messages.manage');

      return threads
        .filter((t) => !t.ownerId || t.ownerId === context.actor.id)
        .map((t) => ({
          threadId: t.id,
          subject: t.subject,
          correspondent: t.document.correspondent,
          mailboxLabel: labels.get(t.connectionId) ?? '',
          ownerId: t.ownerId,
          replyDueAt: t.replyDueAt!,
          lastInboundAt: t.lastInboundAt,
          lastMessageAt: t.lastMessageAt,
          canRespond: canManage,
        }));
    },
  };
}

export type MessagingService = ReturnType<typeof createMessagingService>;
