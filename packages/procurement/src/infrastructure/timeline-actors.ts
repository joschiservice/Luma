import type { TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import type { PurchasingTimelineEntry } from '../domain/purchasing-timeline.js';
import {
  attributeTimelineActors,
  timelineActorIds,
  type TimelineAutomation,
  timelineAutomationSources,
  type TimelinePerson,
} from '../domain/timeline-actors.js';

/**
 * Deliberate cross-owner read of who acted on a purchase order: the admitting workflow run of
 * executions and submissions (execution, workflow and playbook records), and recorded people
 * (workspace people, including former members). Reads in one tenant transaction.
 */
export function createPurchasingTimelineActors(database: TenantDatabase) {
  return (
    context: TenantContext,
    entries: PurchasingTimelineEntry[],
    workflowRunId?: string,
  ): Promise<PurchasingTimelineEntry[]> =>
    database.transaction(context.tenantId, async (tx) => {
      const { executionIds, submissionIds } =
        timelineAutomationSources(entries);
      const automated = new Map(
        (
          await tx.query<{
            key: string;
            id: string;
            name: string | null;
            principalId: string;
          }>(
            `WITH sources AS (
               SELECT 'execution:'||x.id AS key,a.run_id FROM executed_actions x
               JOIN action_admission_steps a ON a.tenant_id=x.tenant_id AND a.proposal_id=x.proposal_id
               WHERE x.tenant_id=$1 AND x.id::text=ANY($2::text[])
               UNION ALL
               SELECT 'submission:'||s.id AS key,a.run_id FROM procurement_submissions s
               JOIN action_admission_steps a ON a.tenant_id=s.tenant_id AND a.proposal_id::text=s.document->>'actionId'
               WHERE s.tenant_id=$1 AND s.id::text=ANY($3::text[])
              ) SELECT s.key,r.id,r.document->'actor'->>'id' AS "principalId",v.document->'definition'->>'name' AS name
              FROM sources s JOIN workflow_trigger_runs r ON r.tenant_id=$1 AND r.id=s.run_id
              LEFT JOIN playbook_versions v ON v.tenant_id=r.tenant_id AND v.definition_id=r.definition_id AND v.version=r.version`,
            [context.tenantId, executionIds, submissionIds],
          )
        ).rows.map(({ key, ...run }): [string, TimelineAutomation] => [
          key,
          run,
        ]),
      );
      const people = new Map(
        (
          await tx.query<{
            id: string;
            name: string | null;
            email: string | null;
            member: boolean;
          }>(
            'SELECT user_id::text AS id,name,email,is_member AS member FROM workspace_people WHERE tenant_id=$1 AND user_id::text=ANY($2::text[])',
            [context.tenantId, timelineActorIds(entries, automated)],
          )
        ).rows.map((person): [string, TimelinePerson] => [person.id, person]),
      );
      const workflow = workflowRunId
        ? (
            await tx.query<{ id: string; name: string | null }>(
              `SELECT r.id,v.document->'definition'->>'name' AS name FROM workflow_trigger_runs r LEFT JOIN playbook_versions v ON v.tenant_id=r.tenant_id AND v.definition_id=r.definition_id AND v.version=r.version WHERE r.tenant_id=$1 AND r.id::text=$2`,
              [context.tenantId, workflowRunId],
            )
          ).rows[0]
        : undefined;

      return attributeTimelineActors(entries, { automated, people, workflow });
    });
}
