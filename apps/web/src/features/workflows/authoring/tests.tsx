import type {
  DraftTestCase,
  DraftTestRun,
  DraftTestSummary,
  StepReply,
  TestOutcome,
  WorkflowDraft,
  WorkflowDraftContent,
} from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { IdentityError } from '../../identity/data';
import { workflowError } from '../data';
import {
  cancelDraftTest,
  draftTestExamplesOptions,
  draftTestRunOptions,
  draftTestsOptions,
  runDraftTests,
  saveDraftTests,
  startDraftTest,
} from './data';
import { type FieldType, humanize } from './draft-model';
import { ScalarInput } from './step-forms';

const outcomes: Record<TestOutcome, string> = {
  verified: 'Finished with a verified result',
  ended: 'Finished',
  denied: 'Stopped by a decision',
  failed_verification: 'Result check failed',
  inconclusive_verification: 'Result check was inconclusive',
  escalated: 'Handed to a person',
  awaiting_decision: 'Waits for a person to decide',
};

type Result = DraftTestSummary['results'][number] | undefined;

function resultBadge(result: Result, draftRevision: number) {
  if (!result?.state)
    return <Badge tone="neutral">Not run on revision {draftRevision}</Badge>;
  if (result.state === 'running') return <Badge tone="info">Running…</Badge>;
  if (result.error || result.state !== 'completed')
    return <Badge tone="warning">Couldn’t run</Badge>;
  if (result.passed === true) return <Badge tone="success">Passed</Badge>;
  if (result.passed === false) return <Badge tone="danger">Failed</Badge>;

  return (
    <Badge tone="neutral">
      {result.outcome ? outcomes[result.outcome] : 'Ran'}
    </Badge>
  );
}

/**
 * Re-runs saved test cases whenever a new draft revision is saved, whichever editor view is open.
 * Results appear in the Test view and the publish summary.
 */
export function useTestRerun({
  organizationId,
  draft,
  saved,
  canManage,
}: {
  organizationId: string;
  draft: WorkflowDraft;
  saved: boolean;
  canManage: boolean;
}) {
  const client = useQueryClient();
  const ran = useRef(0);

  useEffect(() => {
    if (!canManage || !saved || ran.current === draft.revision) return;
    ran.current = draft.revision;
    runDraftTests(organizationId, draft.id, draft.revision)
      .then((next) =>
        client.setQueryData(
          draftTestsOptions(organizationId, draft.id).queryKey,
          next,
        ),
      )
      .catch(() => undefined);
  }, [canManage, client, draft.id, draft.revision, organizationId, saved]);
}

/**
 * Runs the draft with example data and shows each step's result. Tests never call connected
 * systems or Action Admission, and passing tests grant no activation or approval. Saved cases are
 * re-run whenever the saved draft revision changes.
 */
