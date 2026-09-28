import type { TenantContext } from '@luma/identity';
import { IdentityError, requireRole, requireTenant } from '@luma/identity';

import {
  type CodeActivityResult,
  CodeRequestStopped,
  type CodeRunner,
  type CodeStep,
} from '../domain/code-step.js';
import type { WorkflowDraft, WorkflowDraftContent } from '../domain/draft.js';
import {
  adaptCase,
  checkTestCase,
  type CodeRequestExample,
  defaultCase,
  type DraftTestCase,
  type DraftTestRun,
  repliesFromOutputs,
  type StepReply,
  type TestOutcome,
  type TestScenario,
} from '../domain/draft-test.js';
import { presentTestResult } from '../domain/draft-test-presentation.js';
import type { PlaybookSnapshot } from '../domain/playbook.js';
import type {
  ProcessRun,
  ProcessStepOutput,
  ProcessWorkflowVersion,
} from '../domain/process.js';
import type { AuthoringVocabulary } from '../domain/vocabulary.js';
import type { WorkflowRun } from '../domain/workflow.js';
import {
  type ProcessActivities,
  type ProcessClock,
  type ProcessProgress,
  runProcess,
} from './process-runtime.js';

/** A test run with the fingerprints used for retries and for matching saved cases. */
export interface StoredDraftTestRun extends DraftTestRun {
  requestDigest: string;
  /** Digest of the saved case the run tested, or null for an unsaved case. */
  caseDigest: string | null;
}

/** Saved cases for one draft. `revision` is 0 until cases are first saved. */
export interface SavedDraftTests {
  revision: number;
  cases: DraftTestCase[];
}

/** Tenant-isolated persistence for saved cases and actor-owned runs. */
export interface DraftTestStore {
  cases(context: TenantContext, draftId: string): Promise<SavedDraftTests>;
  /** Replaces saved cases when `revision` is current. Returns null when it is stale. */
  saveCases(
    context: TenantContext,
    draftId: string,
    revision: number,
    cases: DraftTestCase[],
  ): Promise<SavedDraftTests | null>;
  /** Reads a run started by the current actor. */
  get(
    context: TenantContext,
    draftId: string,
    id: string,
  ): Promise<StoredDraftTestRun | null>;
  /** Lists runs of saved cases on one draft revision by every actor, newest first. */
  runs(
    context: TenantContext,
    draftId: string,
    revision: number,
  ): Promise<StoredDraftTestRun[]>;
  /**
   * Inserts a run unless its ID exists. An existing ID with a different digest, actor or draft
   * returns a conflict.
   */
  reserve(
    context: TenantContext,
    draftId: string,
    item: StoredDraftTestRun,
  ): Promise<{ item: StoredDraftTestRun; created: boolean }>;
  /** Stores the terminal state of a run that is still running and not expired. */
  finish(
    context: TenantContext,
    draftId: string,
    item: StoredDraftTestRun,
  ): Promise<void>;
  cancel(context: TenantContext, draftId: string, id: string): Promise<void>;
}

/** Contributes named example cases for drafts that use an adapter's steps. */
export interface TestScenarioSource {
  /** Returns the scenarios that apply to the draft. Must not read connected systems. */
  scenarios(content: WorkflowDraftContent): TestScenario[];
}

/** Whether saved cases pass on the current draft revision. */
export interface DraftTestSummary {
  draftRevision: number;
  revision: number;
  cases: DraftTestCase[];
  results: {
    caseId: string;
    runId: string | null;
    state: DraftTestRun['state'] | null;
    outcome: TestOutcome | null;
    passed: boolean | null;
    /** Why the case could not run on this revision. */
    error: string | null;
  }[];
  /** Why no saved case can run on this revision, for example because the draft has errors. */
  blocked: string | null;
}

/** Starts one run of an exact draft revision with a saved case or an unsaved one. */
export interface StartDraftTest {
  id: string;
  revision: number;
  caseId?: string | undefined;
  case?: DraftTestCase | undefined;
}

