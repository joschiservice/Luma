import { randomBytes, randomUUID } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import { IdentityError } from '@luma/identity';
import type {
  ModelGateway,
  TenantDatabase,
  TraceContext,
} from '@luma/platform';

import { createWorkflowCatalog } from './application/catalog.js';
import { createCodeEvaluations } from './application/code-evaluations.js';
import {
  createDraftGeneration,
  generateDraft,
  type GenerationAvailability,
} from './application/draft-generation.js';
import {
  createDraftTests,
  type TestScenarioSource,
} from './application/draft-tests.js';
import type { WorkflowDrafts } from './application/drafts.js';
import {
  createWorkflowDrafts,
  type VocabularySource,
  type WorkflowAuditEntry,
} from './application/drafts.js';
import type { PlaybookDependencies } from './application/playbook.js';
import { createPlaybookService } from './application/playbook.js';
import type { PlaybookLibrary } from './application/playbook-library.js';
import type { TemplateSource } from './application/templates.js';
import { createWorkflowTriggers } from './application/triggers.js';
import { codeRuntime } from './domain/code-step.js';
import {
  describedIdentity,
  describeMessages,
} from './domain/draft-generation.js';
import type { AuthoringVocabulary } from './domain/vocabulary.js';
import { checkVocabulary } from './domain/vocabulary.js';
import type { PublishedWorkflowVersion } from './domain/workflow.js';
import {
  compilePublishedWorkflow,
  createWorkflowCatalogStore,
} from './infrastructure/catalog.js';
import { createCodeEvaluationStore } from './infrastructure/code/evaluations.js';
import { createWasmtimeRunner } from './infrastructure/code/runner.js';
import type { createCodeProcesses } from './infrastructure/code-processes.js';
import { createDraftTestStore } from './infrastructure/draft-tests.js';
import {
  createReservedDefinitions,
  createWorkflowDraftStore,
} from './infrastructure/drafts.js';
import {
  codeSourceProblem,
  codeStepOutput,
  draftOutput,
} from './infrastructure/generation-output.js';
import { createGenerationStore } from './infrastructure/generations.js';
import {
  activationRequestSchema,
  compilePlaybook,
  parsePlaybookSnapshot,
  playbookHash,
} from './infrastructure/playbooks/schema.js';
import { createPlaybookStore } from './infrastructure/playbooks/store.js';
import {
  checkDraftContent,
  draftFromVersion,
  parseDraftShape,
  parseProcessSnapshot,
} from './infrastructure/process-schema.js';
import { createWorkflowTriggerStore } from './infrastructure/triggers.js';

/**
 * Creates persistent playbook services with compilation, snapshot validation, and action-
 * admission boundaries.
 */
export function createPlaybooks(
  db: TenantDatabase,
  dependencies: Pick<
    PlaybookDependencies,
    'admission' | 'provisioning' | 'refreshContext' | 'parseAction'
  >,
  now: () => Date = () => new Date(),
) {
  return createPlaybookService({
    ...dependencies,
    store: createPlaybookStore(db),
    compile: compilePlaybook,
    parseSnapshot: parsePlaybookSnapshot,
    parseActivation: (input) => activationRequestSchema.parse(input),
    hash: playbookHash,
    now,
  });
}

export {
  compilePlaybook,
  definePlaybook,
  parsePlaybookCode,
  printPlaybookCode,
} from './infrastructure/playbooks/schema.js';

export { createPlaybookLibrary } from './application/playbook-library.js';

export { createWorkflowTemplates } from './application/templates.js';

export {
  parseWorkflowSource,
  printWorkflowSource,
} from './domain/workflow-code.js';

export { createPlaybookLibraryStore } from './infrastructure/playbooks/library.js';

export { createPlaybookActivations } from './application/playbook-activations.js';

export { createPlaybookStore } from './infrastructure/playbooks/store.js';

export { activationRequestSchema } from './infrastructure/playbooks/schema.js';

export { createPlaybookService, parsePlaybookSnapshot, playbookHash };

export {
  defineWorkflow,
  compileWorkflow,
  printWorkflowCode,
  parseWorkflowCode,
} from './infrastructure/workflow-schema.js';

export { compileProcessWorkflow } from './infrastructure/process-schema.js';

export { runProcess } from './application/process-runtime.js';

export { createProcessActivities } from './application/process-activities.js';

export { createProcessStepStore } from './infrastructure/process-store.js';

export type {
  ProcessActivities,
  ProcessClock,
  ProcessProgress,
} from './application/process-runtime.js';

export type {
  ProcessRun,
  ProcessStep,
  ProcessStepOutput,
  ProcessWorkflowVersion,
} from './domain/process.js';

