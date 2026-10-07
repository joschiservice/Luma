import { createAuditLog } from '@luma/audit/composition';
import type { DetectionService, Incident } from '@luma/exceptions';
import type { IdentityService } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import type { PolicyService } from '@luma/policies';
import {
  connectionCheckSource,
  createConnectionCheckWorkflow,
} from '@luma/resolution';
import { createDetectionSources } from '@luma/resolution/composition';
import type {
  CaseReader,
  CaseRunTransport,
  CaseSignal,
  CaseWorkflowAdapter,
  CaseWorkflows,
} from '@luma/workflows';
import {
  compileProcessWorkflow,
  createCaseWorkflowRuntime,
} from '@luma/workflows/composition';

const signal = (incident: Incident): CaseSignal => ({
  id: incident.id,
  issueType: incident.exceptionClass,
  severity: incident.severity,
  subject: {
    kind: incident.subject.subjectKind,
    id: incident.subject.subjectId,
    scope: incident.subject.scope,
  },
  firstDetectedAt: incident.firstDetectedAt,
  lastDetectedAt: incident.lastDetectedAt,
  open: incident.state !== 'resolved',
});

/** Reads cases for workflows through the exceptions owner, in the caller's tenant. */
export function caseReader(
  exceptions: Pick<DetectionService, 'list' | 'get' | 'evidence'>,
): CaseReader {
  return {
    open: async (context) =>
      (await exceptions.list(context))
        .filter((incident) => incident.state !== 'resolved')
        .map(signal),
    get: async (context, id) => {
      const incident = await exceptions.get(context, id);

      return incident ? signal(incident) : null;
    },
    evidence: async (context, id) =>
      (await exceptions.evidence(context, id)).map((item) => ({
        key: item.key,
        connectionId: item.connectionId,
        source: item.source,
        observedAt: item.observedAt,
        facts: item.facts,
      })),
  };
}

/**
 * Composes case workflows: Luma's own connection check plus the workflows installed apps
 * contribute. Without a transport, workflows can be reviewed but not turned on.
 */
export function createCaseWorkflowServices(options: {
  database: TenantDatabase;
  identity: Pick<IdentityService, 'refreshContext' | 'resolveWorkflowContext'>;
  exceptions: Pick<DetectionService, 'list' | 'get' | 'evidence'>;
  policies: Pick<PolicyService, 'approvalRequirement' | 'currentVersion'>;
  sources?: CaseWorkflowAdapter[];
  transport?: CaseRunTransport;
  enabled: boolean;
}): CaseWorkflows {
  return createCaseWorkflowRuntime(options.database, {
    adapters: [
      createConnectionCheckWorkflow({
        version: compileProcessWorkflow(connectionCheckSource),
        sources: createDetectionSources(options.database),
        now: () => new Date(),
      }),
      ...(options.sources ?? []),
    ],
    cases: caseReader(options.exceptions),
    identity: options.identity,
    policies: options.policies,
    audit: createAuditLog(options.database),
    ...(options.transport ? { transport: options.transport } : {}),
    enabled: options.enabled,
  });
}