type Check = (
  input: unknown,
  provenance: ProcessWorkflowVersion['provenance'],
) => {
  version: ProcessWorkflowVersion | null;
  diagnostics: { severity: 'error' | 'warning'; message: string }[];
};

/** Stops the interpreter where a person would have to decide. */
class TestPaused extends Error {}

/** Stops the interpreter after the run was cancelled. */
class TestCancelled extends Error {}

/** A failure the author can act on. */
class TestFailed extends Error {}

const noRuntime =
  'Code Steps can’t run on this Luma server. Whoever runs the server needs to install the Code Step runtime.';
const interrupted = 'The test run was interrupted. Run it again.';
const reload = 'Reload the draft and run the test again.';
const maxActive = 2;
const maxCases = 20;

const conflict = (message: string): never => {
  throw new IdentityError(409, 'CONFLICT', message);
};

/**
 * Runs a Code Step in the sandbox against example replies, with the same capability rules as
 * production: a read returns its reply, an accepted action returns its result check's values
 * when that check is verified, and anything else is denied. Nothing leaves the process.
 */
export async function runExampleCode(
  options: { runner: CodeRunner; now: string; signal: AbortSignal },
  version: Pick<ProcessWorkflowVersion, 'steps'>,
  step: CodeStep,
  input: unknown,
  replies: Record<string, StepReply>,
): Promise<{ result: CodeActivityResult; requests: CodeRequestExample[] }> {
  const requests: CodeRequestExample[] = [];
  const evidence = new Set<string>();
  let waiting = false;
  let verifiedActions = 0;
  const result = await options.runner.run(step, input, {
    now: options.now,
    signal: options.signal,
    async request(grant) {
      if (options.signal.aborted) throw new CodeRequestStopped('cancelled');
      if (!step.grants.includes(grant))
        throw new CodeRequestStopped('capability_denied');
      const node = version.steps.find((item) => item.id === grant);
      const reply = replies[grant];
      if (node?.kind === 'read' && reply?.kind === 'read') {
        requests.push({
          stepId: grant,
          state: 'completed',
          values: reply.values,
        });
        evidence.add(`example:${grant}`);

        return reply.values;
      }
      if (node?.kind !== 'capability' || reply?.kind !== 'capability')
        throw new CodeRequestStopped('capability_denied');
      if (reply.result === 'approval_required') {
        waiting = true;
        evidence.add(`example:${grant}:decision`);
        requests.push({ stepId: grant, state: 'waiting', values: {} });
        throw new CodeRequestStopped('capability_denied');
      }
      if (reply.result === 'denied') {
        requests.push({ stepId: grant, state: 'denied', values: {} });
        throw new CodeRequestStopped('capability_denied');
      }
      requests.push({ stepId: grant, state: 'completed', values: {} });
      const check = version.steps.find(
        (item) => item.kind === 'verification' && item.forStep === grant,
      );
      const checked = check ? replies[check.id] : undefined;
      if (!check || checked?.kind !== 'verification')
        throw new CodeRequestStopped('capability_denied');
      requests.push({
        stepId: check.id,
        state: checked.state === 'verified' ? 'completed' : checked.state,
        values: checked.values,
      });
      if (checked.state !== 'verified')
        throw new CodeRequestStopped('capability_denied');
      verifiedActions++;
      evidence.add(`example:${grant}`).add(`example:${check.id}`);

      return checked.values;
    },
  });
  const outcome = result.telemetry.outcome;
  const paused = waiting && !['cancelled', 'resource_limit'].includes(outcome);

  return {
    result: {
      ...result,
      telemetry: { ...result.telemetry, verifiedActions },
      state: paused
        ? 'awaiting_approval'
        : outcome === 'completed'
          ? 'completed'
          : 'failed',
      evidenceRefs: [step.artifactDigest, ...evidence],
    },
    requests,
  };
}

