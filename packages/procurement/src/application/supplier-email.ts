import type { TenantContext } from '@luma/identity';
import {
  hasPermission,
  IdentityError,
  requirePermission,
  requireTenant,
} from '@luma/identity';

import type { OrderProgress, Submission } from '../domain/commitments.js';
import type { PurchaseOrder, Supplier } from '../domain/procurement.js';
import type { SupplierCommitments } from './commitments.js';

/** Reviewed company identity for the supplier's order document. */
export interface PurchasingCompany {
  name: string;
  address: string;
  registration: string | null;
}

export interface SupplierEmailDraft {
  id: string;
  threadId: string;
  connectionId: string;
  subject: string;
  text: string;
  state:
    | 'draft'
    | 'approval_required'
    | 'approved'
    | 'rejected'
    | 'expired'
    | 'sending'
    | 'uncertain'
    | 'sent'
    | 'failed'
    | 'withheld'
    | 'discarded';
  stateReason: string | null;
  sentMessageId: string | null;
  attachments?: { filename: string; mimeType: string; size: number }[];
}

export interface SupplierMailWork {
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
}

export interface SupplierEmailInput {
  id: string;
  connectionId: string;
  requestedDeliveryDate: string;
  company: PurchasingCompany;
}

export interface SupplierFollowUpInput {
  id: string;
  connectionId: string;
  threadId?: string | undefined;
  attentionKey: string;
  nextCheckAt: string;
  reason: string;
}

/** Operations Inbox ports keep content, thread work, attachments and sending in the mail owner. */
export interface SupplierMailbox {
  mailboxes(context: TenantContext): Promise<{
    items: {
      connectionId: string;
      label: string;
      address: string | null;
      connectionStatus: string;
      canSend: boolean;
    }[];
  }>;
  threads(
    context: TenantContext,
    purchaseOrderId: string,
  ): Promise<{ id: string; connectionId: string; address: string | null }[]>;
  attachment(
    context: TenantContext,
    purchaseOrderId: string,
    outboundId: string,
  ): Promise<{ filename: string; mimeType: string; base64: string }>;
  work(
    context: TenantContext,
    purchaseOrderId: string,
  ): Promise<{ outbound: SupplierEmailDraft; work: SupplierMailWork }[]>;
  compose(
    context: TenantContext,
    input: {
      id: string;
      connectionId: string;
      threadId?: string;
      to: { address: string; name: string | null }[];
      subject: string;
      text: string;
      language: 'en' | 'de';
      records: { kind: 'purchase_order' | 'supplier'; id: string }[];
      attachments?: { filename: string; mimeType: string; base64: string }[];
      procurement: SupplierMailWork;
    },
  ): Promise<SupplierEmailDraft>;
}

function conflict(message: string): never {
  throw new IdentityError(409, 'CONFLICT', message);
}

/**
 * Drafts supplier work in the existing inbox. Only its verified send hands off a submission
 * or moves a follow-up deadline; acceptance never creates a supplier confirmation.
 */
