import type { DecisionOwner } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { caseLabel } from '@luma/ui/components/issues/case-investigation';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import { connectionsOptions } from '../../kit/connections/data';
import { AppExtension } from '../apps/extension';
import { useCaseObservation } from '../exceptions/observation';
import { CaseResolution } from '../exceptions/resolution';
import { ThreadReview } from '../inbox/thread';
import { PurchaseOrderReview } from '../procurement/detail';
import { workflowRunsOptions } from '../workflows/data';
import { HumanTaskReview } from '../workflows/human-task';
import { ReplenishmentRunReview } from '../workflows/replenishment';

/**
 * Mounts the review that owns this decision. Every surface uses these same controls, so a
 * response here is the owner's single authoritative decision and is checked again on submit.
 */
export function OwnerReview({
  organizationId,
  owner,
  handover = false,
  onChange,
}: {
  organizationId: string;
  owner: DecisionOwner;
  /** A workflow handed a follow-up to a person; there is nothing to approve. */
  handover?: boolean;
  /** Refreshes the queue after the owner reports a completed change. */
  onChange: () => Promise<void>;
}) {
  switch (owner.kind) {
    case 'return_case':
      return (
        <Link
          to="/app/$organizationId/returns/cases/$caseId"
          params={{ organizationId, caseId: owner.caseId }}
        >
          {m.returns_service_open_case()}
        </Link>
      );
    case 'human_task':
      return (
        <HumanTaskReview
          key={`${owner.runId}:${owner.stepId}`}
          organizationId={organizationId}
          owner={owner}
          onChange={onChange}
        />
      );
    case 'case':
      return (
        <CaseReview
          key={owner.exceptionId}
          organizationId={organizationId}
          exceptionId={owner.exceptionId}
        />
      );
    case 'workflow_run':
      return handover ? (
        <p className="decision-note">
          {rich(m.decisions_handover_text, {
            link: (
              <Link
                to="/app/$organizationId/workflows/$definitionId"
                params={{ organizationId, definitionId: owner.definitionId }}
                hash={`run-${owner.runId}`}
              >
                {m.decisions_handover_link()}
              </Link>
            ),
          })}
        </p>
      ) : (
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
    case 'message_thread':
      return (
        <ThreadReview
          key={owner.threadId}
          organizationId={organizationId}
          threadId={owner.threadId}
          onChange={onChange}
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
    return <p role="alert">{m.decisions_case_denied()}</p>;

  return (
    <CaseResolution
      organizationId={organizationId}
      exceptionId={exceptionId}
      observation={observation}
      connectionLabels={Object.fromEntries(
        (connections.data ?? []).map((connection) => [
          connection.id,
          m.decisions_connection_label({
            connection: connection.label,
            system: caseLabel(connection.target.kind),
          }),
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
  const run = runs.data?.items.find((item) => item.id === runId);

  if (runs.isPending) return <p role="status">{m.decisions_run_loading()}</p>;
  if (!run)
    return (
      <p role={runs.isError ? 'alert' : 'status'}>
        {rich(runs.isError ? m.decisions_run_failed : m.decisions_run_gone, {
          link: (
            <Link
              to="/app/$organizationId/workflows/$definitionId"
              params={{ organizationId, definitionId }}
            >
              {m.decisions_open_workflow()}
            </Link>
          ),
        })}
      </p>
    );

  return <ReplenishmentRunReview organizationId={organizationId} run={run} />;
}
