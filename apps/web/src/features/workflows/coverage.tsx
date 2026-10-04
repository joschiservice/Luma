import './readiness.css';

import type { WorkflowCoverage } from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ShieldCheck } from 'lucide-react';
import { useId } from 'react';

import { IdentityError } from '../identity/data';
import { workflowCoverageOptions, workflowError } from './data';
import { readinessHeadline, ReadinessPills, RepairLink } from './readiness';

/**
 * Shows whether replenishment watches a stock position, with the same readiness, blockers and
 * next action as the workflow. Hidden when the position is outside the workspace.
 */
export function WorkflowCoverageCard({
  organizationId,
  positionId,
  className,
}: {
  organizationId: string;
  positionId: string;
  className?: string;
}) {
  const query = useQuery({
    ...workflowCoverageOptions(organizationId, positionId),
    refetchInterval: 30000,
  });
  const hidden =
    query.error instanceof IdentityError &&
    [401, 403, 404].includes(query.error.status);
  if (hidden) return null;

  return (
    <WorkflowCoverageView
      organizationId={organizationId}
      className={className}
      items={query.data}
      loading={query.isPending}
      error={query.error ? workflowError(query.error) : undefined}
      retry={() => void query.refetch()}
    />
  );
}

/** Presents loading, unavailable and covered states for a record's workflows. */
export function WorkflowCoverageView({
  organizationId,
  items,
  loading = false,
  error,
  retry,
  className = '',
}: {
  organizationId: string;
  items?: WorkflowCoverage['items'] | undefined;
  loading?: boolean;
  error?: string | undefined;
  retry: () => void;
  className?: string | undefined;
}) {
  const title = useId();
  const [item] = items ?? [];

  return (
    <Card
      as="section"
      className={`workflow-coverage ${className}`}
      aria-labelledby={title}
      aria-busy={loading || undefined}
    >
      <div className="workflow-coverage-head">
        <div>
          <h2 id={title}>Replenishment</h2>
          <p>
            {item
              ? readinessHeadline(item.readiness)
              : loading
                ? 'Checking readiness…'
                : 'Readiness unknown'}
          </p>
        </div>
        {item ? <ReadinessPills readiness={item.readiness} /> : null}
      </div>
      {loading ? (
        <p role="status" className="workflow-coverage-rule">
          Checking whether a stock rule covers this position…
        </p>
      ) : error ? (
        <Alert tone="danger" role="alert">
          Replenishment readiness is unavailable. {error}{' '}
          <Button variant="outline" size="sm" onClick={retry}>
            Retry
          </Button>
        </Alert>
      ) : !item ? (
        <p className="workflow-coverage-rule">
          No workflow covers this record.
        </p>
      ) : (
        <CoverageDetail organizationId={organizationId} item={item} />
      )}
    </Card>
  );
}

function CoverageDetail({
  organizationId,
  item,
}: {
  organizationId: string;
  item: WorkflowCoverage['items'][number];
}) {
  const { readiness, rule, stock, latestRun } = item;
  const unit = stock?.unit ?? 'units';
  const { nextAction } = readiness;
  const setup = nextAction.repair?.destination === 'workflow_rules';
  const others = readiness.issues.filter(
    (issue) =>
      (issue.scope ? `${issue.scope}: ${issue.message}` : issue.message) !==
      nextAction.description,
  );

  return (
    <>
      {rule?.active ? (
        <p className="workflow-coverage-rule">
          Reorders from <strong>{rule.supplier}</strong> when available stock
          falls below{' '}
          <strong>
            {rule.minimum} {unit}
          </strong>
          , proposing enough to reach{' '}
          <strong>
            {rule.target} {unit}
          </strong>
          . Drafts above {rule.approvalQuantity} {unit} are high risk.
        </p>
      ) : (
        <p className="workflow-coverage-rule">
          {readiness.coverage.explanation}
        </p>
      )}
      <div className="workflow-next" data-state={readiness.state}>
        <span className="workflow-next-label">Next</span>
        <div>
          <strong>{nextAction.label}</strong>
          <p>
            {setup && !item.canManage
              ? 'An owner or admin can set up a stock rule for this position.'
              : nextAction.description}
          </p>
        </div>
        {nextAction.repair && !(setup && !item.canManage) ? (
          <RepairLink
            organizationId={organizationId}
            definitionId={item.definitionId}
            repair={nextAction.repair}
            className={buttonVariants({
              variant: readiness.state === 'ready' ? 'outline' : 'default',
              size: 'sm',
            })}
          />
        ) : null}
      </div>
      {others.length ? (
        <ul className="workflow-issues" aria-label="Readiness issues">
          {others.map((issue) => (
            <li key={issue.code} data-severity={issue.severity}>
              <span className="workflow-issue-dot" aria-hidden="true" />
              <div>
                <p>{issue.message}</p>
                {issue.repair ? (
                  <RepairLink
                    organizationId={organizationId}
                    definitionId={item.definitionId}
                    repair={issue.repair}
                  />
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="workflow-coverage-rule workflow-coverage-approval">
        <ShieldCheck size={14} aria-hidden="true" />
        <span>{readiness.approval.summary}</span>
      </p>
      {latestRun ? (
        <p className="workflow-coverage-rule">
          Latest run: {latestRun.summary} <WorkspaceDate value={latestRun.at} />
        </p>
      ) : null}
      <div className="workflow-coverage-links">
        {readiness.waiting.repair && (readiness.waiting.count ?? 0) > 0 ? (
          <RepairLink
            organizationId={organizationId}
            definitionId={item.definitionId}
            repair={readiness.waiting.repair}
          />
        ) : null}
        {latestRun?.purchaseOrderId ? (
          <RepairLink
            organizationId={organizationId}
            definitionId={item.definitionId}
            repair={{
              label: 'Purchase order',
              destination: 'purchase_order',
              recordId: latestRun.purchaseOrderId,
            }}
          />
        ) : null}
        {latestRun ? (
          <RepairLink
            organizationId={organizationId}
            definitionId={item.definitionId}
            repair={{
              label: 'Run evidence',
              destination: 'workflow_activity',
              recordId: latestRun.runId,
            }}
          />
        ) : null}
        <Link
          className="workflow-repair-link"
          to="/app/$organizationId/workflows/$definitionId"
          params={{ organizationId, definitionId: item.definitionId }}
          search={{}}
        >
          {item.name}
        </Link>
      </div>
    </>
  );
}
