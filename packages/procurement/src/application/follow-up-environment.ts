import type { SourceEnvironmentProof } from '@luma/connections';
import type { TenantContext } from '@luma/identity';

import type { Submission } from '../domain/commitments.js';

/** Classifies a bound submitted order only from trusted positive connection proof; absence stays unknown. */
export function createFollowUpEnvironmentReader(deps: {
  commitments: {
    order(
      context: TenantContext,
      orderId: string,
    ): Promise<{
      supplier: { link?: { connectionId: string } | null | undefined } | null;
      submission: Pick<
        Submission,
        'state' | 'connectionId' | 'externalOrder'
      > | null;
    }>;
  };
  connectionEnvironment(
    context: TenantContext,
    connectionId: string,
  ): Promise<SourceEnvironmentProof>;
}) {
  return async (
    context: TenantContext,
    orderId: string,
  ): Promise<SourceEnvironmentProof> => {
    const view = await deps.commitments.order(context, orderId);
    const link = view.supplier?.link;
    const submission = view.submission;
    if (
      !link ||
      !submission ||
      submission.state !== 'submitted' ||
      !submission.externalOrder ||
      submission.connectionId !== link.connectionId
    )
      return { environment: 'unknown', provenance: null };

    return deps.connectionEnvironment(context, link.connectionId);
  };
}
