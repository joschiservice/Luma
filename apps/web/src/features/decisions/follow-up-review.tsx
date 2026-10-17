import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import { ApiError, contextOptions } from '../../kit/identity/data';
import { requestErrorMessage } from '../../kit/identity/errors';
import { usePermissions } from '../../kit/identity/permissions';
import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

const api = createWebApiClient();

function failureText(error: unknown) {
  if (
    error instanceof ApiError &&
    [401, 403, 404, 429, 500, 502, 503].includes(error.status)
  )
    return requestErrorMessage(error);

  return m.decisions_follow_up_mutation_failed();
}

/** Responds to the exact current internal-note proposal; explicit renewal never carries approval. */
export function FollowUpReview({
  organizationId,
  proposalId,
  definitionId,
  onChange,
}: {
  organizationId: string;
  proposalId: string;
  definitionId: string;
  onChange(): Promise<void>;
}) {
  const context = useQuery(contextOptions(organizationId));
  const { can } = usePermissions(organizationId);
  const review = useQuery({
    ...privateQueryDefaults,
    queryKey: [
      'private',
      'organization',
      organizationId,
      'governed-follow-ups',
    ],
    refetchInterval: 15_000,
    queryFn: ({ signal }) =>
      api.scopedFollowUps.list({ params: { organizationId } }, { signal }),
  });
  const plan = review.data?.items.find((item) => item.id === proposalId);
  const mutate = useMutation({
    mutationFn: async (
      outcome: 'approved' | 'rejected' | 'refresh' | 'reconcile',
    ) => {
      if (!plan) throw new Error(m.decisions_follow_up_gone());
      if (outcome === 'reconcile')
        return api.scopedFollowUps.reconcile({
          params: { organizationId, proposalId },
        });
      if (outcome === 'refresh')
        return api.scopedFollowUps.refresh({
          params: { organizationId, proposalId },
          body: { commandId: crypto.randomUUID() },
        });
      if (!plan.review.decisionId)
        throw new Error(m.decisions_follow_up_gone());

      return api.scopedFollowUps.respond({
        params: { organizationId, proposalId },
        body: { decisionId: plan.review.decisionId, outcome },
      });
    },
    onSuccess: async () => {
      await review.refetch();
      await onChange();
    },
    onError: async () => {
      await review.refetch();
      await onChange();
    },
  });
  if (review.isPending) return <p role="status">{m.decisions_run_loading()}</p>;
  if (review.isError)
    return (
      <Alert tone="warning">
        {m.decisions_follow_up_failed()}{' '}
        <Button variant="outline" onClick={() => void review.refetch()}>
          {m.common_retry()}
        </Button>
      </Alert>
    );
  if (!plan) return <p role="status">{m.decisions_follow_up_gone()}</p>;
  const requester = plan.requestedBy === context.data?.actor.id;
  const respond =
    can('decisions.respond') &&
    can('procurement.manage') &&
    !requester &&
    !plan.review.stale &&
    plan.review.outcome === 'approval_required';

  return (
    <section className="decision-owner-review">
      <p>{m.decisions_follow_up_note()}</p>
      <p>
        {m.decisions_follow_up_next_check()}{' '}
        <WorkspaceDate value={plan.nextCheckAt} />
      </p>
      {plan.previousProposalId ? (
        <Alert>{m.decisions_follow_up_replaced()}</Alert>
      ) : null}
      {plan.review.refreshBlock ? (
        <Alert tone="warning">
          {plan.review.refreshBlock === 'workflow_inactive'
            ? m.decisions_follow_up_workflow_inactive()
            : m.decisions_follow_up_release_unavailable()}{' '}
          {plan.review.refreshBlock === 'workflow_inactive' ? (
            <Link
              to="/app/$organizationId/workflows/$definitionId"
              params={{ organizationId, definitionId }}
            >
              {m.decisions_follow_up_open_workflow()}
            </Link>
          ) : null}
        </Alert>
      ) : null}
      {plan.review.stale && !plan.review.refreshBlock ? (
        <Alert tone="warning">{m.decisions_follow_up_stale()}</Alert>
      ) : null}
      {mutate.isError ? (
        <Alert tone="warning">{failureText(mutate.error)}</Alert>
      ) : null}
      {mutate.isSuccess ? (
        <p role="status">
          {mutate.variables === 'reconcile'
            ? m.decisions_follow_up_checked()
            : m.decisions_follow_up_saved()}
        </p>
      ) : null}
      <div className="decision-links">
        {can('procurement.manage') ? (
          <Button
            variant="outline"
            disabled={mutate.isPending}
            onClick={() => mutate.mutate('reconcile')}
          >
            {m.decisions_follow_up_reconcile()}
          </Button>
        ) : null}
        {respond ? (
          <>
            <Button
              disabled={mutate.isPending}
              onClick={() => mutate.mutate('approved')}
            >
              {m.issues_decision_approve()}
            </Button>
            <Button
              variant="outline"
              disabled={mutate.isPending}
              onClick={() => mutate.mutate('rejected')}
            >
              {m.issues_decision_reject()}
            </Button>
          </>
        ) : null}
        {plan.review.stale &&
        plan.review.refreshable &&
        requester &&
        can('procurement.manage') ? (
          <Button
            disabled={mutate.isPending}
            onClick={() => mutate.mutate('refresh')}
          >
            {m.decisions_follow_up_refresh()}
          </Button>
        ) : null}
        {!respond &&
        !plan.review.stale &&
        plan.review.outcome === 'approval_required' ? (
          <p>{m.decisions_note_awaiting_other()}</p>
        ) : null}
      </div>
    </section>
  );
}
