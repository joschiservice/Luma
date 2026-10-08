import './code-steps.css';

import {
  type EvaluateCode,
  evaluateCodeSchema,
  type WorkflowVersionView,
} from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
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
import { useCan } from '../identity/permissions';
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
const reasons: Record<string, () => string> = {
  code_error: m.workflows_code_reason_code_error,
  resource_limit: m.workflows_code_reason_resource_limit,
  invalid_output: m.workflows_code_reason_invalid_output,
  capability_denied: m.workflows_code_reason_capability_denied,
  unavailable: m.workflows_code_reason_unavailable,
  cancelled: m.workflows_code_reason_cancelled,
};

/** Reviews immutable code and evaluates examples without calling connected systems. */
export function WorkflowCodeSteps({
  version,
  organizationId,
  definitionId,
  accessLost,
}: {
  version: WorkflowVersionView;
  organizationId: string;
  definitionId: string;
  accessLost: () => Promise<void>;
}) {
  // Evaluations are draft authoring work, whatever controls the workflow itself.
  const canManage = useCan(organizationId, 'workflows.author');
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
        error instanceof Error ? error.message : m.workflows_code_test_failed(),
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
      setError(m.workflows_code_invalid_json());

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
            <p>
              {m.workflows_code_language_version({ version: version.version })}
            </p>
          </div>
        </div>
        <Badge tone="neutral">
          <ShieldCheck size={12} aria-hidden="true" />{' '}
          {m.workflows_code_isolated()}
        </Badge>
      </CardHeader>
      <dl className="code-step-limits">
        <div>
          <dt>{m.workflows_code_time_limit()}</dt>
          <dd>
            {m.workflows_code_seconds({
              seconds: formatNumber(step.limits.wallTimeMs / 1000),
            })}
          </dd>
        </div>
        <div>
          <dt>{m.workflows_code_memory_limit()}</dt>
          <dd>
            {m.workflows_code_megabytes({
              size: formatNumber(step.limits.memoryBytes / 1048576, {
                maximumFractionDigits: 1,
              }),
            })}
          </dd>
        </div>
        <div>
          <dt>{m.workflows_code_allowed_actions()}</dt>
          <dd>
            {step.grants.length
              ? m.workflows_code_actions_count({ count: step.grants.length })
              : m.common_none()}
          </dd>
        </div>
      </dl>
      <Tabs defaultValue="source" className="code-step-tabs">
        <TabsList
          variant="line"
          aria-label={m.workflows_code_tabs_label({ step: step.id })}
        >
          <TabsTrigger value="source">
            {m.workflows_code_tab_source()}
          </TabsTrigger>
          <TabsTrigger value="evaluate">
            {m.workflows_code_tab_test()}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="source" className="code-step-content">
          <div className="code-source-toolbar">
            <span>main.ts</span>
            <Button
              variant="ghost"
              aria-label={m.workflows_code_copy_label()}
              onClick={() => {
                void navigator.clipboard
                  .writeText(step.source)
                  .then(() => setCopied(true))
                  .catch(() => setError(m.workflows_code_copy_failed()));
              }}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? m.common_copied() : m.common_copy()}
            </Button>
          </div>
          <pre
            className="code-step-source"
            tabIndex={0}
            aria-label={m.workflows_code_source_label()}
          >
            <code>{step.source}</code>
          </pre>
          <div className="code-step-contract">
            <div>
              <h3>{m.workflows_code_returns()}</h3>
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
              <h3>{m.workflows_code_allowed_actions()}</h3>
              {step.grants.length ? (
                <ul>
                  {step.grants.map((grant) => (
                    <li key={grant}>
                      <code>{grant}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>{m.workflows_code_compute_only()}</p>
              )}
            </div>
          </div>
          <Disclosure>
            <summary>{m.workflows_code_runtime_details()}</summary>
            <p>{step.runtime}</p>
            <p>{m.workflows_code_fuel({ fuel: step.limits.fuel })}</p>
            <code className="code-step-digest">{step.artifactDigest}</code>
          </Disclosure>
        </TabsContent>
        <TabsContent value="evaluate" className="code-step-content">
          <p className="code-step-help">{m.workflows_code_test_help()}</p>
          {!canManage ? (
            <Alert>{m.workflows_code_cannot_test()}</Alert>
          ) : lost ? (
            <Alert tone="danger">{m.workflows_code_access_changed()}</Alert>
          ) : (
            <>
              <div className="code-step-editor-grid">
                <Field>
                  <FieldLabel htmlFor={`${id}-input`}>
                    {m.workflows_code_inputs()}
                  </FieldLabel>
                  <FieldDescription id={`${id}-input-help`}>
                    {m.workflows_code_inputs_help()}
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
                    {m.workflows_code_expected()}
                  </FieldLabel>
                  <FieldDescription>
                    {m.workflows_code_expected_help()}
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
                    {m.workflows_code_replies()}
                  </FieldLabel>
                  <FieldDescription>
                    {m.workflows_code_replies_help()}
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
                    {m.workflows_code_cancel_test()}
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
                    {m.workflows_code_edit_example()}
                  </Button>
                ) : (
                  <Button disabled={busy} onClick={() => void start()}>
                    <Play size={14} />
                    {busy
                      ? m.workflows_code_starting()
                      : request
                        ? m.workflows_code_retry_test()
                        : m.workflows_code_run_test()}
                  </Button>
                )}
                <span>{m.workflows_code_test_note()}</span>
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
                        ? m.workflows_code_testing()
                        : evaluation.state === 'passed'
                          ? m.workflows_code_passed()
                          : evaluation.state === 'cancelled'
                            ? m.workflows_code_canceled()
                            : m.workflows_code_not_passed()}
                    </strong>
                    {output ? (
                      <span>
                        {m.workflows_code_test_telemetry({
                          duration: formatNumber(output.telemetry.wallTimeMs),
                          requests: output.telemetry.requests,
                        })}
                      </span>
                    ) : null}
                  </div>
                  {running ? (
                    <p>{m.workflows_code_running_help()}</p>
                  ) : output?.telemetry.outcome === 'completed' ? (
                    <>
                      <p>
                        {evaluation.state === 'passed'
                          ? m.workflows_code_values_match()
                          : m.workflows_code_values_differ()}
                      </p>
                      <pre aria-label={m.workflows_code_returned_values()}>
                        {print(output.values)}
                      </pre>
                    </>
                  ) : (
                    <p>
                      {output
                        ? reasons[output.telemetry.outcome]?.()
                        : evaluation.state === 'failed'
                          ? m.workflows_code_stopped_early()
                          : m.workflows_code_stopped()}
                    </p>
                  )}
                </div>
              ) : null}
              {query.error && !lost ? (
                <Alert tone="danger">
                  {m.workflows_code_result_unavailable()}{' '}
                  <Button variant="ghost" onClick={() => void query.refetch()}>
                    {m.workflows_code_reload_result()}
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