export function DraftTestPanel({
  organizationId,
  draft,
  saved,
  canManage,
  content,
}: {
  organizationId: string;
  draft: WorkflowDraft;
  saved: boolean;
  canManage: boolean;
  content: WorkflowDraftContent;
}) {
  const client = useQueryClient();
  const options = draftTestsOptions(organizationId, draft.id);
  const summary = useQuery({
    ...options,
    refetchInterval: (query) =>
      query.state.data?.results.some((item) => item.state === 'running')
        ? 1000
        : false,
  });
  const [editing, setEditing] = useState<DraftTestCase | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function persist(cases: DraftTestCase[]) {
    if (!summary.data) return;
    setPending(true);
    setError('');
    try {
      const next = await saveDraftTests(organizationId, draft.id, {
        revision: summary.data.revision,
        cases,
      });
      client.setQueryData(options.queryKey, next);
      setEditing(null);
      if (saved && !next.blocked)
        client.setQueryData(
          options.queryKey,
          await runDraftTests(organizationId, draft.id, draft.revision),
        );
    } catch (failure) {
      setError(
        failure instanceof IdentityError && failure.status === 409
          ? 'Someone else changed these tests. Reload them before saving.'
          : workflowError(failure),
      );
    } finally {
      setPending(false);
    }
  }

  async function run(testCase: DraftTestCase, savedCase: boolean) {
    setPending(true);
    setError('');
    try {
      const started = await startDraftTest(organizationId, draft.id, {
        id: crypto.randomUUID(),
        revision: draft.revision,
        ...(savedCase ? { caseId: testCase.id } : { case: testCase }),
      });
      client.setQueryData(
        draftTestRunOptions(organizationId, draft.id, started.id).queryKey,
        started,
      );
      setRunId(started.id);
    } catch (failure) {
      setError(workflowError(failure));
    } finally {
      setPending(false);
    }
  }

  const data = summary.data;

  return (
    <div className="authoring-tests">
      <div className="authoring-section-heading">
        <div>
          <h2>Test with example data</h2>
          <p>
            Tests run the real workflow steps with your example replies. Nothing
            is sent to connected systems, and passing tests don’t activate or
            approve anything.
          </p>
        </div>
        {canManage ? (
          <Button
            variant="outline"
            disabled={!data || pending}
            onClick={() =>
              setEditing({
                id: crypto.randomUUID(),
                name: `Example ${(data?.cases.length ?? 0) + 1}`,
                inputs: {},
                evidence: {},
                replies: {},
                expected: null,
              })
            }
          >
            <Plus aria-hidden="true" /> New test
          </Button>
        ) : null}
      </div>
      {!saved ? (
        <Alert tone="neutral" role="status">
          Tests run on the saved draft. Wait until your changes are saved.
        </Alert>
      ) : null}
      {data?.blocked ? (
        <Alert tone="warning" role="status">
          {data.blocked}
        </Alert>
      ) : null}
      {error ? (
        <Alert tone="danger" role="alert">
          {error}
        </Alert>
      ) : null}
      {summary.error ? (
        <Alert tone="danger" role="alert">
          <span>{workflowError(summary.error)}</span>
          <Button variant="outline" onClick={() => void summary.refetch()}>
            Retry
          </Button>
        </Alert>
      ) : summary.isPending ? (
        <p role="status">Loading tests…</p>
      ) : !data?.cases.length && !editing ? (
        <p className="authoring-hint">
          No saved tests yet. Add one to check what the workflow does with
          example data.
        </p>
      ) : (
        <ul className="authoring-test-cases" aria-label="Saved tests">
          {data?.cases.map((testCase) => {
            const result = data.results.find(
              (item) => item.caseId === testCase.id,
            );

            return (
              <li key={testCase.id}>
                <div>
                  <strong>{testCase.name}</strong>
                  <span className="authoring-hint">
                    {testCase.expected
                      ? `Expects: ${outcomes[testCase.expected.outcome]}`
                      : 'Records what happens'}
                  </span>
                </div>
                {resultBadge(result, draft.revision)}
                <div className="authoring-test-actions">
                  {result?.runId ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setRunId(result.runId)}
                    >
                      Show result
                    </Button>
                  ) : null}
                  {canManage ? (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!saved || pending || !!data.blocked}
                        onClick={() => void run(testCase, true)}
                      >
                        <Play aria-hidden="true" /> Run
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditing(testCase)}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${testCase.name}`}
                        disabled={pending}
                        onClick={() =>
                          void persist(
                            data.cases.filter(
                              (item) => item.id !== testCase.id,
                            ),
                          )
                        }
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {editing && data ? (
        <TestCaseEditor
          key={editing.id}
          organizationId={organizationId}
          draft={draft}
          content={content}
          initial={editing}
          pending={pending}
          canRun={saved && !data.blocked}
          cancel={() => setEditing(null)}
          run={(testCase) => void run(testCase, false)}
          save={(testCase) =>
            void persist(
              data.cases.some((item) => item.id === testCase.id)
                ? data.cases.map((item) =>
                    item.id === testCase.id ? testCase : item,
                  )
                : [...data.cases, testCase],
            )
          }
        />
      ) : null}
      {runId ? (
        <TestRunView
          key={runId}
          organizationId={organizationId}
          draftId={draft.id}
          runId={runId}
          canManage={canManage}
        />
      ) : null}
    </div>
  );
}

function replyFor(
  step: WorkflowDraftContent['steps'][number],
  current: StepReply | undefined,
): StepReply | null {
  if (step.kind === 'read')
    return current?.kind === 'read' ? current : { kind: 'read', values: {} };
  if (step.kind === 'approval')
    return current?.kind === 'approval'
      ? current
      : { kind: 'approval', decision: 'approved' };
  if (step.kind === 'capability')
    return current?.kind === 'capability'
      ? current
      : { kind: 'capability', result: 'accepted' };
  if (step.kind === 'verification')
    return current?.kind === 'verification'
      ? current
      : { kind: 'verification', state: 'verified', values: {} };

  return null;
}

function Values({
  legend,
  fields,
  values,
  onChange,
}: {
  legend: string;
  fields: Record<string, FieldType>;
  values: Record<string, string | number | boolean | null>;
  onChange(values: Record<string, string | number | boolean | null>): void;
}) {
  const entries = Object.entries(fields);
  if (!entries.length) return null;

  return (
    <fieldset className="authoring-values">
      <legend>{legend}</legend>
      {entries.map(([name, type]) => (
        <label key={name} className="authoring-field">
          {humanize(name)}
          <ScalarInput
            aria-label={`${legend}: ${humanize(name)}`}
            type={type}
            value={
              values[name] ??
              (type === 'number'
                ? 0
                : type === 'boolean'
                  ? false
                  : type === 'null'
                    ? null
                    : '')
            }
            onChange={(value) => onChange({ ...values, [name]: value })}
          />
        </label>
      ))}
    </fieldset>
  );
}

/** Edits one test case: inputs, evidence and the reply each step receives. */
function TestCaseEditor({
  organizationId,
  draft,
  content,
  initial,
  pending,
  canRun,
  cancel,
  run,
  save,
}: {
  organizationId: string;
  draft: WorkflowDraft;
  content: WorkflowDraftContent;
  initial: DraftTestCase;
  pending: boolean;
  canRun: boolean;
  cancel(): void;
  run(testCase: DraftTestCase): void;
  save(testCase: DraftTestCase): void;
}) {
  const [testCase, setTestCase] = useState(initial);
  const examples = useQuery(
    draftTestExamplesOptions(organizationId, draft.id, draft.revision),
  );
  const prefill = (source: DraftTestCase) =>
    setTestCase({
      ...source,
      id: testCase.id,
      name: testCase.name,
      expected: testCase.expected,
    });

  return (
    <Card as="section" className="authoring-test-editor" aria-label="Edit test">
      <div className="authoring-settings-grid">
        <label className="authoring-field">
          Test name
          <Input
            value={testCase.name}
            maxLength={200}
            onChange={(event) =>
              setTestCase({ ...testCase, name: event.target.value })
            }
          />
        </label>
        <label className="authoring-field">
          Expected result
          <Select
            aria-label="Expected result"
            value={testCase.expected?.outcome ?? ''}
            onValueChange={(value) =>
              setTestCase({
                ...testCase,
                expected: value ? { outcome: value as TestOutcome } : null,
              })
            }
            options={[
              { value: '', label: 'Just show what happens' },
              ...Object.entries(outcomes).map(([value, label]) => ({
                value,
                label,
              })),
            ]}
          />
        </label>
        <label className="authoring-field">
          Fill in from
          <Select
            aria-label="Fill in from"
            value=""
            placeholder={
              examples.isPending ? 'Loading examples…' : 'Choose example data'
            }
            disabled={!examples.data}
            onValueChange={(value) => {
              const data = examples.data;
              if (!data || !value) return;
              if (value === 'fields') prefill(data.fields);
              const run = data.runs.find(
                (item) => `run:${item.runId}` === value,
              );
              if (run) prefill(run.case);
              const scenario = data.scenarios.find(
                (item) => `scenario:${item.id}` === value,
              );
              if (scenario) prefill(scenario.case);
            }}
            options={[
              { value: 'fields', label: 'Empty values for each field' },
              ...(examples.data?.runs ?? []).map((item) => ({
                value: `run:${item.runId}`,
                label: `Recent run · ${new Date(item.createdAt).toLocaleString()}`,
              })),
              ...(examples.data?.scenarios ?? []).map((item) => ({
                value: `scenario:${item.id}`,
                label: `Scenario · ${item.name}`,
              })),
            ]}
          />
        </label>
      </div>
      <Values
        legend="Inputs"
        fields={content.inputs as Record<string, FieldType>}
        values={testCase.inputs}
        onChange={(inputs) => setTestCase({ ...testCase, inputs })}
      />
      <Values
        legend="Evidence"
        fields={content.context.fields as Record<string, FieldType>}
        values={testCase.evidence}
        onChange={(evidence) => setTestCase({ ...testCase, evidence })}
      />
      <ol className="authoring-test-replies" aria-label="Example replies">
        {content.steps.map((step) => {
          const reply = replyFor(step, testCase.replies[step.id]);
          if (!reply) return null;
          const set = (next: StepReply) =>
            setTestCase({
              ...testCase,
              replies: { ...testCase.replies, [step.id]: next },
            });

          return (
            <li key={step.id}>
              <strong>{step.id}</strong>
              {reply.kind === 'read' && step.kind === 'read' ? (
                <Values
                  legend={`${step.id} reads`}
                  fields={step.fields as Record<string, FieldType>}
                  values={reply.values}
                  onChange={(values) => set({ kind: 'read', values })}
                />
              ) : reply.kind === 'approval' ? (
                <Select
                  aria-label={`${step.id} decision`}
                  value={reply.decision}
                  onValueChange={(value) =>
                    value &&
                    set({
                      kind: 'approval',
                      decision: value as typeof reply.decision,
                    })
                  }
                  options={[
                    { value: 'approved', label: 'Approved' },
                    { value: 'denied', label: 'Denied' },
                    { value: 'pending', label: 'Nobody has decided yet' },
                  ]}
                />
              ) : reply.kind === 'capability' ? (
                <Select
                  aria-label={`${step.id} outcome`}
                  value={reply.result}
                  onValueChange={(value) =>
                    value &&
                    set({
                      kind: 'capability',
                      result: value as typeof reply.result,
                    })
                  }
                  options={[
                    { value: 'accepted', label: 'Action accepted' },
                    {
                      value: 'approval_required',
                      label: 'Policy asks a person first',
                    },
                    { value: 'denied', label: 'Action denied' },
                  ]}
                />
              ) : reply.kind === 'verification' &&
                step.kind === 'verification' ? (
                <>
                  <Select
                    aria-label={`${step.id} result`}
                    value={reply.state}
                    onValueChange={(value) =>
                      value &&
                      set({ ...reply, state: value as typeof reply.state })
                    }
                    options={[
                      { value: 'verified', label: 'Confirmed' },
                      {
                        value: 'failed',
                        label: 'Differs from the expected result',
                      },
                      { value: 'inconclusive', label: 'Couldn’t be confirmed' },
                    ]}
                  />
                  <Values
                    legend={`${step.id} reads back`}
                    fields={step.fields as Record<string, FieldType>}
                    values={reply.values}
                    onChange={(values) => set({ ...reply, values })}
                  />
                </>
              ) : null}
            </li>
          );
        })}
      </ol>
      <div className="workflow-dialog-actions">
        <Button variant="outline" disabled={pending} onClick={cancel}>
          Cancel
        </Button>
        <Button
          variant="outline"
          disabled={pending || !canRun}
          onClick={() => run(testCase)}
        >
          <Play aria-hidden="true" /> Run without saving
        </Button>
        <Button
          disabled={pending || !testCase.name.trim()}
          onClick={() => save(testCase)}
        >
          Save test
        </Button>
      </div>
    </Card>
  );
}

/** Shows a test run step by step, including where it would wait for a person. */
export function TestRunView({
  organizationId,
  draftId,
  runId,
  canManage,
}: {
  organizationId: string;
  draftId: string;
  runId: string;
  canManage: boolean;
}) {
  const query = useQuery({
    ...draftTestRunOptions(organizationId, draftId, runId),
    refetchInterval: (current) =>
      current.state.data?.state === 'running' ? 500 : false,
  });
  const run: DraftTestRun | undefined = query.data;
  const result = run?.result;

  return (
    <Card
      as="section"
      className="authoring-test-run"
      aria-label="Test result"
      aria-live="polite"
    >
      <div className="authoring-section-heading">
        <h3>Test result</h3>
        {run?.state === 'running' && canManage ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void cancelDraftTest(organizationId, draftId, runId).then(() =>
                query.refetch(),
              )
            }
          >
            Cancel
          </Button>
        ) : null}
      </div>
      {query.error ? (
        <Alert tone="danger" role="alert">
          {workflowError(query.error)}
        </Alert>
      ) : !run || run.state === 'running' ? (
        <p role="status">Running the test…</p>
      ) : run.error ? (
        <Alert tone="warning" role="status">
          {run.error}
        </Alert>
      ) : result ? (
        <>
          <div className="authoring-counts">
            <Badge
              tone={
                result.passed === false
                  ? 'danger'
                  : result.passed
                    ? 'success'
                    : 'neutral'
              }
            >
              {result.passed === true
                ? 'Passed'
                : result.passed === false
                  ? 'Failed'
                  : 'Ran'}
            </Badge>
            <span>{outcomes[result.outcome]}</span>
            {result.reason ? (
              <span className="authoring-hint">
                ({humanize(result.reason)})
              </span>
            ) : null}
          </div>
          <ol className="authoring-test-steps" aria-label="Steps in this test">
            {result.steps.map((step, index) => (
              <li
                key={`${step.stepId}:${index}`}
                data-branch={step.branch ?? 'none'}
              >
                <div className="workflow-process-step-heading">
                  <strong>{step.title}</strong>
                  <span>{step.stepId}</span>
                  <span>{humanize(step.state)}</span>
                </div>
                <p>{step.note}</p>
                {Object.keys(step.inputs).length ||
                Object.keys(step.outputs).length ? (
                  <dl className="authoring-test-values">
                    {Object.entries(step.inputs).map(([name, value]) => (
                      <div key={`in:${name}`}>
                        <dt>Used {humanize(name)}</dt>
                        <dd>{JSON.stringify(value)}</dd>
                      </div>
                    ))}
                    {Object.entries(step.outputs).map(([name, value]) => (
                      <div key={`out:${name}`}>
                        <dt>Produced {humanize(name)}</dt>
                        <dd>{JSON.stringify(value)}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                {step.code ? (
                  <p className="authoring-hint">
                    Sandbox: {humanize(step.code.outcome)} in{' '}
                    {Math.round(step.code.wallTimeMs)} ms, {step.code.requests}{' '}
                    request(s).
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p>The test was cancelled.</p>
      )}
    </Card>
  );
}

/** Summarizes saved tests for the publish dialog and re-runs them on the saved revision. */
export function PublishTestSummary({
  organizationId,
  draft,
}: {
  organizationId: string;
  draft: WorkflowDraft;
}) {
  const client = useQueryClient();
  const options = draftTestsOptions(organizationId, draft.id);
  const summary = useQuery({
    ...options,
    refetchInterval: (query) =>
      query.state.data?.results.some((item) => item.state === 'running')
        ? 1000
        : false,
  });
  const started = useRef(false);

  useEffect(() => {
    if (started.current || !summary.data?.cases.length || summary.data.blocked)
      return;
    started.current = true;
    void runDraftTests(organizationId, draft.id, draft.revision)
      .then((next) => client.setQueryData(options.queryKey, next))
      .catch(() => undefined);
  }, [
    client,
    draft.id,
    draft.revision,
    options.queryKey,
    organizationId,
    summary.data,
  ]);

  const data = summary.data;
  if (!data?.cases.length)
    return <p className="authoring-hint">No saved tests for this draft.</p>;
  const failed = data.results.filter((item) => item.passed === false);
  const running = data.results.filter(
    (item) => item.state === 'running' || !item.state,
  );

  return (
    <Alert
      tone={failed.length ? 'warning' : running.length ? 'neutral' : 'success'}
      role="status"
    >
      {failed.length
        ? `${failed.length} of ${data.cases.length} saved tests fail on this revision: ${failed
            .map(
              (item) =>
                data.cases.find((testCase) => testCase.id === item.caseId)
                  ?.name,
            )
            .join(
              ', ',
            )}. Publishing is still possible; tests are evidence for you, not approval.`
        : running.length
          ? 'Running saved tests on this revision…'
          : `All ${data.cases.length} saved tests pass on this revision.`}
    </Alert>
  );
}
