import { randomUUID } from 'node:crypto';

import { makeTenantContext } from '@luma/identity';
import {
  createReplenishmentScenarios,
  replenishmentSource,
} from '@luma/procurement';
import {
  type AuthoringVocabulary,
  createDraftTests,
  type DraftTestStore,
  type StoredDraftTestRun,
  type WorkflowDraft,
  type WorkflowDraftContent,
} from '@luma/workflows';
import {
  checkDraftContent,
  compileProcessWorkflow,
  draftFromVersion,
  playbookHash,
} from '@luma/workflows/composition';
import { describe, expect, it, vi } from 'vitest';

const owner = makeTenantContext(
  { userId: 'owner-id', sessionId: 'session' },
  {
    id: 'tenant',
    name: 'Tenant',
    slug: 'tenant',
    dataRegion: 'EU',
    status: 'active',
  },
  {
    id: 'membership',
    organizationId: 'tenant',
    userId: 'owner-id',
    role: 'owner',
  },
  'request',
);
const version = compileProcessWorkflow(replenishmentSource);
const vocabulary: AuthoringVocabulary = {
  triggers: [],
  stepKinds: [],
  subjects: [],
  reads: [],
  capabilities: [],
  evaluators: [],
  codeSteps: {
    executable: false,
    reason: null,
    evaluation: false,
    runtime: 'none',
    limits: { fuel: 0, memoryBytes: 0, wallTimeMs: 0, maxRequests: 0 },
  },
};

// Final states and stopping steps from apps/api/e2e/replenishment.e2e.mjs.
const simulatorMatrix = {
  'approval-pending': ['awaiting_decision', 'create-order'],
  'approved-verified': ['verified', 'complete'],
  'policy-rejected': ['escalated', 'create-order'],
  'stale-inventory': ['escalated', 'fresh-stock'],
  'existing-order': ['ended', 'needs-order'],
  'verification-failed': ['failed_verification', 'verify-order'],
};

function setup(content: WorkflowDraftContent) {
  const runs = new Map<string, StoredDraftTestRun>();
  const store: DraftTestStore = {
    cases: async () => ({ revision: 0, cases: [] }),
    saveCases: async () => null,
    get: async (_context, _draftId, id) =>
      structuredClone(runs.get(id) ?? null),
    runs: async () => [],
    reserve: async (_context, _draftId, item) => {
      runs.set(item.id, structuredClone(item));

      return { item, created: true };
    },
    finish: async (_context, _draftId, item) => {
      runs.set(item.id, structuredClone(item));
    },
    cancel: async () => undefined,
  };
  const draft: WorkflowDraft = {
    id: randomUUID(),
    tenantId: 'tenant',
    revision: 1,
    state: 'draft',
    mode: 'template',
    content,
    codeView: null,
    basedOn: null,
    authorId: 'owner-id',
    updatedBy: 'owner-id',
    createdAt: '2026-09-28T10:00:00.000Z',
    updatedAt: '2026-09-28T10:00:00.000Z',
    published: null,
  };
  const service = createDraftTests({
    drafts: { get: async () => draft },
    check: checkDraftContent,
    store,
    vocabulary: async () => vocabulary,
    recentRuns: async () => [],
    scenarioSources: [createReplenishmentScenarios(version)],
    refreshContext: async (context) => context,
    hash: playbookHash,
    id: randomUUID,
    now: () => new Date(),
  });

  async function outcomes() {
    const { scenarios } = await service.examples(owner, draft.id);
    const results: Record<string, [string, string | null, boolean | null]> = {};
    for (const scenario of scenarios) {
      const started = await service.start(owner, draft.id, {
        id: randomUUID(),
        revision: 1,
        case: scenario.case,
      });
      const run = await vi.waitFor(
        async () => {
          const current = await service.get(owner, draft.id, started.id);
          if (current.state === 'running') throw new Error('still running');

          return current;
        },
        { timeout: 3000, interval: 5 },
      );
      results[scenario.id] = [
        run.result!.outcome,
        run.result!.stoppedAt,
        run.result!.passed,
      ];
    }

    return results;
  }

  return { outcomes };
}

describe('replenishment reference cases', () => {
  it('match the simulator matrix when run through the draft test runner', async () => {
    const results = await setup(draftFromVersion(version)).outcomes();
    expect(results).toEqual(
      Object.fromEntries(
        Object.entries(simulatorMatrix).map(([id, [outcome, step]]) => [
          id,
          [outcome, step, true],
        ]),
      ),
    );
  });

  it('apply to a customized copy with renamed steps', async () => {
    const content = draftFromVersion(version);
    const rename = (id: string) => (id === 'complete' ? id : `my-${id}`);
    const copy: WorkflowDraftContent = {
      ...content,
      definition: { ...content.definition, id: 'my-replenishment' },
      steps: content.steps.map((step) => {
        if (step.kind === 'capability')
          return {
            ...step,
            id: rename(step.id),
            parameters: {
              quantity: {
                source: 'step',
                stepId: 'my-proposal',
                field: 'quantity',
              },
            },
          };
        if (step.kind === 'verification')
          return {
            ...step,
            id: rename(step.id),
            forStep: rename(step.forStep),
          };

        return { ...step, id: rename(step.id) };
      }),
    };
    const results = await setup(copy).outcomes();
    expect(
      Object.fromEntries(
        Object.entries(results).map(([id, [outcome, , passed]]) => [
          id,
          [outcome, passed],
        ]),
      ),
    ).toEqual(
      Object.fromEntries(
        Object.entries(simulatorMatrix).map(([id, [outcome]]) => [
          id,
          [outcome, true],
        ]),
      ),
    );
  });
});
