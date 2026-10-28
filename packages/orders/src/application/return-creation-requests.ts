import { MembershipSuspendedError, type TenantContext } from '@luma/identity';
import { canonicalJson, conflict, notFound, unavailable } from '@luma/platform';
import type { PolicyDecision } from '@luma/policies';

import {
  liveCreationStates,
  type ReturnCreation,
  type SourceRef,
} from '../domain/return-creations.js';
import {
  creationAction,
  type ReturnCaseSupport,
} from './return-case-support.js';
import type { ReturnCaseViews } from './return-case-views.js';
import type { ReturnCaseDependencies, ReturnOption } from './return-cases.js';
import type { ReturnCreationExecution } from './return-creation-execution.js';

const hour = 3_600_000;

function unreadable(): never {
  throw unavailable(
    'The order’s system could not be read. Check the connection in Apps and try again.',
  );
}

/**
 * Creation commands: the order system's options, approval requests, decisions, sending and
 * rechecks of a case's return in the system its order came from.
 */
export function createReturnCreationRequests(
  deps: ReturnCaseDependencies,
  support: ReturnCaseSupport,
  views: ReturnCaseViews,
  execution: ReturnCreationExecution,
) {
  const { authorize, saveCreation, creationEvent } = support;
  const { detail, viewOf } = views;
  const { settle, dispatch, loadCreation } = execution;

  return {
    /** Warehouses and return reasons the case's order system offers, read now. */
    async creationOptions(context: TenantContext, caseId: string) {
      context = await authorize(context, true);
      if (!deps.system || !deps.admission)
        throw unavailable('Creating returns is unavailable on this server.');
      const value = await deps.store.transaction(
        context.tenantId,
        false,
        (tx) => tx.case(caseId),
      );
      if (!value) throw notFound('Return case not found');
      const result = await deps.system.options(context, value.connectionId);

      return result.ok ? result.value : unreadable();
    },

    /**
     * Asks for approval to create the case's return in its order's system. The lines, warehouse
     * and reason are fixed now; someone else approves exactly these, and Luma then sends it once.
     */
    async requestCreation(
      context: TenantContext,
      caseId: string,
      input: { id: string; warehouse: SourceRef; reason: SourceRef },
    ) {
      context = await authorize(context, true);
      if (!deps.system || !deps.admission)
        throw unavailable('Creating returns is unavailable on this server.');
      const existing = await deps.store.transaction(
        context.tenantId,
        false,
        (tx) => tx.creation(input.id),
      );
      if (existing) {
        if (
          existing.caseId !== caseId ||
          existing.requestedBy !== context.actor.id ||
          canonicalJson([
            existing.warehouse.externalId,
            existing.warehouse.scopeKey,
            existing.reason.externalId,
            existing.reason.scopeKey,
          ]) !==
            canonicalJson([
              input.warehouse.externalId,
              input.warehouse.scopeKey,
              input.reason.externalId,
              input.reason.scopeKey,
            ])
        )
          throw conflict(
            'This request ID was already used. Refresh before trying again.',
          );

        return detail(context, caseId);
      }
      const current = await deps.store.transaction(
        context.tenantId,
        false,
        (tx) => tx.case(caseId),
      );
      if (!current) throw notFound('Return case not found');
      const options = await deps.system.options(context, current.connectionId);
      const choices = options.ok ? options.value : unreadable();
      const pick = (list: ReturnOption[], ref: SourceRef) =>
        list.find(
          (o) => o.externalId === ref.externalId && o.scopeKey === ref.scopeKey,
        );
      const warehouse = pick(choices.warehouses, input.warehouse);
      const reason = pick(choices.reasons, input.reason);
      if (!warehouse || !reason)
        throw conflict(
          'Choose a warehouse and a return reason from the current lists.',
        );
      if ((await detail(context, caseId)).creationAvailability.blocker)
        throw conflict(
          'The return can’t be created in the order’s system right now.',
        );

      const connection = (await deps.system.connections(context)).find(
        (c) => c.id === current.connectionId,
      );
      const creation = await deps.store.transaction(
        context.tenantId,
        true,
        async (tx) => {
          const value = await tx.case(caseId);
          if (!value || value.state !== 'open')
            throw conflict(
              'This return case is cancelled. Open a new case instead.',
            );
          const live = (await tx.creations(caseId)).find((c) =>
            liveCreationStates.includes(c.state),
          );
          if (
            live &&
            !(
              ['approval_required', 'approved'].includes(live.state) &&
              Date.parse(live.expiresAt) <= deps.now().getTime()
            )
          )
            throw conflict(
              'This return is already being created or was created.',
            );
          if (live) await saveCreation(tx, live, { state: 'expired' });
          const ids = await tx.sourceIds(
            value.connectionId,
            value.orderId,
            value.lines.map((l) => l.orderLineId),
          );
          if (
            !ids.order ||
            value.lines.some((l) => !ids.lines.has(l.orderLineId))
          )
            throw conflict('Some lines are not linked to the order’s system.');
          const sourceReturn = value.sourceReturnId
            ? await tx.sourceReturn(value.sourceReturnId)
            : null;
          if (
            connection?.provider === 'shopify' &&
            sourceReturn &&
            (sourceReturn.status !== 'requested' || !sourceReturn.source)
          )
            throw conflict('Only a requested Shopify return can be approved.');
          const now = deps.now();
          const created: ReturnCreation = {
            id: input.id,
            tenantId: context.tenantId,
            caseId,
            connectionId: value.connectionId,
            order: ids.order,
            ...(connection?.provider === 'shopify' && sourceReturn?.source
              ? { requestedReturn: sourceReturn.source }
              : {}),
            warehouse: {
              externalId: warehouse.externalId,
              scopeKey: warehouse.scopeKey,
              name: warehouse.name,
            },
            reason: {
              externalId: reason.externalId,
              scopeKey: reason.scopeKey,
              name: reason.name,
            },
            lines: value.lines.map((l) => ({
              orderLineId: l.orderLineId,
              source: ids.lines.get(l.orderLineId)!,
              quantity: l.quantity,
            })),
            actionId: deps.uuid(
              `return-creation-action:${context.tenantId}:${input.id}`,
            ),
            decisionId: null,
            requestedBy: context.actor.id,
            requestedAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + 24 * hour).toISOString(),
            state: 'approval_required',
            externalReturn: null,
            createdAt: null,
            decidedBy: null,
            decidedAt: null,
            failure: null,
            updatedAt: now.toISOString(),
          };
          await tx.insertCreation(created);
          await creationEvent(context, tx, created, 'creation_requested');

          return created;
        },
      );
      let decision: PolicyDecision;
      try {
        decision = await deps.admission.prepare(
          context,
          creation,
          creationAction(creation),
        );
      } catch {
        await deps.store.transaction(context.tenantId, true, async (tx) =>
          saveCreation(tx, creation, { state: 'failed', failure: 'not_sent' }),
        );
        throw unavailable(
          'Approval could not be requested. Nothing was sent. Try again.',
        );
      }
      const saved = await deps.store.transaction(
        context.tenantId,
        true,
        async (tx) =>
          saveCreation(tx, creation, {
            decisionId: decision.id,
            ...(decision.outcome === 'denied'
              ? { state: 'failed' as const, failure: 'withheld' as const }
              : decision.outcome === 'allowed'
                ? { state: 'approved' as const }
                : {}),
          }),
      );
      if (
        saved.state === 'approved' ||
        (await deps.admission.writeMode?.(context, saved.connectionId)) ===
          'observe_only'
      )
        await dispatch(context, saved);

      return detail(context, caseId);
    },

    /**
     * Approves or rejects a creation. When the workspace requires independent approval, it comes
     * from someone other than the requester. Luma then dispatches it as the requester, exactly
     * once.
     */
    async decideCreation(
      context: TenantContext,
      caseId: string,
      creationId: string,
      input: { decisionId: string; outcome: 'approved' | 'rejected' },
    ) {
      context = await authorize(context, true);
      if (!deps.admission)
        throw unavailable('Creating returns is unavailable on this server.');
      const creation = await loadCreation(context, caseId, creationId);
      const view = await viewOf(context, creation);
      if (!view.canApprove || creation.decisionId !== input.decisionId)
        throw conflict(
          'This request changed, expired or needs a different approver. Refresh it.',
        );
      await deps.admission.respond(
        context,
        input.decisionId,
        input.outcome,
        creation.expiresAt,
      );
      const decidedCreation = await deps.store.transaction(
        context.tenantId,
        true,
        async (tx) => {
          const saved = await saveCreation(tx, creation, {
            state: input.outcome === 'approved' ? 'approved' : 'rejected',
            decidedBy: context.actor.id,
            decidedAt: deps.now().toISOString(),
          });
          await creationEvent(
            context,
            tx,
            saved,
            input.outcome === 'approved'
              ? 'creation_approved'
              : 'creation_rejected',
          );

          return saved;
        },
      );
      if (decidedCreation.state === 'approved') {
        // The approver gains no execution authority; the requester's current membership is
        // resolved and checked again by admission.
        try {
          const principal = await deps.principal(
            decidedCreation.requestedBy,
            context.tenantId,
            `return-creation:${creationId}`,
          );
          await dispatch(principal, decidedCreation);
        } catch {
          // The requester can send an approved creation themselves.
        }
      }

      return detail(context, caseId);
    },

    /** Sends an approved creation now. Only the requester can dispatch it. */
    async sendCreation(
      context: TenantContext,
      caseId: string,
      creationId: string,
    ) {
      context = await authorize(context, true);
      const creation = await loadCreation(context, caseId, creationId);
      const view = await viewOf(context, creation);
      if (!view.canSend)
        throw conflict('Only the requester can send an approved return.');
      await dispatch(context, creation);

      return detail(context, caseId);
    },

    /** Rechecks an uncertain creation by reading the order's system; never sends again. */
    async checkCreation(
      context: TenantContext,
      caseId: string,
      creationId: string,
    ) {
      context = await authorize(context, true);
      if (!deps.admission)
        throw unavailable('Creating returns is unavailable on this server.');
      const creation = await loadCreation(context, caseId, creationId);
      if (['uncertain', 'sending'].includes(creation.state)) {
        const principal = await deps
          .principal(
            creation.requestedBy,
            context.tenantId,
            `return-creation-check:${creationId}`,
          )
          .catch((error: unknown) => {
            if (error instanceof MembershipSuspendedError)
              throw conflict(
                'The person who requested this return can’t access this workspace right now. Luma checks it after their access is restored.',
              );
            throw error;
          });
        await settle(
          principal,
          creationId,
          await deps.admission.reconcile(principal, creation),
        );
      }

      return detail(context, caseId);
    },
  };
}
