import type {
  CapabilityReader,
  ConnectionManagement,
  InstalledConnection,
  MessageSnapshot,
  Page,
} from '@luma/connections';
import { createConnectionDirectory } from '@luma/connections/composition';
import type {
  IdentityService,
  Permission,
  TenantContext,
} from '@luma/identity';
import { hasPermission } from '@luma/identity';
import type {
  MailboxConnections,
  MemberDirectory,
  MessageReader,
  ProcurementHandoff,
  ReadResult,
  RecordDirectory,
} from '@luma/messaging';
import type { TenantDatabase } from '@luma/platform';
import { ServiceError } from '@luma/platform';
import type { SupplierCommitments } from '@luma/procurement/composition';
import { createMessageRecordDirectory } from '@luma/read-models/composition';

/** The mailbox address a connection reports in its public settings, when it does. */
function mailboxAddress(connection: InstalledConnection) {
  const target = connection.target;
  const address = target.address ?? target.emailAddress ?? target.email;

  return typeof address === 'string' && address.includes('@')
    ? address.toLowerCase()
    : null;
}

/**
 * Lists installed connections that ask for `messages.read`. Inactive and no longer granted
 * connections stay listed, so their mailboxes show why reading stopped.
 */
export function createMailboxConnections(
  database: TenantDatabase,
  installations: Pick<ConnectionManagement, 'list'>,
): MailboxConnections {
  return {
    async list(context) {
      const connections = (await installations.list(context)).filter((c) =>
        c.permissions.includes('messages.read'),
      );
      const installedBy = await createConnectionDirectory(database).installers(
        context.tenantId,
        connections.map((c) => c.id),
      );

      return connections.map((c) => ({
        id: c.id,
        label: c.label,
        provider: c.provider ?? c.target.kind,
        status: c.status,
        version: c.version,
        address: mailboxAddress(c),
        canRead: c.granted.includes('messages.read'),
        canSend: c.granted.includes('messages.send'),
        installerId: installedBy.get(c.id) ?? null,
      }));
    },
  };
}

type MessagePage =
  | { ok: true; value: Page<MessageSnapshot> }
  | {
      ok: false;
      error: { code: string; retryAfterMs?: number | undefined };
    };

function page(result: MessagePage): ReadResult {
  if (!result.ok)
    return {
      ok: false,
      code: result.error.code,
      retryAfterMs: result.error.retryAfterMs,
    };

  return {
    ok: true,
    // Tombstones carry no message; deleted provider messages stay as read.
    items: result.value.items
      .filter((item) => item.kind === 'snapshot')
      .map((item) => ({
        providerMessageId: item.source.externalId,
        data: item.data,
        observationId: item.id,
        observedAt: item.observedAt,
      })),
    complete: result.value.completeness === 'complete',
    nextCursor: result.value.nextCursor,
    retryAfterMs: result.value.retryAfterMs,
  };
}

/** Reads mailboxes through the installation-gated capability runtime. */
export function createMessageReader(runtime: CapabilityReader): MessageReader {
  return {
    async messages(context, connectionId, input) {
      return page(
        await runtime.read(context, {
          connectionId,
          capability: 'messages.read',
          version: '0',
          input: {
            limit: input.limit,
            filter: input.filter,
            receivedSince: input.receivedSince,
            ...(input.cursor ? { cursor: input.cursor } : {}),
          },
        }),
      );
    },
    async thread(context, connectionId, input) {
      return page(
        await runtime.read(context, {
          connectionId,
          capability: 'message-threads.read',
          version: '0',
          input: {
            limit: 50,
            thread: input.thread,
            ...(input.cursor ? { cursor: input.cursor } : {}),
          },
        }),
      );
    },
  };
}

/**
 * Deliberate cross-owner reads for linking and labels: canonical order numbers, purchase-order
 * references, customer profile emails, supplier names and case kinds. Exact matches only.
 */
export function createRecordDirectory(
  database: TenantDatabase,
): RecordDirectory {
  return createMessageRecordDirectory(database);
}

/** Thread owners must be active members who can read messages. */
export function createMemberDirectory(
  identity: Pick<IdentityService, 'resolveWorkflowContext'>,
): MemberDirectory {
  return {
    async canReadMessages(context, userId) {
      try {
        const member = await identity.resolveWorkflowContext(
          userId,
          context.tenantId,
          `messaging-member:${context.requestId}`,
        );

        return hasPermission(member, 'messages.read' satisfies Permission);
      } catch {
        return false;
      }
    },
  };
}

/**
 * Hands inbound supplier messages to procurement's message path, which stores them once and
 * starts extraction, commitments and follow-ups. Only authenticated senders claim a Message-ID
 * there, so a forged copy cannot suppress the genuine message.
 */
export function createProcurementHandoff(
  commitments: () => SupplierCommitments,
): ProcurementHandoff {
  return {
    async record(context: TenantContext, input) {
      if (!hasPermission(context, 'procurement.manage')) return 'forbidden';
      const { purchaseOrderId, senderVerified, ...message } = input;
      try {
        const result = await commitments().recordMessage(
          context,
          purchaseOrderId,
          { ...message, channel: 'email' },
          { senderVerified },
        );

        return result.duplicate ? 'duplicate' : 'recorded';
      } catch (error) {
        if (error instanceof ServiceError && error.statusCode === 403)
          return 'forbidden';
        // The same message was recorded under an earlier request.
        if (error instanceof ServiceError && error.statusCode === 409)
          return 'duplicate';
        throw error;
      }
    },
  };
}
