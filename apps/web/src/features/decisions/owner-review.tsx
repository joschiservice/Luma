import type { DecisionOwner } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { caseLabel } from '@luma/ui/components/issues/case-investigation';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';

import { connectionsOptions } from '../../kit/connections/data';
import { FieldWorkflowReview } from '../adaptive/field-workflow-review';
import { AppExtension } from '../apps/extension';
import { useCaseObservation } from '../exceptions/observation';
import { CaseResolution } from '../exceptions/resolution';
import { ThreadReview } from '../inbox/thread';
import { PurchaseOrderReview } from '../procurement/detail';
import { PurchasingPlanReview } from '../procurement/purchasing-workbench';
import {
  replenishmentReviewOptions,
  workflowRunsOptions,
} from '../workflows/data';
import { HumanTaskReview } from '../workflows/human-task';
import { ReplenishmentRunReview } from '../workflows/replenishment';
import { FollowUpReview } from './follow-up-review';

/**
 * Mounts the review that owns this decision. Every surface uses these same controls, so a
 * response here is the owner's single authoritative decision and is checked again on submit.
 */
export function OwnerReview({
  organizationId,
  owner,
  handover = false,
  refreshedAt = 0,
  onChange,
}: {
  organizationId: string;
  owner: DecisionOwner;
  /** A workflow handed a follow-up to a person; there is nothing to approve. */
  handover?: boolean;
  /**
   * When the queue last read this decision. Reviews that do not poll read their owner again when
   * it changes, so a change the stream reports for the queue also reaches the open review.
   */
  refreshedAt?: number;
  /** Refreshes the queue after the owner reports a completed change. */
  onChange: () => Promise<void>;
}) {
  switch (owner.kind) {
    case 'custom_field':
      return (
        <FieldWorkflowReview
          organizationId={organizationId}
          runId={owner.runId}
          stepId={owner.stepId}
          onChange={onChange}
        />
      );
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
      if (owner.followUpProposalId)
        return (
          <FollowUpReview
            organizationId={organizationId}
            proposalId={owner.followUpProposalId}
            definitionId={owner.definitionId}
            onChange={onChange}
          />
        );

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
          onChange={onChange}
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
    case 'app_order':
      return (
        <AppExtension
          appId={owner.appId}
          organizationId={organizationId}
          slot="record"
          record={{
            kind: 'order',
            connectionId: owner.connectionId,
            externalId: owner.orderId,
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
          refreshedAt={refreshedAt}
        />
      );
    case 'purchasing_plan':
      return (
        <PurchasingPlanReview
          organizationId={organizationId}
          planId={owner.planId}
          done={() => void onChange()}
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

/**
 * Reads the run from the workflow's recent runs once, then follows the run's own review, which
 * polls while it is open. The run list is read again only when that review reports a change, so an
 * open decision does not repeatedly read 50 runs with their step evidence.
 */
function RunReview({
  organizationId,
  definitionId,
  runId,
  onChange,
}: {
  organizationId: string;
  definitionId: string;
  runId: string;
  onChange: () => Promise<void>;
}) {
  const runs = useQuery(workflowRunsOptions(organizationId, definitionId));
  const run = runs.data?.items.find((item) => item.id === runId);
  const progress = useQuery({
    ...replenishmentReviewOptions(organizationId, runId),
    select: (review) =>
      JSON.stringify([
        review.state,
        review.decision?.outcome,
        review.purchaseOrder?.status,
        review.verification.state,
      ]),
  }).data;
  const seen = useRef(progress);
  const { refetch } = runs;
  useEffect(() => {
    const previous = seen.current;
    seen.current = progress;
    if (
      previous !== undefined &&
      progress !== undefined &&
      previous !== progress
    )
      void refetch();
  }, [progress, refetch]);

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

  return (
    <ReplenishmentRunReview
      organizationId={organizationId}
      run={run}
      onChange={onChange}
    />
  );
}
