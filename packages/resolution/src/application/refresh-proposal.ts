import type { CapabilityReader, ExternalId } from '@luma/connections';
import type {
  DetectionRequest,
  DetectionService,
  DiagnosisService,
} from '@luma/exceptions';
import type { TenantContext } from '@luma/identity';
import { conflict, unavailable } from '@luma/platform';
import type { ProposedAction } from '@luma/policies';

import type { DeskService } from './desk.js';
import type { ProposalReference } from './runtime.js';

export interface ProposalRefreshDependencies {
  desk: DeskService;
  capabilities: CapabilityReader;
  exceptions: DetectionService;
  diagnoses: DiagnosisService;
  connectionId: string;
  order: ExternalId;
  expectedShippingMethod: string;
  /** Builds the detector input using the authoritative observation reference. */
  detectionRequest(observationId: string): DetectionRequest;
  /** Prepares a proposal bound to the current diagnosis revision. */
  propose(
    actor: TenantContext,
    incidentId: string,
    revision: number,
  ): Promise<ProposalReference | null>;
  /** Records policy evaluation without granting approval. */
  evaluate(actor: TenantContext, action: ProposedAction): Promise<unknown>;
  /** Returns real elapsed time for evidence and approval freshness. */
  now(): number;
}

/** Rereads shipping conditions and renews an unexecuted proposal without approving it. */
export function createProposalRefresher(deps: ProposalRefreshDependencies) {
  return async (
    actor: TenantContext,
    id: string,
  ): Promise<ProposedAction | null> => {
    const review = await deps.desk.review(actor, id);
    const progress = await deps.desk.progress(actor, id);
    if (
      (review.proposal?.approval && !review.refreshable) ||
      progress.execution ||
      ['resolved', 'escalated'].includes(progress.state)
    )
      return review.proposal
        ? ((await deps.desk.proposal(actor, review.proposal.id))?.action ??
            null)
        : null;
    const result = await deps.capabilities.read(actor, {
      connectionId: deps.connectionId,
      capability: 'orders.shipping-method.read',
      version: '0',
      input: { order: deps.order, limit: 1 },
    });
    if (
      !result.ok ||
      result.value.completeness !== 'complete' ||
      result.value.items.length !== 1
    )
      throw unavailable('The order could not be checked. Try again shortly.');
    const observation = result.value.items[0];
    if (!observation)
      throw unavailable('The order could not be checked. Try again shortly.');
    if (observation.data.orderStatus !== 'open')
      throw conflict(
        observation.data.orderStatus === 'shipped'
          ? 'The order has already shipped. Its shipping method can no longer be corrected.'
          : observation.data.orderStatus === 'cancelled'
            ? 'The order was cancelled. Review the case before choosing another action.'
            : 'The order’s current status could not be confirmed. Review the order before continuing.',
      );
    if (
      observation.data.isCancelled ||
      observation.data.shippingMethod.externalId !== deps.expectedShippingMethod
    )
      throw conflict(
        observation.data.isCancelled
          ? 'The order was cancelled. Review the case before choosing another action.'
          : 'The shipping method changed. Review the order before choosing another action.',
      );
    if (
      review.proposal &&
      Math.min(
        Date.parse(review.proposal.expiresAt),
        Date.parse(review.proposal.preconditions.validUntil),
      ) >
        deps.now() + 60_000
    )
      return (
        (await deps.desk.proposal(actor, review.proposal.id))?.action ?? null
      );
    const request = deps.detectionRequest(observation.id);
    request.evidence = request.evidence.map((evidence) => ({
      ...evidence,
      observedAt: observation.observedAt,
      facts: {
        ...evidence.facts,
        currentOrder: observation.data,
        observationId: observation.id,
        observationSource: observation.source,
      },
    }));
    await deps.exceptions.ingest(actor, request);
    const diagnosis = await deps.diagnoses.run(actor, id);
    if (!diagnosis || diagnosis.status !== 'ready' || diagnosis.superseded)
      throw conflict('The investigation changed. Review the current findings.');
    const proposal = await deps.propose(actor, id, diagnosis.revision);
    if (!proposal) throw conflict('No current proposal is available.');
    // Policy evaluation records the independent approval requirement; this path never approves.
    const action = (await deps.desk.proposal(actor, proposal.id))?.action;
    if (!action) return null;
    await deps.evaluate(actor, action);

    return action;
  };
}
