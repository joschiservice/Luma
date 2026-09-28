import './code-steps.css';

import {
  type EvaluateCode,
  evaluateCodeSchema,
  type WorkflowVersionView,
} from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { Card, CardHeader } from '@luma/ui/components/primitives/card';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import {
  Field,
  FieldDescription,
  FieldLabel,
} from '@luma/ui/components/primitives/field';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@luma/ui/components/primitives/tabs';
import { Textarea } from '@luma/ui/components/primitives/textarea';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Braces, Check, Copy, Play, ShieldCheck, Square } from 'lucide-react';
import { useId, useState } from 'react';

import { IdentityError } from '../identity/data';
import {
  cancelCodeEvaluation,
  codeEvaluationOptions,
  CodeEvaluationRejected,
  evaluateCode,
} from './code-data';

type Step = NonNullable<
  Extract<WorkflowVersionView, { format: 'workflow/2' }>['codeSteps']
>[number];

const sample = (fields: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(fields).map(([name, type]) => [
      name,
      type === 'number'
        ? 0
        : type === 'boolean'
          ? false
          : type === 'null'
            ? null
            : '',
    ]),
  );
const print = (value: unknown) => JSON.stringify(value, null, 2);
const reasons: Record<string, string> = {
  code_error:
    'The code could not complete. Check the source and example inputs.',
  resource_limit: 'The step reached its execution limit.',
  invalid_output: 'The returned values do not match the declared outputs.',
  capability_denied:
    'A capability was not granted or its example reply is missing.',
  unavailable:
    'The code runtime is unavailable. Ask an administrator to check its configuration.',
  cancelled: 'Evaluation cancelled.',
};

/** Reviews immutable code and evaluates examples without calling connected systems. */
export function WorkflowCodeSteps({
  version,
  organizationId,
  definitionId,
  canManage,
  accessLost,
}: {
  version: WorkflowVersionView;
  organizationId: string;
  definitionId: string;
  canManage: boolean;
  accessLost: () => Promise<void>;
}) {
  if (version.format !== 'workflow/2' || !version.codeSteps?.length)
    return null;

  return (
    <div className="code-step-list">
      {version.codeSteps.map((step) => (
        <CodeStepPanel
          key={`${version.digest}:${step.id}`}
          {...{
            step,
            version,
            organizationId,
            definitionId,
            canManage,
            accessLost,
          }}
        />
      ))}
    </div>
  );
}