export function createSupplierEmail(deps: {
  commitments: {
    order(
      context: TenantContext,
      id: string,
    ): Promise<{
      order: PurchaseOrder;
      supplier: Supplier | null;
      progress: OrderProgress;
      submission: Submission | null;
    }>;
    respond(
      context: TenantContext,
      id: string,
      input: unknown,
    ): Promise<unknown>;
    recordEmailSubmission(
      context: TenantContext,
      input: Parameters<SupplierCommitments['recordEmailSubmission']>[1],
    ): Promise<unknown>;
  };
  inbox: SupplierMailbox;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  available(
    context: TenantContext,
    feature: 'submission' | 'follow_up',
  ): Promise<boolean>;
  pdf(input: {
    order: Awaited<ReturnType<SupplierCommitments['order']>>['order'];
    supplierName: string;
    company: PurchasingCompany;
    language: 'en' | 'de';
    requestedDeliveryDate: string;
  }): Promise<Uint8Array>;
  parseSubmission(input: unknown): SupplierEmailInput;
  parseFollowUp(input: unknown): SupplierFollowUpInput;
  now(): Date;
  digest(value: unknown): string;
}) {
  async function authorize(context: TenantContext, write: boolean) {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Sign in again to continue.');
    requirePermission(fresh, 'procurement.read');
    requirePermission(fresh, 'messages.read');
    if (write) {
      requirePermission(fresh, 'procurement.manage');
      requirePermission(fresh, 'messages.send');
    }

    return fresh;
  }

  async function ready(
    context: TenantContext,
    connectionId: string,
    feature: 'submission' | 'follow_up',
  ) {
    if (!(await deps.available(context, feature)))
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Supplier email is not enabled for this workspace.',
      );
    const mailbox = (await deps.inbox.mailboxes(context)).items.find(
      (m) => m.connectionId === connectionId,
    );
    if (!mailbox || mailbox.connectionStatus !== 'active' || !mailbox.canSend)
      conflict(
        'Connect an Operations Inbox with permission to send before drafting supplier mail.',
      );
  }

  return {
    /** Lists available mailboxes and persisted supplier drafts, with explicit rollout availability. */
    async status(context: TenantContext, purchaseOrderId: string) {
      context = await authorize(context, false);
      await deps.commitments.order(context, purchaseOrderId);
      const [submission, followUp, mailboxes, items] = await Promise.all([
        deps.available(context, 'submission'),
        deps.available(context, 'follow_up'),
        deps.inbox.mailboxes(context),
        deps.inbox.work(context, purchaseOrderId),
      ]);

      return {
        canCompose:
          hasPermission(context, 'procurement.manage') &&
          hasPermission(context, 'messages.send'),
        submissionAvailable: submission,
        followUpAvailable: followUp,
        mailboxes: mailboxes.items
          .filter((m) => m.connectionStatus === 'active' && m.canSend)
          .map((m) => ({
            connectionId: m.connectionId,
            label: m.label,
            address: m.address,
          })),
        items,
      };
    },
    /** Reads the exact draft PDF for review; the inbox owner applies retention and authorization. */
    async document(
      context: TenantContext,
      purchaseOrderId: string,
      outboundId: string,
    ) {
      context = await authorize(context, false);
      await deps.commitments.order(context, purchaseOrderId);

      return deps.inbox.attachment(context, purchaseOrderId, outboundId);
    },
    /** Creates an immutable order attachment and a reviewable inbox draft; sending is separate. */
    async submission(
      context: TenantContext,
      purchaseOrderId: string,
      input: unknown,
    ) {
      context = await authorize(context, true);
      const request = deps.parseSubmission(input);
      await ready(context, request.connectionId, 'submission');
      const retry = (await deps.inbox.work(context, purchaseOrderId)).find(
        (item) => item.outbound.id === request.id,
      );
      const requestDigest = deps.digest({
        actorId: context.actor.id,
        purchaseOrderId,
        request,
      });
      if (retry) {
        if (retry.work.requestDigest !== requestDigest)
          conflict('This request ID was used for another draft.');

        return retry.outbound;
      }
      const record = await deps.commitments.order(context, purchaseOrderId);
      if (
        record.supplier?.link ||
        record.order.authority !== 'luma' ||
        !['draft', 'open'].includes(record.order.status)
      )
        conflict('This order uses a purchasing system or cannot be submitted.');
      if (!record.supplier?.email)
        conflict('Add the supplier’s email address before drafting the order.');
      // At most one live submission per order, including drafts created by another buyer.
      const existing = (await deps.inbox.work(context, purchaseOrderId)).find(
        (item) =>
          item.work.kind === 'submission' &&
          !['failed', 'discarded', 'rejected', 'expired', 'withheld'].includes(
            item.outbound.state,
          ),
      );
      if (existing && existing.outbound.id !== request.id)
        conflict(
          'A submission already exists for this order. Review it in the Operations Inbox.',
        );
      if (
        record.submission &&
        !['failed', 'rejected', 'expired'].includes(record.submission.state) &&
        record.submission.outgoing?.outboundId !== request.id
      )
        conflict('This order already has an active submission.');
      const language = record.supplier.language ?? 'en';
      let bytes: Uint8Array;
      try {
        bytes = await deps.pdf({
          order: record.order,
          supplierName: record.supplier.name,
          company: request.company,
          language,
          requestedDeliveryDate: request.requestedDeliveryDate,
        });
      } catch {
        conflict(
          'The purchasing PDF could not be created. Check company and article text for unsupported characters.',
        );
      }
      const subject =
        language === 'de'
          ? `Bestellung ${record.order.reference}`
          : `Purchase order ${record.order.reference}`;
      const text =
        language === 'de'
          ? `Guten Tag ${record.supplier.name},\n\nunsere Bestellung ${record.order.reference} finden Sie im Anhang. Gewünschter Liefertermin: ${request.requestedDeliveryDate}. Bitte bestätigen Sie Mengen, Preise und Liefertermin.\n\n${request.company.name}`
          : `Hello ${record.supplier.name},\n\nPlease find purchase order ${record.order.reference} attached. Requested delivery date: ${request.requestedDeliveryDate}. Please confirm quantities, prices and the delivery date.\n\n${request.company.name}`;

      return deps.inbox.compose(context, {
        id: request.id,
        connectionId: request.connectionId,
        to: [{ address: record.supplier.email, name: record.supplier.name }],
        subject,
        text,
        language,
        records: [
          { kind: 'purchase_order', id: purchaseOrderId },
          { kind: 'supplier', id: record.supplier.id },
        ],
        attachments: [
          {
            filename: `purchase-order-${request.id}.pdf`,
            mimeType: 'application/pdf',
            base64: Buffer.from(bytes!).toString('base64'),
          },
        ],
        procurement: {
          purchaseOrderId,
          supplierId: record.supplier.id,
          kind: 'submission',
          requestDigest,
          requestedDeliveryDate: request.requestedDeliveryDate,
          orderRevision: record.order.revision,
          supplierRevision: record.supplier.revision ?? 1,
        },
      });
    },
    /** Prefills an overdue supplier follow-up; only a person can request its approved send. */
    async followUp(
      context: TenantContext,
      purchaseOrderId: string,
      input: unknown,
    ) {
      context = await authorize(context, true);
      const request = deps.parseFollowUp(input);
      await ready(context, request.connectionId, 'follow_up');
      const retry = (await deps.inbox.work(context, purchaseOrderId)).find(
        (item) => item.outbound.id === request.id,
      );
      const requestDigest = deps.digest({
        actorId: context.actor.id,
        purchaseOrderId,
        request,
      });
      if (retry) {
        if (retry.work.requestDigest !== requestDigest)
          conflict('This request ID was used for another draft.');

        return retry.outbound;
      }
      const record = await deps.commitments.order(context, purchaseOrderId);
      if (
        record.submission?.channel === 'email' &&
        record.submission.state === 'failed'
      )
        conflict(
          'Resolve the failed order email in the Operations Inbox before following up.',
        );
      const attention = record.progress.attention.find(
        (item) =>
          item.key === request.attentionKey &&
          ['confirmation_overdue', 'delivery_overdue'].includes(item.kind),
      );
      if (!attention)
        conflict(
          'This deadline changed. Refresh the order before following up.',
        );
      const time = Date.parse(request.nextCheckAt) - deps.now().getTime();
      if (time <= 0 || time > 60 * 86_400_000)
        conflict('Choose a next check within the next 60 days.');
      const threads = (
        await deps.inbox.threads(context, purchaseOrderId)
      ).filter((t) => t.connectionId === request.connectionId);
      const thread = request.threadId
        ? threads.find((t) => t.id === request.threadId)
        : threads[0];
      if (request.threadId && !thread)
        conflict('The thread is not linked to this order.');
      const recipient = record.supplier?.email ?? thread?.address;
      if (!recipient)
        conflict(
          'Add a supplier email address or link its inbox thread before following up.',
        );
      const language = record.supplier?.language ?? 'en';
      const lines = record.progress.lines
        .filter(
          (line) =>
            (!attention.lineId || line.lineId === attention.lineId) &&
            line.outstanding > 0,
        )
        .map((line) =>
          language === 'de'
            ? `${line.description}: ${line.outstanding} ${line.unit === 'each' ? 'Stück' : line.unit} offen; bestätigt: ${line.confirmed ?? 'nicht bestätigt'}; zugesagt: ${line.promisedDate ?? 'kein Termin'}; angefragt: ${line.requestedDate ?? 'kein Termin'}.`
            : `${line.description}: ${line.outstanding} ${line.unit} outstanding; confirmed: ${line.confirmed ?? 'not confirmed'}; promised: ${line.promisedDate ?? 'no date'}; requested: ${line.requestedDate ?? 'no date'}.`,
        );
      const subject = `${thread ? 'Re: ' : ''}${language === 'de' ? 'Bestellung' : 'Purchase order'} ${record.order.reference}`;
      const text =
        language === 'de'
          ? `Guten Tag ${record.supplier?.name ?? ''},\n\nbitte teilen Sie uns den aktuellen Stand unserer Bestellung ${record.order.reference} mit. ${attention.kind === 'confirmation_overdue' ? 'Ihre Bestätigung steht noch aus.' : 'Die zugesagte Lieferung ist überfällig.'}\n\n${lines.join('\n')}\n\nBitte bestätigen Sie die ausstehenden Mengen und einen aktuellen Liefertermin. Vielen Dank.`
          : `Hello ${record.supplier?.name ?? ''},\n\nPlease update us on purchase order ${record.order.reference}. ${attention.kind === 'confirmation_overdue' ? 'We are still waiting for your confirmation.' : 'The promised delivery is overdue.'}\n\n${lines.join('\n')}\n\nPlease confirm the outstanding quantities and an updated delivery date. Thank you.`;

      return deps.inbox.compose(context, {
        id: request.id,
        connectionId: request.connectionId,
        ...(thread ? { threadId: thread.id } : {}),
        to: [{ address: recipient, name: record.supplier?.name ?? null }],
        subject,
        text,
        language,
        records: [
          { kind: 'purchase_order', id: purchaseOrderId },
          { kind: 'supplier', id: record.order.supplierId },
        ],
        procurement: {
          purchaseOrderId,
          supplierId: record.order.supplierId,
          kind: 'follow_up',
          requestDigest,
          orderRevision: record.order.revision,
          supplierRevision: record.supplier?.revision ?? 1,
          attentionKey: request.attentionKey,
          nextCheckAt: request.nextCheckAt,
          reason: request.reason,
        },
      });
    },
    /** Checks the current order and supplier before any approved mailbox dispatch. */
    async eligible(
      context: TenantContext,
      outbound: { document: { procurement?: SupplierMailWork } },
    ) {
      const work = outbound.document.procurement;
      if (!work) return true;
      try {
        context = await authorize(context, true);
        if (!(await deps.available(context, work.kind))) return false;
        const record = await deps.commitments.order(
          context,
          work.purchaseOrderId,
        );
        if (
          record.order.revision !== work.orderRevision ||
          (record.supplier?.revision ?? 1) !== work.supplierRevision ||
          !['draft', 'open'].includes(record.order.status)
        )
          return false;

        return work.kind === 'submission'
          ? record.order.authority === 'luma' && !record.supplier?.link
          : record.progress.attention.some(
              (item) => item.key === work.attentionKey,
            );
      } catch {
        return false;
      }
    },
    /** Idempotent record-owner handoff, retried after restarts; never dispatches mail itself. */
    async settled(
      context: TenantContext,
      outbound: {
        id: string;
        threadId: string;
        connectionId: string;
        state: string;
        document: {
          procurement?: SupplierMailWork;
          sentMessageId?: string | null;
          stateReason?: string | null;
        };
      },
    ) {
      const work = outbound.document.procurement;
      if (!work) return;
      if (
        work.kind === 'submission' &&
        work.requestedDeliveryDate &&
        ['sent', 'failed', 'uncertain'].includes(outbound.state)
      ) {
        await deps.commitments.recordEmailSubmission(context, {
          id: outbound.id,
          purchaseOrderId: work.purchaseOrderId,
          outboundId: outbound.id,
          threadId: outbound.threadId,
          connectionId: outbound.connectionId,
          requestedDeliveryDate: work.requestedDeliveryDate,
          state:
            outbound.state === 'sent'
              ? 'submitted'
              : outbound.state === 'failed'
                ? 'failed'
                : 'uncertain',
          ...(outbound.document.sentMessageId
            ? { sentMessageId: outbound.document.sentMessageId }
            : {}),
          ...(outbound.document.stateReason
            ? { reason: outbound.document.stateReason }
            : {}),
        });
      }
      if (
        work.kind === 'follow_up' &&
        outbound.state === 'sent' &&
        work.attentionKey &&
        work.nextCheckAt
      ) {
        await deps.commitments.respond(context, work.purchaseOrderId, {
          id: outbound.id,
          key: work.attentionKey,
          response: 'following_up',
          note: `${work.reason ?? ''}\nVerified outgoing message: ${outbound.document.sentMessageId ?? outbound.id}; inbox thread: ${outbound.threadId}`,
          nextCheckAt: work.nextCheckAt,
        });
      }
    },
  };
}

export type SupplierEmail = ReturnType<typeof createSupplierEmail>;
