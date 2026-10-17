import type { TenantContext } from '@luma/identity';
import { conflict, notFound } from '@luma/platform';

import type { Commitment, FollowUp } from '../domain/commitments.js';
import { isMaterialChange } from '../domain/commitments.js';
import { followUpScopeFingerprint } from '../domain/follow-up-snapshot.js';
import {
  followUpResponseError,
  shortfallQuantity,
} from '../domain/supplier-responses.js';
import type { CommitmentContext } from './commitment-context.js';
import { messageText } from './extraction.js';

/**
 * Responses to what suppliers said: commitments recorded by hand or corrected, reviews of
 * extracted commitments, follow-ups on open attention, and the bounded shortfall a decision acts on.
 */
export function createSupplierResponses({
  deps,
  authorize,
  audit,
  command,
  progressFor,
  incomingResult,
}: CommitmentContext) {
  return {
    /** Returns the current bounded remainder for an active decision; proposals must recheck it before effects. */
    async shortfall(
      context: TenantContext,
      orderId: string,
      attentionKey: string,
    ) {
      context = await authorize(context);

      return deps.store.transaction(context.tenantId, false, async (tx) => {
        const order = await tx.order(orderId);
        if (!order) throw notFound('Purchase order not found');
        const commitments = await tx.commitments([orderId]);
        const { progress } = progressFor(order, {
          submissions: await tx.submissions([orderId]),
          commitments,
          followUps: await tx.followUps([orderId]),
          supplier: await tx.supplier(order.supplierId),
          verified: new Set(),
        });
        const attention = progress.attention.find(
          (a) => a.key === attentionKey,
        );
        if (
          !attention ||
          !['commitment_changed', 'receipt_difference'].includes(attention.kind)
        )
          throw conflict(
            'This difference no longer needs a decision. Refresh the order.',
          );
        const fact = commitments.find((c) => c.id === attention.commitmentId);
        const affected = attention.lineId
          ? progress.lines.filter((line) => line.lineId === attention.lineId)
          : progress.lines;

        return {
          supplierId: order.supplierId,
          quantities: affected
            .map((line) => ({
              sku: line.sku,
              lineId: line.lineId,
              quantity: shortfallQuantity(fact, line),
            }))
            .filter((line) => line.quantity > 0),
          evidenceRefs: [orderId, ...(fact ? [fact.id] : [])],
        };
      });
    },

    /** Records what a supplier said by hand, citing a message, or corrects a commitment. */
    async recordCommitment(
      context: TenantContext,
      orderId: string,
      input: unknown,
    ) {
      context = await authorize(context, true);
      const request = deps.parse.commitment(input);

      return incomingResult(
        context,
        orderId,
        command(
          context,
          request.id,
          { command: 'commitment', orderId, ...request },
          async (tx) => {
            const order = await tx.order(orderId);
            if (!order) throw notFound('Purchase order not found');
            const line = request.lineId
              ? order.lines.find((l) => l.id === request.lineId)
              : null;
            if (request.lineId && !line)
              throw conflict('That order line does not exist.');
            if (
              request.kind === 'confirmed_quantity' &&
              (!line || request.quantity === null)
            )
              throw conflict(
                'A confirmed quantity needs a line and a quantity.',
              );
            if (request.kind === 'promised_date' && !request.date)
              throw conflict('A promised date needs a date.');
            if (request.kind === 'condition' && !request.text?.trim())
              throw conflict('Describe the condition.');
            let source: Commitment['source'];
            if (request.supersedes) {
              const prior = await tx.commitment(request.supersedes);
              if (!prior || prior.purchaseOrderId !== orderId)
                throw notFound('The commitment to correct was not found.');
              if (prior.kind === 'received')
                throw conflict(
                  'Receipts come from the purchasing system and cannot be corrected here.',
                );
              if (!request.reason?.trim())
                throw conflict('Explain the correction.');
              source = { kind: 'correction', reason: request.reason.trim() };
            } else {
              if (!request.communicationId || !request.span)
                throw conflict(
                  'Select the words in a supplier message that state this.',
                );
              const communication = await tx.communication(
                request.communicationId,
              );
              if (!communication || communication.purchaseOrderId !== orderId)
                throw notFound('Message not found');
              if (!communication.body && communication.subject === null)
                throw conflict('The message text was removed.');
              const text = messageText({
                subject: communication.subject ?? '',
                body: communication.body ?? '',
              });
              if (
                request.span.start < 0 ||
                request.span.end > text.length ||
                request.span.end <= request.span.start
              )
                throw conflict('The selected words are not in the message.');
              source = {
                kind: 'communication',
                communicationId: communication.id,
                span: request.span,
                extraction: null,
              };
            }
            const now = deps.now().toISOString();
            const submission = (await tx.submissions([orderId]))[0] ?? null;
            const commitment = await tx.insertCommitment(
              {
                id: request.id,
                tenantId: context.tenantId,
                purchaseOrderId: orderId,
                lineId: request.lineId,
                kind: request.kind,
                quantity: ['confirmed_quantity', 'shipped'].includes(
                  request.kind,
                )
                  ? request.quantity
                  : null,
                date: ['promised_date', 'shipped'].includes(request.kind)
                  ? request.date
                  : null,
                text:
                  request.kind === 'condition' ? request.text!.trim() : null,
                source: source,
                status: 'confirmed',
                reviewReasons: [],
                supersedes: request.supersedes,
                recordedAt: now,
                recordedBy: { kind: 'user', id: context.actor.id },
                review: null,
              },
              `manual:${request.id}`,
            );
            // A person who records a change has seen it; record that they accepted it.
            if (
              isMaterialChange(
                commitment,
                line ?? undefined,
                submission?.requestedDeliveryDate ?? null,
              )
            )
              await tx.insertFollowUp({
                id: deps.uuid(`follow-up:commitment_changed:${commitment.id}`),
                tenantId: context.tenantId,
                purchaseOrderId: orderId,
                key: `commitment_changed:${commitment.id}`,
                response: 'accepted',
                note: 'Recorded by hand',
                nextCheckAt: null,
                respondedBy: context.actor.id,
                respondedAt: now,
              });
            await tx.audit(
              audit(
                context,
                'purchase_order.commitment_recorded',
                request.id,
                orderId,
                {
                  commitmentId: request.id,
                  kind: request.kind,
                  lineId: request.lineId ?? '',
                  supersedes: request.supersedes ?? '',
                },
              ),
            );

            return commitment;
          },
        ),
      );
    },
    /** Confirms or rejects an extracted commitment; values are never edited. */
    async reviewCommitment(
      context: TenantContext,
      commitmentId: string,
      input: unknown,
    ) {
      context = await authorize(context, true);
      const request = deps.parse.review(input);

      const result = await deps.store.transaction(
        context.tenantId,
        true,
        async (tx) => {
          const commitment = await tx.commitment(commitmentId);
          if (!commitment) throw notFound('Commitment not found');
          if (commitment.status !== 'needs_review') {
            if (commitment.review?.outcome === request.outcome)
              return commitment;
            throw conflict('This commitment was already reviewed. Refresh it.');
          }
          const now = deps.now().toISOString();
          const reviewed: Commitment = {
            ...commitment,
            status: request.outcome,
            review: { outcome: request.outcome, by: context.actor.id, at: now },
          };
          await tx.reviewCommitment(reviewed);
          if (request.outcome === 'confirmed' && request.acceptChange)
            await tx.insertFollowUp({
              id: deps.uuid(`follow-up:commitment_changed:${commitmentId}`),
              tenantId: context.tenantId,
              purchaseOrderId: commitment.purchaseOrderId,
              key: `commitment_changed:${commitmentId}`,
              response: 'accepted',
              note: 'Accepted while reviewing the supplier message',
              nextCheckAt: null,
              respondedBy: context.actor.id,
              respondedAt: now,
            });
          await tx.audit(
            audit(
              context,
              'purchase_order.commitment_reviewed',
              commitmentId,
              commitment.purchaseOrderId,
              { commitmentId, outcome: request.outcome },
            ),
          );

          return reviewed;
        },
      );
      await deps.incomingChanged?.(context, result.purchaseOrderId);

      return result;
    },
    /** Accepts a supplier change, or records a follow-up and when to check again. */
    async respond(context: TenantContext, orderId: string, input: unknown) {
      context = await authorize(context, true);
      const request = deps.parse.followUp(input);

      return incomingResult(
        context,
        orderId,
        command(
          context,
          request.id,
          { command: 'follow_up', orderId, ...request },
          async (tx) => {
            const order = await tx.order(orderId);
            if (!order) throw notFound('Purchase order not found');
            if (
              (request.expectedOrderRevision !== undefined ||
                request.expectedScopeFingerprint !== undefined) &&
              (request.expectedOrderRevision !== order.revision ||
                request.expectedScopeFingerprint !==
                  followUpScopeFingerprint(order))
            )
              throw conflict(
                'The owned order changed after review. Refresh the proposal; the previous approval cannot authorize changed inputs.',
              );
            const current = {
              followUps: await tx.followUps([orderId]),
              progress: progressFor(order, {
                submissions: await tx.submissions([orderId]),
                commitments: await tx.commitments([orderId]),
                followUps: await tx.followUps([orderId]),
                supplier: await tx.supplier(order.supplierId),
                verified: new Set(),
              }).progress,
            };
            const attention = current.progress.attention.find(
              (a) => a.key === request.key,
            );
            const now = deps.now();
            const error = followUpResponseError(
              attention,
              request,
              now.getTime(),
            );
            if (error) throw conflict(error);
            const followUp: FollowUp = {
              id: request.id,
              tenantId: context.tenantId,
              purchaseOrderId: orderId,
              key: request.key,
              response: request.response,
              note: request.note.trim(),
              nextCheckAt:
                request.response === 'following_up'
                  ? request.nextCheckAt
                  : null,
              respondedBy: context.actor.id,
              respondedAt: now.toISOString(),
            };

            if (!(await tx.insertFollowUp(followUp)))
              throw conflict('Someone already responded. Refresh the order.');
            await tx.audit(
              audit(context, 'purchase_order.follow_up', request.id, orderId, {
                key: request.key,
                response: request.response,
                nextCheckAt: followUp.nextCheckAt ?? '',
                reason: followUp.note,
              }),
            );

            return followUp;
          },
        ),
      );
    },
  };
}
