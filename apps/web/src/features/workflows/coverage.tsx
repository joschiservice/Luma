import './readiness.css';

import type { WorkflowCoverage } from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { quantityUnit } from '@luma/ui/lib/units';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ShieldCheck } from 'lucide-react';
import { useId } from 'react';

import { IdentityError } from '../../kit/identity/data';
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
function WorkflowCoverageView({
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
          <h2 id={title}>{m.workflows_coverage_title()}</h2>
          <p>
            {item
              ? readinessHeadline(item.readiness)
              : loading
                ? m.workflows_coverage_checking()
                : m.workflows_coverage_unknown()}
          </p>
        </div>
        {item ? <ReadinessPills readiness={item.readiness} /> : null}
      </div>
      {loading ? (
        <p role="status" className="workflow-coverage-rule">
          {m.workflows_coverage_loading()}
        </p>
      ) : error ? (
        <Alert tone="danger" role="alert">
          {m.workflows_coverage_error({ error })}{' '}
          <Button variant="outline" size="sm" onClick={retry}>
            {m.common_retry()}
          </Button>
        </Alert>
      ) : !item ? (
        <p className="workflow-coverage-rule">
          {m.workflows_coverage_none_for_record()}
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
  const unit = (value: number) =>
    stock?.unit ? quantityUnit(stock.unit, value) : m.workflows_unit_fallback();
  const quantity = (value: number) => (
    <strong>
      {m.workflows_coverage_quantity({
        quantity: formatNumber(value),
        unit: unit(value),
      })}
    </strong>
  );
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
          {rich(m.workflows_coverage_rule, {
            supplier: <strong>{rule.supplier}</strong>,
            minimum: quantity(rule.minimum),
            target: quantity(rule.target),
            limit: m.workflows_coverage_quantity({
              quantity: formatNumber(rule.approvalQuantity),
              unit: unit(rule.approvalQuantity),
            }),
          })}
        </p>
      ) : (
        <p className="workflow-coverage-rule">
          {readiness.coverage.explanation}
        </p>
      )}
      <div className="workflow-next" data-state={readiness.state}>
        <span className="workflow-next-label">{m.workflows_next()}</span>
        <div>
          <strong>{nextAction.label}</strong>
          <p>
            {setup && !item.canManage
              ? m.workflows_coverage_cannot_manage()
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
        <ul
          className="workflow-issues"
          aria-label={m.workflows_readiness_issues_label()}
        >
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
          {rich(m.workflows_coverage_latest_run, {
            summary: latestRun.summary,
            date: <WorkspaceDate value={latestRun.at} />,
          })}
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
              label: m.workflows_coverage_purchase_order(),
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
              label: m.workflows_coverage_run_details(),
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