/** Composes the catalog with refreshed membership and shared resolution admission controls. */
export function createWorkflows(
  db: TenantDatabase,
  legacy: PlaybookLibrary,
  refreshContext: (context: TenantContext) => Promise<TenantContext>,
  replenishment?: import('./application/replenishment-port.js').ReplenishmentWorkflow,
  codeProcesses?: Pick<
    ReturnType<typeof createCodeProcesses>,
    'supported' | 'start'
  >,
  explain?: (
    context: TenantContext,
    version: PublishedWorkflowVersion,
  ) => Promise<string[]>,
) {
  return createWorkflowCatalog({
    ...(explain ? { explain } : {}),
    ...(codeProcesses ? { codeProcesses } : {}),
    ...(process.env.LUMA_CODE_RUNTIME_DIR
      ? {
          codeEvaluations: createCodeEvaluations({
            store: createCodeEvaluationStore(db),
            runner: createWasmtimeRunner({
              directory: process.env.LUMA_CODE_RUNTIME_DIR,
            }),
            version: createWorkflowTriggerStore(db).version,
            refreshContext,
            hash: playbookHash,
          }),
        }
      : {}),
    ...(replenishment ? { replenishment } : {}),
    triggers: createWorkflowTriggers({
      store: createWorkflowTriggerStore(db),
      refreshContext,
      hash: playbookHash,
      id: randomUUID,
      now: () => new Date(),
      parseSnapshot: (input, version) => {
        if (version.format === 'workflow/2')
          return parseProcessSnapshot(input, version);
        const [eligibility, action, approval, verification, recovery] =
          version.steps;

        return parsePlaybookSnapshot(input, {
          definition: version.definition,
          version: version.version,
          digest: version.digest,
          compatibility: { interpreter: 'resolution-playbook/0', admission: 1 },
          provenance: version.provenance,
          ir: {
            schemaVersion: 1,
            inputs: version.inputs,
            evidence: version.context,
            eligibility,
            action,
            approval,
            verification,
            recovery,
          },
        });
      },
    }),
    store: createWorkflowCatalogStore(db),
    legacy,
    compile: compilePublishedWorkflow,
    refreshContext,
  });
}

export { createWorkflowTriggerStore } from './infrastructure/triggers.js';

export { createWorkflowCatalogStore } from './infrastructure/catalog.js';

export { createWorkflowTriggers } from './application/triggers.js';

export { parseProcessSnapshot } from './infrastructure/process-schema.js';

export { presentProcessVersion } from './domain/process-presentation.js';

export { presentTriggerRun } from './application/trigger-presentation.js';

export { defineCodeStep, checkCodeStep } from './infrastructure/code/schema.js';

export { createWasmtimeRunner } from './infrastructure/code/runner.js';

export { createCodeJournal } from './infrastructure/code/journal.js';

export { createCodeProcesses } from './infrastructure/code-processes.js';

/**
 * Composes draft authoring with the workflow catalog, tenant persistence and transactional audit.
 * `builtIn` lists definition IDs owned by domain adapters; drafts cannot publish under them.
 */
export function createDrafts(
  db: TenantDatabase,
  deps: {
    refreshContext(context: TenantContext): Promise<TenantContext>;
    audit(db: TenantDatabase): {
      append(entry: WorkflowAuditEntry): Promise<void>;
    };
    sources: VocabularySource[];
    builtIn: string[];
    templates?: TemplateSource[];
  },
) {
  const catalog = createWorkflowCatalogStore(db);
  const templates = deps.templates ?? [];
  const reserved = createReservedDefinitions(db);

  return createWorkflowDrafts({
    store: createWorkflowDraftStore(db, deps.audit),
    versions: (context, id) => catalog.versions(context, id),
    reserved: async (context) =>
      new Set([...deps.builtIn, ...(await reserved(context.tenantId))]),
    sources: deps.sources,
    codeStep: {
      runtime: codeRuntime,
      limits: {
        fuel: 100_000_000,
        memoryBytes: 67_108_864,
        wallTimeMs: 5000,
        maxRequests: 0,
      },
    },
    parseShape: parseDraftShape,
    check: checkDraftContent,
    fromVersion: draftFromVersion,
    template: (id) => {
      const found = templates.find((item) => item.id === id);
      if (!found)
        throw new IdentityError(404, 'NOT_FOUND', 'Template not found.');

      return found.content();
    },
    refreshContext: deps.refreshContext,
    hash: playbookHash,
    id: randomUUID,
    now: () => new Date(),
  });
}

