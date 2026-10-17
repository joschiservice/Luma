import { createAuditLog } from '@luma/audit/composition';
import { createPlaybookGrantReader } from '@luma/connections/composition';
import type { IdentityService } from '@luma/identity';
import type { ModelGateway, TenantDatabase } from '@luma/platform';
import { createReplenishmentScenarios } from '@luma/procurement';
import {
  createShippingMethodTemplate,
  shippingMethodPlaybook,
  shippingMethodVocabulary,
} from '@luma/resolution';
import {
  createResolutionImprovementDiscovery,
  createResolutionLearning,
} from '@luma/resolution/composition';
import type { WorkflowImprovementControls } from '@luma/workflows';
import {
  compilePlaybook,
  type createCodeProcesses,
  createDraftGenerations,
  createDrafts,
  createDraftTestRuns,
  createWorkflowTemplates,
} from '@luma/workflows/composition';

import type { createCaseWorkflowServices } from './case-workflows.js';
import type { createTenantFeatureRelease } from './feature-release.js';
import type { createPersistentPlaybookLibrary } from './playbook-library.js';
import type { createReplenishmentRuntime } from './replenishment.js';
import type { createResolutionPlaybooks } from './services.js';
import { createWorkflowImprovementSource } from './workflow-improvements.js';

/** Workflow templates, drafts, draft test runs and generation. */
export interface WorkflowAuthoring {
  drafts: ReturnType<typeof createDrafts>;
  draftTests: ReturnType<typeof createDraftTestRuns>;
  generation: ReturnType<typeof createDraftGenerations>;
  templates: ReturnType<typeof createWorkflowTemplates>;
}

/**
 * Builds workflow authoring: the built-in templates, drafts and their vocabulary, draft test
 * runs and model-assisted generation. Generation is unavailable, with the given reason, when
 * the server has no qualifying model route.
 */
export function createWorkflowAuthoring(options: {
  database: TenantDatabase;
  identity: IdentityService;
  caseWorkflows: ReturnType<typeof createCaseWorkflowServices>;
  codeProcesses: ReturnType<typeof createCodeProcesses>;
  library: ReturnType<typeof createPersistentPlaybookLibrary>;
  playbooks: ReturnType<typeof createResolutionPlaybooks>;
  replenishment: ReturnType<typeof createReplenishmentRuntime>;
  release: ReturnType<typeof createTenantFeatureRelease>;
  modelGateway?: ModelGateway | undefined;
  availability?: { available: boolean; reason: string | null } | undefined;
  improvementControls?: WorkflowImprovementControls | undefined;
}): WorkflowAuthoring {
  const { database, identity, caseWorkflows, replenishment } = options;
  const templateSources = [
    replenishment.template,
    createShippingMethodTemplate({
      digest: compilePlaybook(shippingMethodPlaybook).digest,
      grants: createPlaybookGrantReader(database),
      library: options.library,
      publish: async (context) => {
        await options.playbooks.publish(context, shippingMethodPlaybook);
      },
    }),
    ...caseWorkflows.templates,
  ];
  const templates = createWorkflowTemplates({
    sources: templateSources,
    refreshContext: identity.refreshContext,
  });
  const drafts = createDrafts(database, {
    refreshContext: identity.refreshContext,
    audit: createAuditLog,
    sources: [
      options.codeProcesses,
      { vocabulary: replenishment.vocabulary },
      shippingMethodVocabulary,
      {
        vocabulary: async () => ({
          triggers: (['event', 'exception'] as const).map((kind) => ({
            kind,
            executable: false,
            options: templateSources.flatMap((source) => {
              const content = source.content();
              const trigger = content.applicability.trigger;
              if (
                trigger.kind !== kind ||
                (trigger.kind !== 'event' && trigger.kind !== 'exception')
              )
                return [];
              const value =
                trigger.kind === 'event'
                  ? trigger.eventType
                  : trigger.issueType;

              return [
                {
                  value,
                  label: value
                    .replaceAll(/[._-]/g, ' ')
                    .replace(/^./, (letter) => letter.toUpperCase()),
                },
              ];
            }),
          })),
        }),
      },
    ],
    builtIn: [
      replenishment.version.definition.id,
      shippingMethodPlaybook.definition.id,
      ...caseWorkflows.templates.map((item) => item.id),
    ],
    templates: templateSources,
  });
  const draftTests = createDraftTestRuns(database, {
    refreshContext: identity.refreshContext,
    vocabulary: drafts.vocabulary,
    scenarioSources: [createReplenishmentScenarios(replenishment.version)],
  });
  const generation = createDraftGenerations(database, {
    drafts,
    improvements: createWorkflowImprovementSource(
      createResolutionLearning(database, identity.refreshContext),
      options.release,
      createResolutionImprovementDiscovery(
        database,
        identity.refreshContext,
        (tenantId) =>
          options.release(tenantId, 'workflow-improvement-discovery'),
      ),
      options.improvementControls,
    ),
    gateway: options.modelGateway ?? null,
    availability: options.availability ?? {
      available: false,
      reason: 'Describing workflows isn’t set up on this server.',
    },
    refreshContext: identity.refreshContext,
  });

  return { drafts, draftTests, generation, templates };
}
