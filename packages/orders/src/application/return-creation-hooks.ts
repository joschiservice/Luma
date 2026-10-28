import type { WriteAcceptance } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import { canonicalJson, conflict } from '@luma/platform';

import { matchesCreation } from '../domain/return-creations.js';
import { creationAction } from './return-case-support.js';
import type { ReturnCaseDependencies } from './return-cases.js';
import type { ReturnCreationExecution } from './return-creation-execution.js';
import {
  returnWriteReceipt,
  returnWriteReceiptName,
} from './return-write-receipts.js';

/**
 * Hooks Action Admission and the execution adapter call for return creations: eligibility,
 * verification, write receipts and the action a creation belongs to.
 */
export function createReturnCreationHooks(
  deps: ReturnCaseDependencies,
  execution: ReturnCreationExecution,
) {
  const { locate, recordReads } = execution;

  return {
    /** Admission hook: the bound creation must still match its open case and approval. */
    async eligible(
      context: TenantContext,
      step: { subject?: { kind: string; id: string }; action: unknown },
    ) {
      if (step.subject?.kind !== 'return_case_creation') return false;

      return deps.store.transaction(context.tenantId, false, async (tx) => {
        const creation = await tx.creation(step.subject!.id);
        if (
          !creation ||
          creation.actionId !== (step.action as { id?: string }).id ||
          !['approved', 'sending', 'approval_required'].includes(creation.state)
        )
          return false;
        const value = await tx.case(creation.caseId);
        if (
          !value ||
          value.state !== 'open' ||
          value.connectionId !== creation.connectionId ||
          canonicalJson(value.lines.map((l) => [l.orderLineId, l.quantity])) !==
            canonicalJson(
              creation.lines.map((l) => [l.orderLineId, l.quantity]),
            )
        )
          return false;

        return (
          canonicalJson(creationAction(creation)) === canonicalJson(step.action)
        );
      });
    },

    /**
     * Verification for the execution adapter: a fresh read must find exactly this return. Every
     * read it cites is stored first, so its observation IDs resolve to orders evidence. Only a
     * complete read can pass or fail it; a storage failure throws, which execution treats as
     * unknown.
     */
    async verify(context: TenantContext, creationId: string) {
      const creation = await deps.store.transaction(
        context.tenantId,
        false,
        (tx) => tx.creation(creationId),
      );
      if (!creation)
        return { outcome: 'inconclusive' as const, observationRefs: [] };
      const { found, complete, reads } = await locate(context, creation);
      if (
        !complete ||
        !reads ||
        found.length === 0 ||
        found.some(
          (f) =>
            !Number.isFinite(Date.parse(f.observedAt)) ||
            Date.parse(f.observedAt) < Date.parse(creation.requestedAt) ||
            Date.parse(f.observedAt) > deps.now().getTime(),
        )
      )
        return { outcome: 'inconclusive' as const, observationRefs: [] };
      await deps.store.transaction(context.tenantId, true, (tx) =>
        recordReads(context, tx, creation, reads),
      );
      if (found.length > 1)
        return {
          outcome: 'failed' as const,
          observationRefs: found.map((f) => f.observationId),
        };

      return {
        outcome: matchesCreation(creation, found[0]!)
          ? ('passed' as const)
          : ('failed' as const),
        observationRefs: [found[0]!.observationId],
      };
    },

    /**
     * Stores the provider's acceptance of a return creation as orders' write receipt and
     * returns its ID, which execution cites. It records what already happened, so it does not
     * recheck authority. Throws when the creation is unknown or the acceptance belongs to
     * another connection; execution then cites nothing and the outcome stays unknown.
     */
    async storeWriteReceipt(
      context: TenantContext,
      creationId: string,
      acceptance: WriteAcceptance,
    ) {
      return deps.store.transaction(context.tenantId, true, async (tx) => {
        const creation = await tx.creation(creationId);
        if (
          !creation ||
          creation.connectionId !== acceptance.connectionId ||
          acceptance.capability !== 'returns.create'
        )
          throw conflict('The receipt does not belong to this return request.');
        const receipt = returnWriteReceipt(
          context.tenantId,
          creation.caseId,
          { purpose: 'creation', id: creation.id },
          deps.uuid(returnWriteReceiptName(context.tenantId, acceptance)),
          acceptance,
        );
        await tx.recordWriteReceipt(receipt);

        return receipt.id;
      });
    },

    /** The creation an action belongs to, for execution adapters. */
    async creationForAction(context: TenantContext, creationId: string) {
      const creation = await deps.store.transaction(
        context.tenantId,
        false,
        (tx) => tx.creation(creationId),
      );

      return creation ? { creation, action: creationAction(creation) } : null;
    },
  };
}