export {
  checkDraftContent,
  checkProcessWorkflow,
  draftFromVersion,
  parseDraftShape,
} from './infrastructure/process-schema.js';

/**
 * Composes draft tests with tenant persistence and the `workflow/2` interpreter. Code Steps run in
 * the sandbox only when `LUMA_CODE_RUNTIME_DIR` is set. Real-run examples come from the recent
 * runs of the workflow a draft edits, read under the caller's tenant.
 */
export function createDraftTestRuns(
  db: TenantDatabase,
  deps: {
    refreshContext(context: TenantContext): Promise<TenantContext>;
    vocabulary(context: TenantContext): Promise<AuthoringVocabulary>;
    scenarioSources: TestScenarioSource[];
  },
) {
  // Tests only read drafts, so the draft store never writes an audit entry here.
  const drafts = createWorkflowDraftStore(db, () => ({
    append: async () => {
      throw new Error('Draft tests never change drafts');
    },
  }));
  const runs = createWorkflowTriggerStore(db);
  const catalog = createWorkflowCatalogStore(db);

  return createDraftTests({
    drafts,
    check: checkDraftContent,
    store: createDraftTestStore(db),
    ...(process.env.LUMA_CODE_RUNTIME_DIR
      ? {
          runner: createWasmtimeRunner({
            directory: process.env.LUMA_CODE_RUNTIME_DIR,
          }),
        }
      : {}),
    vocabulary: deps.vocabulary,
    async recentRuns(context, definitionId) {
      const recent = (await runs.list(context, definitionId)).slice(0, 10);
      const steps = await catalog.processSteps(
        context,
        recent.map((run) => run.id),
      );

      return recent.map((run) => ({ run, steps: steps.get(run.id) ?? [] }));
    },
    scenarioSources: deps.scenarioSources,
    refreshContext: deps.refreshContext,
    hash: playbookHash,
    id: randomUUID,
    now: () => new Date(),
  });
}

/** Correlates model calls with a request when the caller has no active trace. */
function generationTrace(context: { requestId: string }): TraceContext {
  return {
    requestId: context.requestId,
    traceId: randomBytes(16).toString('hex'),
    spanId: randomBytes(8).toString('hex'),
  };
}

/**
 * Composes natural-language authoring with the draft service, the Model Gateway and tenant
 * persistence for generation records. When `availability` is false, requests fail with its
 * reason and no model is called.
 */
export function createDraftGenerations(
  db: TenantDatabase,
  deps: {
    drafts: WorkflowDrafts;
    gateway: ModelGateway | null;
    availability: GenerationAvailability;
    refreshContext(context: TenantContext): Promise<TenantContext>;
  },
) {
  return createDraftGeneration({
    gateway: deps.gateway,
    availability: deps.availability,
    drafts: deps.drafts,
    store: createGenerationStore(db),
    outputs: { draft: draftOutput, codeStep: codeStepOutput },
    compileCode: codeSourceProblem,
    refreshContext: deps.refreshContext,
    hash: playbookHash,
    id: randomUUID,
    now: () => new Date(),
    trace: generationTrace,
  });
}

/**
 * Describes workflows with the production prompts, output schema, re-asks and server checks, but
 * without persistence or publication checks. Used by `pnpm evaluate:authoring`.
 */
export function createAuthoringHarness(deps: {
  gateway: ModelGateway;
  vocabulary: AuthoringVocabulary;
  maxAttempts?: number;
  timeoutMs?: number;
}) {
  const provenance = {
    kind: 'native' as const,
    reference: 'authoring-evaluation',
    authoredBy: 'evaluation',
    evidenceRefs: ['authoring-evaluation'],
  };

  return {
    /** Generates one draft. Model failures are returned in `failure`, not thrown. */
    describe(prompt: string) {
      const draftId = randomUUID();

      return generateDraft({
        gateway: deps.gateway,
        trace: generationTrace({ requestId: draftId }),
        signal: AbortSignal.timeout(deps.timeoutMs ?? 60_000),
        maxAttempts: deps.maxAttempts ?? 3,
        vocabulary: deps.vocabulary,
        messages: describeMessages(deps.vocabulary, prompt),
        output: draftOutput(deps.vocabulary),
        identity: (content) => describedIdentity(content, draftId),
        validate: async (content) => {
          const shape = parseDraftShape(content);
          if (!shape.content) return shape;

          return {
            content: shape.content,
            diagnostics: [
              ...checkDraftContent(shape.content, provenance).diagnostics,
              ...checkVocabulary(shape.content, deps.vocabulary),
            ],
          };
        },
      });
    },
  };
}

export { authoringPromptVersion } from './domain/draft-generation.js';
