import {
  hasPermission,
  requireTenant,
  type TenantContext,
} from '@luma/identity';
import { ServiceError } from '@luma/platform';

import type { ReturnCreation } from '../domain/return-creations.js';
import { returnRecoveryStep } from '../domain/return-recovery.js';
import type { ReturnCaseSupport } from './return-case-support.js';
import type { ReturnCaseDependencies } from './return-cases.js';
import type { ReturnCreationExecution } from './return-creation-execution.js';

/** The background follow-up of one requester's live return creations. */
export function createReturnCreationRecovery(
  deps: ReturnCaseDependencies,
  support: ReturnCaseSupport,
  execution: ReturnCreationExecution,
) {
  const { saveCreation, creationEvent } = support;
  const { settle, dispatch } = execution;

  return {
    /**
     * Background step for one requester, run as them: applies an approval the case never
     * stored, sends an approved creation within its approval, expires an unsent one after it,
     * resumes a send the execution ledger never reserved, and settles uncertain ones by reading.
     * It never sends a reserved or expired creation again. Without `returns.manage` it only
     * records expiry.
     */
    async recover(context: TenantContext) {
      requireTenant(context, context.tenantId);
      context = await deps.refreshContext(context);
      const manage = hasPermission(context, 'returns.manage');
      const creations = await deps.store.transaction(
        context.tenantId,
        false,
        (tx) => tx.liveCreations(context.actor.id),
      );
      const save = (creation: ReturnCreation, patch: Partial<ReturnCreation>) =>
        deps.store.transaction(context.tenantId, true, async (tx) => {
          const current = await tx.creation(creation.id);
          // Another pass or request moved it on; the next pass sees its new state.
          if (!current || current.state !== creation.state) return null;

          return saveCreation(tx, current, patch);
        });
      const failures: unknown[] = [];
      for (let creation of creations) {
        try {
          let step = returnRecoveryStep(creation, deps.now());
          if (step === 'expire') {
            await save(creation, { state: 'expired' });
            continue;
          }
          if (!step || !manage || !deps.admission) continue;
          if (step === 'decision') {
            const approval = (
              await deps.admission.decision(context, creation.decisionId!)
            )?.approval;
            if (!approval) continue;
            const decided = await deps.store.transaction(
              context.tenantId,
              true,
              async (tx) => {
                const current = await tx.creation(creation.id);
                if (current?.state !== 'approval_required') return null;
                const saved = await saveCreation(tx, current, {
                  state: approval.outcome,
                  decidedBy: approval.approverId,
                  decidedAt: deps.now().toISOString(),
                });
                await creationEvent(
                  context,
                  tx,
                  saved,
                  approval.outcome === 'approved'
                    ? 'creation_approved'
                    : 'creation_rejected',
                  {},
                  [],
                  approval.approverId,
                );

                return saved;
              },
            );
            if (decided?.state !== 'approved') continue;
            creation = decided;
            step = 'send';
          }
          if (step === 'send') {
            await dispatch(context, creation);
            continue;
          }
          const execution = await deps.admission.reconcile(context, creation);
          if (execution.state !== 'not_started')
            await settle(context, creation.id, execution);
          else if (Date.parse(creation.expiresAt) > deps.now().getTime()) {
            // Never reserved: resume the same execution identity under its approval.
            const resumed =
              creation.state === 'sending'
                ? creation
                : await save(creation, { state: 'sending' });
            if (resumed) await dispatch(context, resumed);
          }
          // The approval ended before anything was reserved, so nothing can be dispatched.
          else await save(creation, { state: 'expired' });
        } catch (error) {
          // A refused step stays for the next pass; other failures must not hold up the rest.
          if (!(error instanceof ServiceError)) failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          'Some return creations could not be followed up',
        );
    },
  };
}