/** Example activities built only from a case's replies. They never reach a connected system. */
function exampleActivities(
  testCase: DraftTestCase,
  options: {
    runner: CodeRunner | undefined;
    signal: AbortSignal;
    clock: ProcessClock;
    outputs: ProcessStepOutput[];
    requests: Map<string, CodeRequestExample[]>;
  },
): ProcessActivities {
  const { clock, signal } = options;
  const live = () => {
    if (signal.aborted) throw new TestCancelled();
  };
  const reply = <K extends StepReply['kind']>(id: string, kind: K) => {
    const found = testCase.replies[id];

    return found?.kind === kind
      ? (found as Extract<StepReply, { kind: K }>)
      : undefined;
  };

  return {
    async read(_run, step) {
      live();

      return {
        values: reply(step.id, 'read')?.values ?? {},
        evidenceRefs: [`example:${step.id}`],
        observedAt: clock.now(),
      };
    },
    async decision(_run, step) {
      live();
      const decision = reply(step.id, 'approval')?.decision ?? 'pending';

      return decision === 'pending'
        ? { state: 'pending' }
        : { state: decision, decisionId: `example:${step.id}` };
    },
    async action(_run, _version, step) {
      live();
      const result = reply(step.id, 'capability')?.result;
      const proposalId = `example:${step.id}`;
      if (result === 'accepted')
        return {
          state: 'accepted',
          proposalId,
          receiptId: `example:${step.id}:receipt`,
        };
      if (result === 'approval_required')
        return {
          state: 'awaiting_approval',
          proposalId,
          decisionId: `example:${step.id}:decision`,
        };

      return { state: 'denied', proposalId, reason: 'action_denied' };
    },
    async verify(_run, step) {
      live();
      const result = reply(step.id, 'verification');

      return {
        state: result?.state ?? 'inconclusive',
        evidenceRefs: [`example:${step.id}`],
        values: result?.values ?? {},
      };
    },
    async record(_run, output) {
      live();
      options.outputs.push(output);
    },
    async code(run, version, step, outputs) {
      live();
      if (!options.runner) throw new TestFailed(noRuntime);
      const { result, requests } = await runExampleCode(
        { runner: options.runner, now: run.createdAt, signal },
        version,
        step,
        {
          inputs: run.context.inputs,
          evidence: run.context.evidence.facts,
          steps: Object.fromEntries(
            outputs
              .filter((output) => output.state === 'completed')
              .map((output) => [output.stepId, output.values]),
          ),
        },
        testCase.replies,
      );
      options.requests.set(step.id, requests);

      return result;
    },
  };
}

