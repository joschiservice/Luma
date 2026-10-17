import type {
  CapabilityReader,
  ConnectionManagement,
  InstalledConnection,
  MessageSnapshot,
  Page,
} from '@luma/connections';
import type {
  IdentityService,
  Permission,
  TenantContext,
} from '@luma/identity';
import { hasPermission, IdentityError } from '@luma/identity';
import type {
  MailboxConnections,
  MemberDirectory,
  MessageReader,
  ProcurementHandoff,
  ReadResult,
  RecordDirectory,
} from '@luma/messaging';
import type { TenantDatabase } from '@luma/platform';
import type { SupplierCommitments } from '@luma/procurement/composition';

/** The member who installed each connection, from its first lifecycle event. */
async function installers(
  database: TenantDatabase,
  tenantId: string,
  connectionIds: string[],
) {
  if (!connectionIds.length) return new Map<string, string>();

  return database.transaction(
    tenantId,
    async (tx) =>
      new Map(
        (
          await tx.query<{ connection_id: string; actor_id: string }>(
            `SELECT DISTINCT ON (connection_id) connection_id,actor_id FROM connector_lifecycle_events
            WHERE tenant_id=$1 AND connection_id=ANY($2::uuid[]) ORDER BY connection_id,version`,
            [tenantId, connectionIds],
          )
        ).rows.map((row) => [row.connection_id, row.actor_id]),
      ),
  );
}

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
      const installedBy = await installers(
        database,
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

const caseLabels: Record<string, string> = {
  sync_failure: 'Sync failure',
  stuck_fulfillment: 'Stuck fulfillment',
  inventory_mismatch: 'Inventory mismatch',
  order_quantity_mismatch: 'Order quantity difference',
  stock_sync_stall: 'Stock sync stalled',
  workflow_failure: 'Workflow failure',
};

/**
 * Deliberate cross-owner reads for linking and labels: canonical order numbers, purchase-order
 * references, customer profile emails, supplier names and case kinds. Exact matches only.
 */
export function createRecordDirectory(
  database: TenantDatabase,
): RecordDirectory {
  return {
    async references(context, keys) {
      return database.transaction(context.tenantId, async (tx) => {
        const orders = await tx.query<{ id: string; key: string }>(
          `SELECT entity_id AS id,upper(display_number_key) AS key FROM orders_list
          WHERE tenant_id=$1 AND selected AND display_number_key=ANY($2::text[] || ARRAY(SELECT lower(k) FROM unnest($2::text[]) k))`,
          [context.tenantId, keys],
        );
        const purchaseOrders = await tx.query<{ id: string; key: string }>(
          `SELECT o.id,k.key FROM procurement_purchase_orders o
          CROSS JOIN LATERAL (SELECT upper(o.document->>'reference') AS key
            UNION SELECT upper(r->>'externalId') FROM jsonb_array_elements(COALESCE(o.document->'externalReferences','[]')) r) k
          WHERE o.tenant_id=$1 AND k.key=ANY($2::text[])`,
          [context.tenantId, keys],
        );

        return [
          ...orders.rows.map((r) => ({ kind: 'order' as const, ...r })),
          ...purchaseOrders.rows.map((r) => ({
            kind: 'purchase_order' as const,
            ...r,
          })),
        ];
      });
    },
    async customers(context, emails) {
      return database.transaction(
        context.tenantId,
        async (tx) =>
          (
            await tx.query<{ id: string; email: string }>(
              'SELECT id,email_key AS email FROM customer_profiles WHERE tenant_id=$1 AND email_key=ANY($2::text[])',
              [context.tenantId, emails],
            )
          ).rows,
      );
    },
    async labels(context, records) {
      const ids = (kind: string) =>
        records.filter((r) => r.kind === kind).map((r) => r.id);
      const uuids = (kind: string) =>
        ids(kind).filter((id) => /^[0-9a-f-]{36}$/i.test(id));

      return database.transaction(context.tenantId, async (tx) => {
        const labels = new Map<string, string>();
        const add = (
          kind: string,
          rows: { id: string; label: string | null }[],
        ) => {
          for (const row of rows)
            labels.set(`${kind}:${row.id}`, row.label ?? 'Unnamed');
        };
        if (uuids('order').length)
          add(
            'order',
            (
              await tx.query<{ id: string; label: string | null }>(
                `SELECT entity_id AS id,COALESCE(display_number,'Order') AS label FROM orders_list
                WHERE tenant_id=$1 AND selected AND entity_id=ANY($2::uuid[])`,
                [context.tenantId, uuids('order')],
              )
            ).rows,
          );
        if (uuids('customer').length)
          add(
            'customer',
            (
              await tx.query<{ id: string; label: string | null }>(
                `SELECT id,COALESCE(display_name,email,'Customer') AS label FROM customer_profiles
                WHERE tenant_id=$1 AND id=ANY($2::uuid[])`,
                [context.tenantId, uuids('customer')],
              )
            ).rows,
          );
        if (uuids('supplier').length)
          add(
            'supplier',
            (
              await tx.query<{ id: string; label: string | null }>(
                "SELECT id,document->>'name' AS label FROM procurement_suppliers WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
                [context.tenantId, uuids('supplier')],
              )
            ).rows,
          );
        if (uuids('purchase_order').length)
          add(
            'purchase_order',
            (
              await tx.query<{ id: string; label: string | null }>(
                "SELECT id,document->>'reference' AS label FROM procurement_purchase_orders WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
                [context.tenantId, uuids('purchase_order')],
              )
            ).rows,
          );
        if (uuids('case').length)
          add(
            'case',
            (
              await tx.query<{ id: string; kind: string }>(
                "SELECT id,document->>'exceptionClass' AS kind FROM exceptions WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
                [context.tenantId, uuids('case')],
              )
            ).rows.map((row) => ({
              id: row.id,
              label: caseLabels[row.kind] ?? 'Issue',
            })),
          );

        return labels;
      });
    },
    async orderSuppliers(context, orderIds) {
      return database.transaction(
        context.tenantId,
        async (tx) =>
          new Map(
            (
              await tx.query<{ id: string; supplier_id: string }>(
                'SELECT id,supplier_id FROM procurement_purchase_orders WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
                [context.tenantId, orderIds],
              )
            ).rows.map((row) => [row.id, row.supplier_id]),
          ),
      );
    },
  };
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
        if (error instanceof IdentityError && error.statusCode === 403)
          return 'forbidden';
        // The same message was recorded under an earlier request.
        if (error instanceof IdentityError && error.statusCode === 409)
          return 'duplicate';
        throw error;
      }
    },
  };
}
