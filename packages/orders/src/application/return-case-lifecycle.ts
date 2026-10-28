import { hasPermission, type TenantContext } from '@luma/identity';
import { conflict, invalid, notFound } from '@luma/platform';

import {
  cancelCase,
  checkOpenLines,
  type DecisionEvidence,
  lineAvailability,
  proposeResolution,
  recordInspection,
  recordReceipt,
  type ResolutionKind,
  type ReturnCase,
  ReturnCaseError,
  type ReturnCaseLine,
} from '../domain/return-cases.js';
import type { ReturnCaseSupport } from './return-case-support.js';
import type { ReturnCaseViews } from './return-case-views.js';
import type {
  CaseCommand,
  OpenCaseInput,
  ReturnCaseDependencies,
  ReturnCaseEvent,
  ReturnCaseEventKind,
  ReturnCaseTransaction,
} from './return-cases.js';

/** Runs a domain rule and reports a broken rule as an HTTP error with its message. */
function rule<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (!(error instanceof ReturnCaseError)) throw error;
    if (error.code === 'invalid') throw invalid(error.message);
    if (error.code === 'conflict') throw conflict(error.message);
    throw notFound(error.message);
  }
}

/**
 * Case commands: opening, assignment, receipt, inspection, proposed resolution and
 * cancellation. Each is revision-checked, idempotent by command ID and audited in its
 * transaction.
 */
