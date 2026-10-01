import type { DecisionOwner } from '@luma/api-contract';
import { caseLabel } from '@luma/ui/components/issues/case-investigation';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import { AppExtension } from '../apps/extension';
import { connectionsOptions } from '../connections/data';
import { useCaseObservation } from '../exceptions/observation';
import { CaseResolution } from '../exceptions/resolution';
import { PurchaseOrderReview } from '../procurement/detail';
import { workflowRunsOptions } from '../workflows/data';
import { ReplenishmentRunReview } from '../workflows/replenishment';

/**
 * Mounts the review that owns this decision. Every surface uses these same controls, so a
 * response here is the owner's single authoritative decision and is checked again on submit.
 */
export function OwnerReview({
  organizationId,
  owner,
  onChange,
}: {
  organizationId: string;
  owner: DecisionOwner;
  /** Refreshes the queue after the owner reports a completed change. */
  onChange: () => Promise<void>;
}) {
  switch (owner.kind) {
    case 'case':
      return (
        <CaseReview
          key={owner.exceptionId}
          organizationId={organizationId}
          exceptionId={owner.exceptionId}
        />
      );
    case 'workflow_run':
      return (
        <RunReview
          organizationId={organizationId}
          definitionId={owner.definitionId}
          runId={owner.runId}
        />
      );
    case 'app_fulfillment':
      return (
        <AppExtension
          appId={owner.appId}
          organizationId={organizationId}
          slot="fulfillment"
          fulfillment={{
            connectionId: owner.connectionId,
            orderId: owner.orderId,
            fulfillmentId: owner.fulfillmentId,
          }}
          done={onChange}
        />
      );
    case 'app_inventory':
      return (
        <AppExtension
          appId={owner.appId}
          organizationId={organizationId}
          slot="inventory"
          inventory={{ positionId: owner.positionId }}
          done={onChange}
        />
      );
    case 'purchase_order':
      return (
        <PurchaseOrderReview
          key={owner.purchaseOrderId}
          organizationId={organizationId}
          purchaseOrderId={owner.purchaseOrderId}
        />
      );
  }
}

function CaseReview({
  organizationId,
  exceptionId,
}: {
  organizationId: string;
  exceptionId: string;
}) {
  const observation = useCaseObservation(organizationId, exceptionId);
  const connections = useQuery(connectionsOptions(organizationId));

  if (observation.denied)
    return (
      <p role="alert">This issue is missing or you no longer have access.</p>
    );

  return (
    <CaseResolution
      organizationId={organizationId}
      exceptionId={exceptionId}
      observation={observation}
      connectionLabels={Object.fromEntries(
        (connections.data ?? []).map((connection) => [
          connection.id,
          `${connection.label} · ${caseLabel(connection.target.kind)}`,
        ]),
      )}
    />
  );
}

function RunReview({
  organizationId,
  definitionId,
  runId,
}: {
  organizationId: string;
  definitionId: string;
  runId: string;
}) {
  const runs = useQuery({
    ...workflowRunsOptions(organizationId, definitionId),
    refetchInterval: 5000,
  });
  const run = runs.data?.find((item) => item.id === runId);

  if (runs.isPending) return <p role="status">Loading the workflow run…</p>;
  if (!run)
    return (
      <p role={runs.isError ? 'alert' : 'status'}>
        {runs.isError
          ? 'The workflow run could not be loaded. '
          : 'This run is no longer among the recent runs. '}
        <Link
          to="/app/$organizationId/workflows/$definitionId"
          params={{ organizationId, definitionId }}
        >
          Open the workflow
        </Link>
      </p>
    );

  return <ReplenishmentRunReview organizationId={organizationId} run={run} />;
}