/** Derives a stable UUID from a hex digest. */
function uuidFrom(digest: string) {
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/**
 * Tests draft revisions against example data with the production `workflow/2` interpreter.
 * Example replies stand in for every read, decision, action and result check, so a test never
 * calls a connector, Action Admission or a capability adapter. Test results are evidence for the
 * author; they grant no activation or approval.
 */
export function createDraftTests(deps: {
  drafts: {
    get(context: TenantContext, id: string): Promise<WorkflowDraft | null>;
  };
  check: Check;
  store: DraftTestStore;
  /** Runs Code Steps in the sandbox. Without it, drafts with Code Steps can't be tested. */
  runner?: CodeRunner | undefined;
  vocabulary(context: TenantContext): Promise<AuthoringVocabulary>;
  /** Recent runs of a published definition, read under the caller's tenant and membership. */
  recentRuns(
    context: TenantContext,
    definitionId: string,
  ): Promise<{ run: WorkflowRun; steps: ProcessStepOutput[] }[]>;
  scenarioSources: TestScenarioSource[];
  refreshContext(context: TenantContext): Promise<TenantContext>;
  hash(value: unknown): string;
  id(): string;
  now(): Date;
  /** Virtual time every test run starts at. */
  clockStart?: string | undefined;
}) {
  const clockStart = deps.clockStart ?? '2026-01-01T00:00:00.000Z';
  let active = 0;

  async function authorize(context: TenantContext, write = false) {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    requireRole(
      fresh,
      write ? ['owner', 'admin'] : ['owner', 'admin', 'member'],
    );
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Sign in again to continue.');

    return fresh;
  }

  async function open(context: TenantContext, id: string) {
    const draft = await deps.drafts.get(context, id);
    if (!draft || draft.state === 'discarded')
      throw new IdentityError(404, 'NOT_FOUND', 'Draft not found.');

    return draft;
  }

  function compile(context: TenantContext, draft: WorkflowDraft) {
    const checked = deps.check(draft.content, {
      kind: 'native',
      reference: `draft:${draft.id}@${draft.revision}`,
      authoredBy: context.actor.id,
      evidenceRefs: [`draft:${draft.id}`],
      authoring: {
        mode: draft.mode,
        draftId: draft.id,
        revision: draft.revision,
      },
    });

    return {
      version: checked.version,
      problem: checked.version
        ? null
        : (checked.diagnostics.find((item) => item.severity === 'error')
            ?.message ?? 'Fix the draft before testing it.'),
    };
  }

  function view(item: StoredDraftTestRun): DraftTestRun {
    const run: DraftTestRun = {
      id: item.id,
      draftId: item.draftId,
      revision: item.revision,
      caseId: item.caseId,
      state: item.state,
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
      result: item.result,
      error: item.error,
    };
    if (
      run.state === 'running' &&
      Date.parse(run.expiresAt) < deps.now().getTime()
    )
      return { ...run, state: 'failed', result: null, error: interrupted };

    return run;
  }

  /** Budget for one run: every Code Step's wall time plus a margin. */
  function budget(version: ProcessWorkflowVersion) {
    return (
      version.steps.reduce(
        (total, step) =>
          total + (step.kind === 'code' ? step.limits.wallTimeMs : 0),
        0,
      ) + 5000
    );
  }

  async function exercise(
    context: TenantContext,
    version: ProcessWorkflowVersion,
    testCase: DraftTestCase,
    runId: string,
    signal: AbortSignal,
  ) {
    if (version.steps.some((step) => step.kind === 'code') && !deps.runner)
      throw new TestFailed(noRuntime);
    const vocabulary = await deps.vocabulary(context);
    let time = Date.parse(clockStart);
    const clock: ProcessClock = {
      now: () => new Date(time).toISOString(),
      async wait(milliseconds) {
        time += milliseconds;
      },
      async decisionChanged() {
        throw new TestPaused();
      },
    };
    const snapshot: PlaybookSnapshot = {
      inputs: testCase.inputs,
      evidence: {
        kind: version.context.kind,
        facts: testCase.evidence,
        observations: [
          { id: deps.id(), observedAt: clockStart, source: 'example' },
        ],
      },
      provenance: { reference: 'example', capturedAt: clockStart },
    };
    const run: ProcessRun = {
      id: runId,
      tenantId: context.tenantId,
      definitionId: version.definition.id,
      version: version.version,
      versionDigest: version.digest,
      subject: { kind: version.applicability.subjectKind, id: 'example' },
      actor: { kind: 'user', id: context.actor.id },
      context: snapshot,
      contextDigest: deps.hash(snapshot),
      createdAt: clockStart,
    };
    const outputs: ProcessStepOutput[] = [];
    const requests = new Map<string, CodeRequestExample[]>();
    let progress: ProcessProgress = { state: 'running', stepId: null };
    let final: ProcessProgress;
    try {
      final = await runProcess(
        run,
        version,
        exampleActivities(testCase, {
          runner: deps.runner,
          signal,
          clock,
          outputs,
          requests,
        }),
        clock,
        (next) => {
          progress = next;
        },
      );
    } catch (error) {
      if (!(error instanceof TestPaused)) throw error;
      final = { ...progress, state: 'awaiting_decision' };
    }
    if (['running', 'waiting'].includes(final.state))
      throw new Error('The interpreter stopped without an outcome');

    return presentTestResult({
      version,
      run,
      outputs,
      requests,
      final: { state: final.state as TestOutcome, stepId: final.stepId },
      expected: testCase.expected,
      vocabulary,
    });
  }

  /** Runs reserved cases one after another and records each terminal state. Never throws. */
  async function execute(
    context: TenantContext,
    draftId: string,
    version: ProcessWorkflowVersion,
    jobs: { item: StoredDraftTestRun; testCase: DraftTestCase }[],
  ) {
    for (const { item, testCase } of jobs) {
      // A queued run may have been cancelled while earlier runs in its batch were running.
      const current = await deps.store
        .get(context, draftId, item.id)
        .catch(() => null);
      if (current?.state !== 'running') continue;
      const stop = new AbortController();
      const poll = setInterval(() => {
        void deps.store
          .get(context, draftId, item.id)
          .then((current) => {
            if (current?.state !== 'running') stop.abort();
          })
          .catch(() => stop.abort());
      }, 200);
      try {
        const result = await exercise(
          context,
          version,
          testCase,
          item.id,
          stop.signal,
        );
        if (!stop.signal.aborted)
          await deps.store.finish(context, draftId, {
            ...item,
            state: 'completed',
            result,
          });
      } catch (error) {
        if (!(error instanceof TestCancelled))
          await deps.store
            .finish(context, draftId, {
              ...item,
              state: 'failed',
              error:
                error instanceof TestFailed
                  ? error.message
                  : 'The test run stopped unexpectedly. Run it again.',
            })
            .catch(() => undefined);
      } finally {
        clearInterval(poll);
        stop.abort();
      }
    }
  }

  function claimSlot() {
    if (active >= maxActive)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'The test runner is busy. Try again shortly.',
      );
    active++;
  }

  function background(
    context: TenantContext,
    draftId: string,
    version: ProcessWorkflowVersion,
    jobs: { item: StoredDraftTestRun; testCase: DraftTestCase }[],
  ) {
    void execute(context, draftId, version, jobs).finally(() => {
      active--;
    });
  }

  async function summary(
    context: TenantContext,
    draft: WorkflowDraft,
    saved?: SavedDraftTests,
  ): Promise<DraftTestSummary> {
    const tests = saved ?? (await deps.store.cases(context, draft.id));
    const runs = (await deps.store.runs(context, draft.id, draft.revision)).map(
      (item) => ({ item, run: view(item) }),
    );
    const { version, problem } = compile(context, draft);

    return {
      draftRevision: draft.revision,
      revision: tests.revision,
      cases: tests.cases,
      results: tests.cases.map((testCase) => {
        const digest = deps.hash(testCase);
        const mine = runs
          .filter(
            ({ item }) =>
              item.caseId === testCase.id && item.caseDigest === digest,
          )
          .map(({ run }) => run);
        const latest =
          mine.find((run) => run.state === 'completed') ?? mine[0] ?? null;
        const unfit = version
          ? (checkTestCase(version, testCase)[0]?.message ?? null)
          : null;

        return {
          caseId: testCase.id,
          runId: latest?.id ?? null,
          state: latest?.state ?? null,
          outcome: latest?.result?.outcome ?? null,
          passed: latest?.result?.passed ?? null,
          error: latest ? latest.error : unfit,
        };
      }),
      blocked: problem,
    };
  }

  function newRun(
    draft: WorkflowDraft,
    input: {
      id: string;
      caseId: string | null;
      caseDigest: string | null;
      requestDigest: string;
      expiresInMs: number;
    },
  ): StoredDraftTestRun {
    const now = deps.now();

    return {
      id: input.id,
      draftId: draft.id,
      revision: draft.revision,
      caseId: input.caseId,
      state: 'running',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.expiresInMs).toISOString(),
      result: null,
      error: null,
      requestDigest: input.requestDigest,
      caseDigest: input.caseDigest,
    };
  }

  async function get(context: TenantContext, draftId: string, id: string) {
    const item = await deps.store.get(context, draftId, id);
    if (!item) throw new IdentityError(404, 'NOT_FOUND', 'Test run not found.');

    return view(item);
  }

  return {
    /** Lists saved cases and whether each passes on the current draft revision. Members can read. */
    async cases(context: TenantContext, draftId: string) {
      context = await authorize(context);

      return summary(context, await open(context, draftId));
    },
    /**
     * Replaces the saved cases when `revision` is current; a stale revision returns a conflict.
     * Retrying the same body after an uncertain response returns the saved cases.
     */
    async saveCases(
      context: TenantContext,
      draftId: string,
      input: { revision: number; cases: DraftTestCase[] },
    ) {
      context = await authorize(context, true);
      const draft = await open(context, draftId);
      if (input.cases.length > maxCases)
        conflict(`Save at most ${maxCases} test cases.`);
      if (
        new Set(input.cases.map((item) => item.id)).size !== input.cases.length
      )
        conflict('Give each test case a unique ID.');
      if (input.cases.some((item) => !item.name.trim()))
        conflict('Name every test case.');
      const saved = await deps.store.saveCases(
        context,
        draftId,
        input.revision,
        input.cases,
      );
      if (saved) return summary(context, draft, saved);
      const current = await deps.store.cases(context, draftId);
      if (
        current.revision !== input.revision + 1 ||
        deps.hash(current.cases) !== deps.hash(input.cases)
      )
        conflict(
          'Someone else changed these test cases. Reload them before saving.',
        );

      return summary(context, draft, current);
    },
    /**
     * Starts runs for saved cases that have no passing or running result on the current revision,
     * one after another. Run IDs derive from the draft revision and case, so repeating the call is
     * safe. Returns the same summary as `cases`.
     */
    async runAll(
      context: TenantContext,
      draftId: string,
      input: { revision: number },
    ) {
      context = await authorize(context, true);
      const draft = await open(context, draftId);
      if (draft.revision !== input.revision) conflict(reload);
      const saved = await deps.store.cases(context, draftId);
      const { version } = compile(context, draft);
      if (!version) return summary(context, draft, saved);
      const runs = await deps.store.runs(context, draftId, draft.revision);
      const pending = saved.cases.flatMap((testCase) => {
        if (checkTestCase(version, testCase).length) return [];
        const caseDigest = deps.hash(testCase);
        const mine = runs
          .filter(
            (item) =>
              item.caseId === testCase.id && item.caseDigest === caseDigest,
          )
          .map(view);
        if (mine.some((run) => ['completed', 'running'].includes(run.state)))
          return [];
        const id = uuidFrom(
          deps.hash({
            draftId,
            revision: draft.revision,
            caseId: testCase.id,
            caseDigest,
            after: mine[0]?.id ?? null,
          }),
        );

        return [{ testCase, caseDigest, id }];
      });
      if (!pending.length) return summary(context, draft, saved);
      claimSlot();
      const jobs: { item: StoredDraftTestRun; testCase: DraftTestCase }[] = [];
      try {
        for (const [index, entry] of pending.entries()) {
          const item = newRun(draft, {
            id: entry.id,
            caseId: entry.testCase.id,
            caseDigest: entry.caseDigest,
            requestDigest: deps.hash({
              draftId,
              revision: draft.revision,
              caseId: entry.testCase.id,
              caseDigest: entry.caseDigest,
              actorId: context.actor.id,
            }),
            expiresInMs: (index + 1) * budget(version),
          });
          try {
            const reserved = await deps.store.reserve(context, draftId, item);
            if (reserved.created) jobs.push({ item, testCase: entry.testCase });
          } catch (error) {
            // Another person started the same saved case first; their run is in the summary.
            if (!(error instanceof IdentityError && error.statusCode === 409))
              throw error;
          }
        }
      } catch (error) {
        active--;
        throw error;
      }
      if (jobs.length) background(context, draftId, version, jobs);
      else active--;

      return summary(context, draft, saved);
    },
    /**
     * Suggests example data: empty values from the declared fields, recent runs of the published
     * workflow this draft edits, and scenarios from installed adapters. Members can read.
     */
    async examples(context: TenantContext, draftId: string) {
      context = await authorize(context);
      const draft = await open(context, draftId);
      const content = draft.content;
      const fields = defaultCase(content, deps.id());
      const recent = draft.basedOn
        ? (await deps.recentRuns(context, draft.basedOn.definitionId)).slice(
            0,
            10,
          )
        : [];

      return {
        fields,
        runs: recent.map(({ run, steps }) => ({
          runId: run.id,
          createdAt: run.createdAt,
          case: adaptCase(
            content,
            null,
            {
              inputs: run.context.inputs,
              evidence: run.context.evidence.facts,
              replies: repliesFromOutputs(steps),
            },
            {
              ...fields,
              id: deps.id(),
              name: `Run from ${run.createdAt.slice(0, 16).replace('T', ' ')} UTC`,
            },
          ),
        })),
        scenarios: deps.scenarioSources
          .flatMap((source) => source.scenarios(content))
          .map((scenario) => ({
            ...scenario,
            case: { ...scenario.case, id: deps.id() },
          })),
      };
    },
    /**
     * Starts one test run of the current draft revision with a saved case or an unsaved one.
     * Reuse the same ID and body after an uncertain response; the same ID with a different body
     * returns a conflict.
     */
    async start(
      context: TenantContext,
      draftId: string,
      input: StartDraftTest,
    ) {
      context = await authorize(context, true);
      if (!input.caseId === !input.case)
        conflict('Choose a saved test case or supply one.');
      const requestDigest = deps.hash({
        draftId,
        input,
        actorId: context.actor.id,
      });
      const existing = await deps.store.get(context, draftId, input.id);
      if (existing) {
        if (existing.requestDigest !== requestDigest)
          conflict(
            'This test run ID was already used with different inputs. Reuse the original request.',
          );

        return view(existing);
      }
      const draft = await open(context, draftId);
      if (draft.revision !== input.revision) conflict(reload);
      let testCase = input.case;
      if (input.caseId) {
        testCase = (await deps.store.cases(context, draftId)).cases.find(
          (item) => item.id === input.caseId,
        );
        if (!testCase)
          throw new IdentityError(404, 'NOT_FOUND', 'Test case not found.');
      }
      const { version, problem } = compile(context, draft);
      if (!version) return conflict(problem!);
      const unfit = checkTestCase(version, testCase!)[0];
      if (unfit) conflict(unfit.message);
      claimSlot();
      let reserved: { item: StoredDraftTestRun; created: boolean };
      try {
        reserved = await deps.store.reserve(
          context,
          draftId,
          newRun(draft, {
            id: input.id,
            caseId: input.caseId ?? null,
            caseDigest: input.caseId ? deps.hash(testCase) : null,
            requestDigest,
            expiresInMs: budget(version),
          }),
        );
      } catch (error) {
        active--;
        throw error;
      }
      if (!reserved.created) {
        active--;

        return view(reserved.item);
      }
      background(context, draftId, version, [
        { item: reserved.item, testCase: testCase! },
      ]);

      return view(reserved.item);
    },
    /** Reads a run you started. Runs left running past their deadline read as failed. */
    async get(context: TenantContext, draftId: string, id: string) {
      return get(await authorize(context), draftId, id);
    },
    /** Cancels a run you started. Cancelling a finished run returns it unchanged. */
    async cancel(context: TenantContext, draftId: string, id: string) {
      context = await authorize(context, true);
      await get(context, draftId, id);
      await deps.store.cancel(context, draftId, id);

      return get(context, draftId, id);
    },
  };
}

export type DraftTests = ReturnType<typeof createDraftTests>;