export function createReturnCaseLifecycle(
  deps: ReturnCaseDependencies,
  support: ReturnCaseSupport,
  views: ReturnCaseViews,
) {
  const { authorize, audit, event, saveCreation } = support;
  const { detail } = views;

  /**
   * Runs a change once per command ID inside one write transaction. An exact retry by the same
   * actor changes nothing; a different request with a used ID is a conflict.
   */
  async function command(
    context: TenantContext,
    commandId: string,
    request: unknown,
    operation: (tx: ReturnCaseTransaction, digest: string) => Promise<void>,
  ) {
    const digest = deps.digest({ actorId: context.actor.id, request });
    await deps.store.transaction(context.tenantId, true, async (tx) => {
      const prior = await tx.event(commandId);
      if (prior) {
        if (prior.digest !== digest)
          throw conflict(
            'This request ID was already used. Refresh before trying again.',
          );

        return;
      }
      await operation(tx, digest);
    });
  }

  /** Applies a decision to the expected revision and records it in the case history. */
  async function change(
    context: TenantContext,
    caseId: string,
    input: CaseCommand,
    request: unknown,
    kind: ReturnCaseEventKind,
    apply: (
      value: ReturnCase,
      tx: ReturnCaseTransaction,
    ) => Promise<{
      next: ReturnCase;
      evidence: DecisionEvidence | null;
      details: ReturnCaseEvent['details'];
    }>,
  ) {
    await command(
      context,
      input.commandId,
      { caseId, request },
      async (tx, digest) => {
        const value = await tx.case(caseId);
        if (!value) throw notFound('Return case not found');
        if (value.revision !== input.expectedRevision)
          throw conflict('This return case changed. Refresh it and try again.');
        await tx.lockOrder(value.orderId);
        const current = await tx.case(caseId);
        if (!current || current.revision !== input.expectedRevision)
          throw conflict('This return case changed. Refresh it and try again.');
        const applied = await apply(current, tx);
        const next: ReturnCase = {
          ...applied.next,
          revision: value.revision + 1,
          updatedAt: deps.now().toISOString(),
        };
        if (!(await tx.saveCase(next)))
          throw conflict('This return case changed. Refresh it and try again.');
        const entry = event(
          context,
          next,
          input.commandId,
          digest,
          kind,
          applied.evidence,
          applied.details,
        );
        await tx.insertEvent(entry);
        await tx.audit(audit(context, entry, next));
      },
    );

    return detail(context, caseId);
  }

  function decided(context: TenantContext, evidence: DecisionEvidence) {
    return { by: context.actor.id, at: deps.now().toISOString(), evidence };
  }

  return {
    /**
     * Opens a case on one source's order lines. Opening is serialized per order, so concurrent
     * cases can never claim more units than are returnable. Linking a store return lets the case
     * work it; the return then counts only through the case.
     */
    async open(context: TenantContext, orderId: string, input: OpenCaseInput) {
      context = await authorize(context, true);
      await command(
        context,
        input.id,
        { orderId, input },
        async (tx, digest) => {
          if (await tx.case(input.id))
            throw conflict(
              'This request ID was already used. Refresh before trying again.',
            );
          await tx.lockOrder(orderId);
          const sources = await tx.orderSources(orderId);
          if (!sources.length) throw notFound('Order not found');
          const source = sources.find(
            (s) => s.connectionId === input.connectionId,
          );
          if (!source)
            throw invalid('Choose order lines from a source of this order.');
          const cases = (await tx.cases(orderId)).filter(
            (c) => c.connectionId === input.connectionId,
          );
          if (input.sourceReturnId) {
            const linked = await tx.sourceReturn(input.sourceReturnId);
            if (
              !linked ||
              linked.orderId !== orderId ||
              linked.connectionId !== input.connectionId
            )
              throw notFound('Store return not found on this order');
            if (['declined', 'cancelled'].includes(linked.status))
              throw conflict('This store return is declined or cancelled.');
            if (
              cases.some(
                (c) =>
                  c.state !== 'cancelled' &&
                  c.sourceReturnId === input.sourceReturnId,
              )
            )
              throw conflict(
                'Another return case already works this store return.',
              );
          }
          const storeReturns = (await tx.storeReturns(orderId)).filter(
            (r) =>
              r.connectionId === input.connectionId &&
              r.entityId !== input.sourceReturnId,
          );
          const byId = new Map(source.lines.map((l) => [l.id, l]));
          const lines: ReturnCaseLine[] = input.lines.map((line) => ({
            orderLineId: line.orderLineId,
            title: byId.get(line.orderLineId)?.title ?? null,
            sku: byId.get(line.orderLineId)?.sku ?? null,
            quantity: line.quantity,
            reason: line.reason,
            note: line.note,
          }));
          rule(() =>
            checkOpenLines(
              lines,
              lineAvailability(source.lines, cases, storeReturns),
            ),
          );
          const now = deps.now().toISOString();
          const value: ReturnCase = {
            id: input.id,
            tenantId: context.tenantId,
            orderId,
            connectionId: input.connectionId,
            sourceReturnId: input.sourceReturnId,
            state: 'open',
            lines,
            assigneeId: null,
            receipt: null,
            inspection: null,
            proposal: null,
            openedBy: context.actor.id,
            openedAt: now,
            cancellation: null,
            revision: 1,
            updatedAt: now,
          };
          await tx.insertCase(value);
          const entry = event(
            context,
            value,
            input.id,
            digest,
            'opened',
            null,
            {
              lines: lines.map((l) => ({
                orderLineId: l.orderLineId,
                quantity: l.quantity,
              })),
            },
          );
          await tx.insertEvent(entry);
          await tx.audit(
            audit(
              context,
              entry,
              value,
              input.sourceReturnId ? [input.sourceReturnId] : [],
            ),
          );
        },
      );

      return detail(context, input.id);
    },

    /** Assigns receiving and inspecting to a current member who can manage returns, or clears it. */
    async assign(
      context: TenantContext,
      caseId: string,
      input: CaseCommand & { assigneeId: string | null },
    ) {
      context = await authorize(context, true);
      if (input.assigneeId) {
        const assignee = await deps
          .principal(
            input.assigneeId,
            context.tenantId,
            `return-case-assignee:${caseId}`,
          )
          .catch(() => null);
        if (!assignee || !hasPermission(assignee, 'returns.manage'))
          throw conflict('Choose a current member who can manage returns.');
      }

      return change(
        context,
        caseId,
        input,
        input,
        'assigned',
        async (value) => {
          if (value.state !== 'open')
            throw conflict(
              'This return case is cancelled. Open a new case instead.',
            );

          return {
            next: { ...value, assigneeId: input.assigneeId },
            evidence: null,
            details: { assigneeId: input.assigneeId },
          };
        },
      );
    },

    /** Records the units that arrived; replaces an earlier receipt and the decisions after it. */
    async recordReceipt(
      context: TenantContext,
      caseId: string,
      input: CaseCommand & {
        lines: { orderLineId: string; received: number }[];
        evidence: DecisionEvidence;
      },
    ) {
      context = await authorize(context, true);
      const actor = context;

      return change(
        context,
        caseId,
        input,
        input,
        'receipt_recorded',
        async (value) => ({
          next: rule(() =>
            recordReceipt(value, {
              ...decided(actor, input.evidence),
              lines: input.lines,
            }),
          ),
          evidence: input.evidence,
          details: { lines: input.lines },
        }),
      );
    },

    /** Judges received units as resellable or damaged; clears an earlier proposal. */
    async recordInspection(
      context: TenantContext,
      caseId: string,
      input: CaseCommand & {
        lines: { orderLineId: string; resellable: number; damaged: number }[];
        evidence: DecisionEvidence;
      },
    ) {
      context = await authorize(context, true);
      const actor = context;

      return change(
        context,
        caseId,
        input,
        input,
        'inspection_recorded',
        async (value) => ({
          next: rule(() =>
            recordInspection(value, {
              ...decided(actor, input.evidence),
              lines: input.lines,
            }),
          ),
          evidence: input.evidence,
          details: { lines: input.lines },
        }),
      );
    },

    /** Proposes a resolution. It is only a proposal; nothing is refunded or restocked. */
    async proposeResolution(
      context: TenantContext,
      caseId: string,
      input: CaseCommand & {
        kind: ResolutionKind;
        lines: { orderLineId: string; restock: number }[];
        evidence: DecisionEvidence;
      },
    ) {
      context = await authorize(context, true);
      const actor = context;

      return change(
        context,
        caseId,
        input,
        input,
        'resolution_proposed',
        async (value) => ({
          next: rule(() =>
            proposeResolution(value, {
              ...decided(actor, input.evidence),
              kind: input.kind,
              lines: input.lines,
            }),
          ),
          evidence: input.evidence,
          details: { resolution: input.kind, lines: input.lines },
        }),
      );
    },

    /**
     * Cancels a case and frees its units. Refused while the return is being created in the
     * order's system; a request still awaiting approval ends with the case.
     */
    async cancel(
      context: TenantContext,
      caseId: string,
      input: CaseCommand & { reason: string },
    ) {
      context = await authorize(context, true);
      const actor = context;

      return change(
        context,
        caseId,
        input,
        input,
        'cancelled',
        async (value, tx) => {
          const creations = await tx.creations(caseId);
          if (
            creations.some((c) =>
              ['approved', 'sending', 'uncertain'].includes(c.state),
            )
          )
            throw conflict(
              'The return is being created in the order’s system. Wait until Luma has checked the result.',
            );
          for (const creation of creations)
            if (creation.state === 'approval_required')
              await saveCreation(tx, creation, {
                state: 'failed',
                failure: 'changed',
              });

          return {
            next: rule(() =>
              cancelCase(value, {
                by: actor.actor.id,
                at: deps.now().toISOString(),
                reason: input.reason,
              }),
            ),
            evidence: null,
            details: { reason: input.reason },
          };
        },
      );
    },
  };
}
