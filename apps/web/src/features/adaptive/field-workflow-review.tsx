import type { AdaptiveRecordType } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { adaptiveApi, adaptiveKey } from './data';
import { adaptiveLabel, cellValue } from './presentation';

/** Reviews a workflow-owned field change with current revision and independent approval controls. */
export function FieldWorkflowReview({
  organizationId,
  runId,
  stepId,
  onChange,
}: {
  organizationId: string;
  runId: string;
  stepId: string;
  onChange?: (() => Promise<void>) | undefined;
}) {
  const client = useQueryClient();
  const [reviewedHash, setReviewedHash] = useState<string | null>(null);
  const key = [...adaptiveKey(organizationId), 'field-workflow', runId, stepId];
  const review = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      adaptiveApi.adaptiveFields.workflowReview(
        { params: { organizationId, runId, stepId } },
        { signal },
      ),
  });
  const decide = useMutation({
    mutationFn: (outcome: 'approved' | 'rejected') => {
      if (!review.data?.decisionId) throw new Error('Decision unavailable');

      return adaptiveApi.adaptiveFields.workflowDecide({
        params: { organizationId, runId, stepId },
        body: {
          decisionId: review.data.decisionId,
          reviewedActionHash: review.data.actionHash,
          outcome,
        },
      });
    },
    onSuccess: async () => {
      setReviewedHash(null);
      await client.invalidateQueries({ queryKey: adaptiveKey(organizationId) });
      await onChange?.();
    },
  });
  if (review.isPending)
    return <Alert role="status">{m.adaptive_loading()}</Alert>;
  if (review.isError || !review.data)
    return (
      <Alert tone="warning">
        {m.adaptive_load_failed()}
        <Button variant="outline" onClick={() => void review.refetch()}>
          {m.adaptive_retry()}
        </Button>
      </Alert>
    );
  const item = review.data;
  const states = {
    approval_required: m.adaptive_action_approval_required,
    approved: m.adaptive_approved,
    rejected: m.adaptive_rejected,
    succeeded: m.adaptive_action_verified,
    unavailable: m.adaptive_action_unavailable,
  };

  return (
    <section
      className="adaptive-fields-section"
      aria-label={m.adaptive_field_change()}
    >
      <h3>{adaptiveLabel(item.field.label)}</h3>
      <Badge
        tone={
          item.status === 'approval_required'
            ? 'warning'
            : item.status === 'succeeded'
              ? 'success'
              : 'neutral'
        }
      >
        {states[item.status]()}
      </Badge>
      <p>{m.adaptive_field_workflow_note()}</p>
      <dl>
        <dt>{m.adaptive_before()}</dt>
        <dd>{cellValue(item.beforeValue)}</dd>
        <dt>{m.adaptive_after()}</dt>
        <dd>{cellValue(item.proposedValue)}</dd>
        <dt>{m.adaptive_revision({ revision: item.revision })}</dt>
        <dd>{item.currentRevision}</dd>
        <dt>{m.adaptive_requested()}</dt>
        <dd>
          <WorkspaceDate value={item.requestedAt} />
        </dd>
        <dt>{m.adaptive_expires()}</dt>
        <dd>
          <WorkspaceDate value={item.expiresAt} />
        </dd>
      </dl>
      {item.requireIndependentApproval ? (
        <Alert>{m.adaptive_independent_approval()}</Alert>
      ) : null}
      {item.stale ? (
        <Alert tone="warning">{m.adaptive_stale_review()}</Alert>
      ) : null}
      {!item.canRespond && item.status === 'approval_required' ? (
        <Alert>{m.adaptive_cannot_approve()}</Alert>
      ) : null}
      {item.status === 'approval_required' && item.canRespond ? (
        <>
          <label className="adaptive-check">
            <input
              type="checkbox"
              checked={reviewedHash === item.actionHash}
              onChange={(event) =>
                setReviewedHash(event.target.checked ? item.actionHash : null)
              }
            />
            {m.adaptive_review_field_change()}
          </label>
          <div className="adaptive-actions">
            <Button
              disabled={
                reviewedHash !== item.actionHash ||
                item.stale ||
                decide.isPending
              }
              onClick={() => decide.mutate('approved')}
            >
              {m.adaptive_approve()}
            </Button>
            <Button
              variant="outline"
              disabled={
                reviewedHash !== item.actionHash ||
                item.stale ||
                decide.isPending
              }
              onClick={() => decide.mutate('rejected')}
            >
              {m.adaptive_reject()}
            </Button>
          </div>
        </>
      ) : null}
      {decide.isError ? (
        <Alert tone="warning" role="alert">
          {m.adaptive_operation_failed()}
        </Alert>
      ) : null}
    </section>
  );
}

/** Keeps workflow approval requests visible beside the current record's independently edited values. */
export function RecordFieldWorkflowReviews({
  organizationId,
  recordType,
  recordId,
}: {
  organizationId: string;
  recordType: AdaptiveRecordType;
  recordId: string;
}) {
  const query = useQuery({
    queryKey: [
      ...adaptiveKey(organizationId),
      'field-workflow-pending',
      recordType,
      recordId,
    ],
    queryFn: ({ signal }) =>
      adaptiveApi.adaptiveFields.workflowPending(
        { params: { organizationId }, query: { recordType, recordId } },
        { signal },
      ),
  });
  if (query.isError)
    return <Alert tone="warning">{m.adaptive_load_failed()}</Alert>;
  if (!query.data?.length) return null;

  return (
    <section className="adaptive-fields-section">
      <h3>{m.adaptive_field_change()}</h3>
      {query.data.map((review) => (
        <FieldWorkflowReview
          key={`${review.runId}:${review.stepId}`}
          organizationId={organizationId}
          runId={review.runId}
          stepId={review.stepId}
        />
      ))}
    </section>
  );
}
