import type { TenantContext } from '@luma/identity';
import { conflict, notFound } from '@luma/platform';

import type { Communication, Extraction } from '../domain/commitments.js';
import { reviewReasons } from '../domain/commitments.js';
import type { PurchaseOrder } from '../domain/procurement.js';
import { type CommitmentContext, hour } from './commitment-context.js';
import { extractFacts, messageText } from './extraction.js';

/**
 * Supplier messages: capture with retention, cited extraction of their commitments, another
 * reading after a failed attempt, and removal of their text on request.
 */
export function createSupplierMessages({
  deps,
  authorize,
  audit,
  command,
}: CommitmentContext) {
  function factSourceKey(
    communicationId: string,
    fact: {
      kind: string;
      lineId: string | null;
      quantity: number | null;
      date: string | null;
      text: string | null;
    },
  ) {
    return `message:${communicationId}:${deps.digest(fact)}`;
  }

  /** Reads a message's commitments with the model and records them with the attempt. */
  async function extractInto(
    context: TenantContext,
    communication: Communication,
    order: PurchaseOrder,
    attempt: number,
  ) {
    const submission = await deps.store.transaction(
      context.tenantId,
      false,
      async (tx) => (await tx.submissions([order.id]))[0] ?? null,
    );
    const requestedDate = submission?.requestedDeliveryDate ?? null;
    const result = await extractFacts({
      tenantId: context.tenantId,
      dataRegion: context.dataRegion,
      gateway: deps.model.gateway,
      output: deps.model.output,
      available: deps.model.available,
      trace: deps.trace(context),
      order,
      requestedDeliveryDate: requestedDate,
      message: {
        subject: communication.subject ?? '',
        body: communication.body ?? '',
        from: communication.from,
        receivedAt: communication.receivedAt,
      },
      id: deps.id,
    });

    return deps.store.transaction(context.tenantId, true, async (tx) => {
      const extraction: Extraction = {
        id: deps.id(),
        tenantId: context.tenantId,
        communicationId: communication.id,
        attempt,
        state: result.state,
        relatesToOrder:
          result.state === 'completed' ? result.relatesToOrder : null,
        commitmentIds: [],
        discarded: result.state === 'completed' ? result.discarded : 0,
        model: result.state === 'completed' ? result.model : null,
        reason: result.state === 'completed' ? null : result.reason,
        createdAt: deps.now().toISOString(),
        createdBy: context.actor.id,
      };
      if (result.state === 'completed') {
        const multiLine = order.lines.length > 1;
        for (const fact of result.facts) {
          const line = order.lines.find((l) => l.id === fact.lineId) ?? null;
          const reasons = reviewReasons(fact, line, requestedDate, {
            senderVerified: communication.senderVerified,
            confident: fact.confident && result.relatesToOrder,
            lineRequired:
              multiLine &&
              (fact.kind === 'confirmed_quantity' || fact.lineId !== null),
          });
          const lineId =
            line?.id ??
            (!multiLine && fact.kind === 'confirmed_quantity'
              ? order.lines[0]!.id
              : null);
          const stored = await tx.insertCommitment(
            {
              id: deps.id(),
              tenantId: context.tenantId,
              purchaseOrderId: order.id,
              lineId,
              kind: fact.kind,
              quantity: fact.quantity,
              date: fact.date,
              text: fact.text,
              source: {
                kind: 'communication',
                communicationId: communication.id,
                span: fact.span,
                extraction: {
                  id: extraction.id,
                  factId: fact.id,
                  model: result.model,
                },
              },
              status: reasons.length ? 'needs_review' : 'confirmed',
              reviewReasons: reasons,
              supersedes: null,
              recordedAt: extraction.createdAt,
              recordedBy: { kind: 'luma', id: 'supplier-extraction' },
              review: null,
            },
            factSourceKey(communication.id, {
              kind: fact.kind,
              lineId,
              quantity: fact.quantity,
              date: fact.date,
              text: fact.text,
            }),
          );
          extraction.commitmentIds.push(stored.id);
        }
      }
      await tx.insertExtraction(extraction);
      await tx.audit(
        audit(context, 'purchase_order.message_read', extraction.id, order.id, {
          communicationId: communication.id,
          state: extraction.state,
          facts: String(extraction.commitmentIds.length),
          model: extraction.model ?? '',
        }),
      );

      return extraction;
    });
  }

  return {
    /**
     * Captures a supplier message for an order and reads its commitments when a model is
     * configured. Repeated deliveries of the same message are recorded once. `provenance` comes
     * only from trusted callers such as the inbox handoff, never from request input; an
     * unverified sender sends every extracted fact to review.
     *
     * Anyone can copy a Message-ID, so only trusted messages (an authenticated sender, or one a
     * person recorded) claim it. An unverified message is keyed by its Message-ID and content:
     * it never suppresses a different message with the same ID, and it is a duplicate only of
     * a copy with the same text.
     */
    async recordMessage(
      context: TenantContext,
      orderId: string,
      input: unknown,
      provenance?: { senderVerified: boolean },
    ) {
      context = await authorize(context, true);
      const request = deps.parse.message(input);
      const digest = deps.digest(messageText(request));
      const trustedKey = request.messageId
        ? `id:${request.messageId}`
        : `digest:${deps.digest({ from: request.from.toLowerCase(), subject: request.subject, receivedAt: request.receivedAt, body: request.body })}`;
      const unverified = provenance?.senderVerified === false;
      const key = unverified
        ? `unverified:${deps.digest({ key: trustedKey, digest })}`
        : trustedKey;
      const { communication, order, created } = await command(
        context,
        request.id,
        { kind: 'message', orderId, ...request },
        async (tx) => {
          const order = await tx.order(orderId);
          if (!order) throw notFound('Purchase order not found');
          const trustedCopy = unverified
            ? await tx.communicationByKey(trustedKey)
            : null;
          const duplicate =
            (await tx.communicationByKey(key)) ??
            (trustedCopy?.digest === digest ? trustedCopy : null);
          if (duplicate)
            return { communication: duplicate, order, created: false };
          const now = deps.now();
          const communication: Communication = {
            id: request.id,
            tenantId: context.tenantId,
            supplierId: order.supplierId,
            purchaseOrderId: orderId,
            channel: request.channel,
            from: request.from,
            subject: request.subject,
            body: request.body,
            receivedAt: request.receivedAt,
            messageId: request.messageId,
            ...(provenance
              ? { senderVerified: provenance.senderVerified }
              : {}),
            digest,
            capturedBy: context.actor.id,
            capturedAt: now.toISOString(),
            retainUntil: new Date(
              Date.parse(request.receivedAt) + deps.retentionDays * 24 * hour,
            ).toISOString(),
          };
          await tx.insertCommunication(communication, key);
          await tx.audit(
            audit(
              context,
              'purchase_order.message_recorded',
              request.id,
              orderId,
              {
                communicationId: request.id,
                channel: request.channel,
              },
            ),
          );

          return { communication, order, created: true };
        },
      );
      if (
        created ||
        !(
          await deps.store.transaction(context.tenantId, false, (tx) =>
            tx.extractions([communication.id]),
          )
        ).length
      )
        await extractInto(context, communication, order, 1);

      return { communicationId: communication.id, duplicate: !created };
    },
    /** Reads a message again after an unavailable or failed attempt. */
    async extractAgain(context: TenantContext, communicationId: string) {
      context = await authorize(context, true);
      const data = await deps.store.transaction(
        context.tenantId,
        false,
        async (tx) => {
          const communication = await tx.communication(communicationId);
          if (!communication?.purchaseOrderId)
            throw notFound('Message not found');

          return {
            communication,
            order: (await tx.order(communication.purchaseOrderId))!,
            attempts: await tx.extractions([communicationId]),
          };
        },
      );
      if (data.attempts.some((a) => a.state === 'completed'))
        throw conflict(
          'This message was already read. Record corrections by hand.',
        );
      if (!data.communication.body)
        throw conflict(
          'The message text was removed and cannot be read again.',
        );

      return extractInto(
        context,
        data.communication,
        data.order,
        data.attempts.length + 1,
      );
    },
    /** Removes a message's text on request, keeping its metadata and commitments. */
    async removeMessageText(context: TenantContext, communicationId: string) {
      context = await authorize(context, true);

      return deps.store.transaction(context.tenantId, true, async (tx) => {
        const communication = await tx.communication(communicationId);
        if (!communication) throw notFound('Message not found');
        if (communication.purgedAt) return communication;
        const purged: Communication = {
          ...communication,
          subject: null,
          body: null,
          purgedAt: deps.now().toISOString(),
          purgeReason: 'request',
        };
        await tx.purgeCommunication(purged);
        await tx.audit(
          audit(
            context,
            'purchase_order.message_removed',
            communicationId,
            communication.purchaseOrderId ?? communication.supplierId,
            { communicationId },
          ),
        );

        return purged;
      });
    },
  };
}