function CodeStepPanel({
  step,
  version,
  organizationId,
  definitionId,
  canManage,
  accessLost,
}: {
  step: Step;
  version: WorkflowVersionView;
  organizationId: string;
  definitionId: string;
  canManage: boolean;
  accessLost: () => Promise<void>;
}) {
  const id = useId();
  const client = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [input, setInput] = useState(() =>
    print({
      inputs: sample(version.inputs),
      evidence: sample(version.context.fields),
      steps: {},
    }),
  );
  const [expected, setExpected] = useState(() => print(sample(step.fields)));
  const [replies, setReplies] = useState(() =>
    print(Object.fromEntries(step.grants.map((grant) => [grant, {}]))),
  );
  const [request, setRequest] = useState<EvaluateCode | null>(null);
  const [evaluationId, setEvaluationId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const query = useQuery(
    codeEvaluationOptions(organizationId, definitionId, evaluationId),
  );
  const evaluation = query.data;
  const running = evaluation?.state === 'running';
  const locked = busy || running || (!!request && !evaluationId);
  const lost = query.error instanceof IdentityError;
  const output = evaluation?.result;

  async function handleError(error: unknown) {
    if (error instanceof IdentityError) {
      setRequest(null);
      setEvaluationId('');
      await accessLost();
    } else {
      if (error instanceof CodeEvaluationRejected) setRequest(null);
      setError(
        error instanceof Error
          ? error.message
          : 'The evaluation could not complete. Try again.',
      );
    }
  }

  async function start() {
    setError('');
    let body: EvaluateCode;
    try {
      body =
        request ??
        evaluateCodeSchema.parse({
          id: crypto.randomUUID(),
          version: version.version,
          reviewedDigest: version.digest,
          now: '2026-01-01T00:00:00.000Z',
          stepId: step.id,
          input: JSON.parse(input),
          expected: JSON.parse(expected),
          replies: JSON.parse(replies),
        });
    } catch {
      setError(
        'Enter valid JSON objects with scalar values for inputs, expected outputs and capability replies.',
      );

      return;
    }
    setRequest(body);
    setBusy(true);
    try {
      const result = await evaluateCode(organizationId, definitionId, body);
      client.setQueryData(
        codeEvaluationOptions(organizationId, definitionId, result.id).queryKey,
        result,
      );
      setEvaluationId(result.id);
    } catch (err) {
      await handleError(err);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!evaluationId) return;
    setBusy(true);
    setError('');
    try {
      const result = await cancelCodeEvaluation(
        organizationId,
        definitionId,
        evaluationId,
      );
      client.setQueryData(
        codeEvaluationOptions(organizationId, definitionId, evaluationId)
          .queryKey,
        result,
      );
    } catch (err) {
      await handleError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      as="section"
      className="code-step-panel"
      aria-labelledby={`${id}-title`}
    >
      <CardHeader className="code-step-heading">
        <div className="code-step-identity">
          <Braces size={19} aria-hidden="true" />
          <div>
            <h2 id={`${id}-title`}>{step.id.replaceAll('-', ' ')}</h2>
            <p>TypeScript · Version {version.version}</p>
          </div>
        </div>
        <Badge tone="neutral">
          <ShieldCheck size={12} aria-hidden="true" /> Sandboxed
        </Badge>
      </CardHeader>
      <dl className="code-step-limits">
        <div>
          <dt>Time limit</dt>
          <dd>{step.limits.wallTimeMs / 1000}s</dd>
        </div>
        <div>
          <dt>Guest memory</dt>
          <dd>{step.limits.memoryBytes / 1048576} MB</dd>
        </div>
        <div>
          <dt>Capability access</dt>
          <dd>
            {step.grants.length ? `${step.grants.length} granted` : 'None'}
          </dd>
        </div>
      </dl>
      <Tabs defaultValue="source" className="code-step-tabs">
        <TabsList variant="line" aria-label={`${step.id} views`}>
          <TabsTrigger value="source">Source & access</TabsTrigger>
          <TabsTrigger value="evaluate">Test example</TabsTrigger>
        </TabsList>
        <TabsContent value="source" className="code-step-content">
          <div className="code-source-toolbar">
            <span>main.ts</span>
            <Button
              variant="ghost"
              aria-label="Copy TypeScript source"
              onClick={() => {
                void navigator.clipboard
                  .writeText(step.source)
                  .then(() => setCopied(true))
                  .catch(() =>
                    setError('Copy failed. Select the source to copy it.'),
                  );
              }}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <pre
            className="code-step-source"
            tabIndex={0}
            aria-label="TypeScript source"
          >
            <code>{step.source}</code>
          </pre>
          <div className="code-step-contract">
            <div>
              <h3>Returns</h3>
              <dl>
                {Object.entries(step.fields).map(([name, type]) => (
                  <div key={name}>
                    <dt>{name}</dt>
                    <dd>{type}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <div>
              <h3>Allowed capabilities</h3>
              {step.grants.length ? (
                <ul>
                  {step.grants.map((grant) => (
                    <li key={grant}>
                      <code>{grant}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>This step only computes values from its inputs.</p>
              )}
            </div>
          </div>
          <Disclosure>
            <summary>Runtime and artifact</summary>
            <p>{step.runtime}</p>
            <p>Instruction budget: {step.limits.fuel.toLocaleString()}</p>
            <code className="code-step-digest">{step.artifactDigest}</code>
          </Disclosure>
        </TabsContent>
        <TabsContent value="evaluate" className="code-step-content">
          <p className="code-step-help">
            Try an example and compare the returned values with your expected
            result. Connected systems are never called.
          </p>
          {!canManage ? (
            <Alert>Only workspace owners and admins can run evaluations.</Alert>
          ) : lost ? (
            <Alert tone="danger">
              Access changed. Refresh the workflow to continue.
            </Alert>
          ) : (
            <>
              <div className="code-step-editor-grid">
                <Field>
                  <FieldLabel htmlFor={`${id}-input`}>
                    Example inputs
                  </FieldLabel>
                  <FieldDescription id={`${id}-input-help`}>
                    Inputs, evidence, and outputs from earlier steps.
                  </FieldDescription>
                  <Textarea
                    id={`${id}-input`}
                    aria-describedby={`${id}-input-help`}
                    rows={9}
                    spellCheck={false}
                    value={input}
                    disabled={locked || !!evaluationId}
                    onChange={(e) => setInput(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${id}-expected`}>
                    Expected outputs
                  </FieldLabel>
                  <FieldDescription>
                    Use the names and types declared in Returns.
                  </FieldDescription>
                  <Textarea
                    id={`${id}-expected`}
                    rows={9}
                    spellCheck={false}
                    value={expected}
                    disabled={locked || !!evaluationId}
                    onChange={(e) => setExpected(e.target.value)}
                  />
                </Field>
              </div>
              {step.grants.length ? (
                <Field>
                  <FieldLabel htmlFor={`${id}-replies`}>
                    Example capability replies
                  </FieldLabel>
                  <FieldDescription>
                    Provide one reply object for each capability the code
                    requests.
                  </FieldDescription>
                  <Textarea
                    id={`${id}-replies`}
                    rows={5}
                    spellCheck={false}
                    value={replies}
                    disabled={locked || !!evaluationId}
                    onChange={(e) => setReplies(e.target.value)}
                  />
                </Field>
              ) : null}
              <div className="code-step-actions">
                {running ? (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void cancel()}
                  >
                    <Square size={14} />
                    Cancel evaluation
                  </Button>
                ) : evaluationId ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setEvaluationId('');
                      setRequest(null);
                      setError('');
                    }}
                  >
                    Edit example
                  </Button>
                ) : (
                  <Button disabled={busy} onClick={() => void start()}>
                    <Play size={14} />
                    {busy
                      ? 'Starting…'
                      : request
                        ? 'Retry evaluation'
                        : 'Run evaluation'}
                  </Button>
                )}
                <span>Fixed version · No production writes</span>
              </div>
              {evaluation ? (
                <div
                  className="code-step-result"
                  role="status"
                  aria-live="polite"
                >
                  <div className="code-step-heading">
                    <strong>
                      {running
                        ? 'Evaluating example…'
                        : evaluation.state === 'passed'
                          ? 'Example passed'
                          : evaluation.state === 'cancelled'
                            ? 'Evaluation cancelled'
                            : 'Example did not pass'}
                    </strong>
                    {output ? (
                      <span>
                        {output.telemetry.wallTimeMs} ms ·{' '}
                        {output.telemetry.requests} requests
                      </span>
                    ) : null}
                  </div>
                  {running ? (
                    <p>The code runs within its published resource limits.</p>
                  ) : output?.telemetry.outcome === 'completed' ? (
                    <>
                      <p>
                        {evaluation.state === 'passed'
                          ? 'Returned values match the expected outputs.'
                          : 'Returned values differ from the expected outputs.'}
                      </p>
                      <pre aria-label="Returned values">
                        {print(output.values)}
                      </pre>
                    </>
                  ) : (
                    <p>
                      {output
                        ? reasons[output.telemetry.outcome]
                        : evaluation.state === 'failed'
                          ? 'The evaluator stopped before returning a result. Run the example again.'
                          : 'The evaluation has stopped.'}
                    </p>
                  )}
                </div>
              ) : null}
              {query.error && !lost ? (
                <Alert tone="danger">
                  Results are temporarily unavailable.{' '}
                  <Button variant="ghost" onClick={() => void query.refetch()}>
                    Retry results
                  </Button>
                </Alert>
              ) : null}
            </>
          )}
        </TabsContent>
      </Tabs>
      {error ? (
        <Alert tone="danger" role="alert">
          {error}
        </Alert>
      ) : null}
    </Card>
  );
}
