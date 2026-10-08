import { m } from '@luma/i18n/messages';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowUpRight, Workflow } from 'lucide-react';

import { IdentityError } from '../identity/data';
import { workflowError, workflowOptions } from '../workflows/data';
import {
  coverageLabel,
  readinessHeadline,
  ReadinessPills,
  RepairLink,
} from '../workflows/readiness';

const definitionId = 'inventory-replenishment';

/**
 * Summarizes replenishment readiness on the Procurement page with its next action, so stock rules
 * can be set up and repaired from where purchase orders are managed.
 */
export function ReplenishmentOverview({
  organizationId,
}: {
  organizationId: string;
}) {
  const query = useQuery(workflowOptions(organizationId, definitionId));
  if (
    query.error instanceof IdentityError &&
    [401, 403, 404].includes(query.error.status)
  )
    return null;
  const readiness = query.data?.summary.readiness;
  const next = readiness?.nextAction;

  return (
    <section
      className="procurement-overview procurement-replenishment"
      aria-labelledby="procurement-replenishment-title"
      aria-busy={query.isPending || undefined}
    >
      <div className="procurement-overview-heading">
        <Workflow size={17} aria-hidden="true" />
        <div>
          <h2 id="procurement-replenishment-title">
            {m.procurement_replenishment_title()}
            {readiness ? (
              <span className="procurement-replenishment-state">
                {' · '}
                {readinessHeadline(readiness)}
              </span>
            ) : null}
          </h2>
          <p>
            {query.isPending
              ? m.procurement_replenishment_checking()
              : query.error
                ? m.procurement_replenishment_failed({
                    detail: workflowError(query.error),
                  })
                : readiness && next
                  ? next.repair
                    ? m.procurement_replenishment_next_repair({
                        coverage: coverageLabel(readiness.coverage),
                        action: next.label,
                      })
                    : m.procurement_replenishment_next_detail({
                        coverage: coverageLabel(readiness.coverage),
                        detail: next.description,
                      })
                  : ''}
          </p>
        </div>
      </div>
      {readiness ? (
        <div className="procurement-replenishment-actions">
          <ReadinessPills readiness={readiness} />
          {next?.repair ? (
            <RepairLink
              organizationId={organizationId}
              definitionId={definitionId}
              repair={next.repair}
              label={next.label}
            />
          ) : null}
          <Link
            className="workflow-repair-link"
            to="/app/$organizationId/workflows/$definitionId"
            params={{ organizationId, definitionId }}
            search={{}}
            hash="rules"
          >
            {m.procurement_replenishment_manage()}{' '}
            <ArrowUpRight size={13} aria-hidden="true" />
          </Link>
        </div>
      ) : null}
    </section>
  );
}
