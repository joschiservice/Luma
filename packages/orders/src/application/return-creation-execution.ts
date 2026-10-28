import type { TenantContext } from '@luma/identity';
import { notFound } from '@luma/platform';

import {
  matchesCreation,
  type ReturnCreation,
} from '../domain/return-creations.js';
import {
  citedReads,
  completeReads,
  type ReturnRead,
  returnReadEvidence,
} from '../domain/return-reads.js';
import type { ReturnCaseSupport } from './return-case-support.js';
import type {
  CreationExecution,
  ReturnCaseDependencies,
  ReturnCaseTransaction,
} from './return-cases.js';

/**
 * Locates, dispatches and settles return creations through Action Admission; a creation is
 * only recorded as created after a fresh read finds it.
 */
export function createReturnCreationExecution(
  deps: ReturnCaseDependencies,
  support: ReturnCaseSupport,
) {
  const { saveCreation, creationEvent } = support;

  /**
   * A fresh read of the system; exactly one return carrying the case marker identifies it.
   * `reads` holds the read behind every found return, or is null when one is missing, so none
   * of them can be cited.
   */
  async function locate(context: TenantContext, creation: ReturnCreation) {
    const none = { found: [], complete: false, reads: null };
    if (!deps.system) return none;
    const result = await deps.system.created(context, creation.connectionId, {
      order: creation.order,
      lumaCaseId: creation.caseId,
      ...(creation.requestedReturn
        ? { requestedReturn: creation.requestedReturn }
        : {}),
    });
    if (!result.ok) return none;
    const { items, reads } = result.value;

    return {
      found: items,
      reads: citedReads(
        items.map((f) => f.observationId),
        reads,
      ),
      complete: result.value.complete && completeReads(reads),
    };
  }

  /** Stores the reads a creation cites in the citing transaction. */
  async function recordReads(
    context: TenantContext,
    tx: ReturnCaseTransaction,
    creation: ReturnCreation,
    reads: ReturnRead[],
  ) {
    for (const read of reads)
      await tx.recordRead(
        returnReadEvidence(
          context.tenantId,
          creation.caseId,
          { purpose: 'creation', id: creation.id },
          read,
        ),
      );
  }

  /** Applies an execution result; a verified creation is located again and recorded. */
  async function settle(
    context: TenantContext,
    creationId: string,
    execution: CreationExecution,
  ) {
    const read = () =>
      deps.store.transaction(context.tenantId, false, (tx) =>
        tx.creation(creationId),
      );
    const creation = await read();
    if (!creation || execution.state === 'not_started') return;
    const save = (patch: Partial<ReturnCreation>) =>
      deps.store.transaction(context.tenantId, true, async (tx) => {
        const current = await tx.creation(creationId);
        if (current && current.state !== 'created')
          await saveCreation(tx, current, patch);
      });
    if (execution.state === 'not_executed')
      return save({ state: 'not_executed', failure: null });
    if (execution.state === 'withheld' || execution.state === 'failed')
      return save({ state: 'failed', failure: execution.failure });
    if (execution.state !== 'verified') return save({ state: 'uncertain' });
    const { found, complete, reads } = await locate(context, creation);
    const match = found.length === 1 ? found[0]! : null;
    if (
      !complete ||
      !reads ||
      !match ||
      !Number.isFinite(Date.parse(match.observedAt)) ||
      Date.parse(match.observedAt) < Date.parse(creation.requestedAt) ||
      Date.parse(match.observedAt) > deps.now().getTime() ||
      !matchesCreation(creation, match)
    )
      return save({ state: 'uncertain' });
    await deps.store.transaction(context.tenantId, true, async (tx) => {
      const current = (await tx.creation(creationId))!;
      if (current.state === 'created') return;
      await recordReads(context, tx, current, reads);
      const saved = await saveCreation(tx, current, {
        state: 'created',
        createdAt: match.observedAt,
        externalReturn: { externalId: match.externalId, number: match.number },
        failure: null,
      });
      await creationEvent(
        context,
        tx,
        saved,
        'creation_created',
        { externalNumber: match.number },
        [match.observationId],
      );
    });
  }

  async function dispatch(context: TenantContext, creation: ReturnCreation) {
    if (!deps.admission) return;
    await deps.store.transaction(context.tenantId, true, async (tx) => {
      const current = await tx.creation(creation.id);
      if (current?.state === 'approved')
        await saveCreation(tx, current, { state: 'sending' });
    });
    let execution: CreationExecution;
    try {
      execution = await deps.admission.execute(context, creation);
    } catch {
      execution = await deps.admission
        .get(context, creation)
        .catch(() => ({ state: 'uncertain' }) as const);
      if (execution.state === 'not_started')
        execution = { state: 'failed', failure: 'not_sent' };
    }
    await settle(context, creation.id, execution);
  }

  async function loadCreation(
    context: TenantContext,
    caseId: string,
    creationId: string,
  ) {
    const creation = await deps.store.transaction(
      context.tenantId,
      false,
      (tx) => tx.creation(creationId),
    );
    if (!creation || creation.caseId !== caseId)
      throw notFound('Return creation not found');

    return creation;
  }

  return { locate, recordReads, settle, dispatch, loadCreation };
}

export type ReturnCreationExecution = ReturnType<
  typeof createReturnCreationExecution
>;
