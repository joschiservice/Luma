import type {
  FireWorkflow,
  WorkflowDetail,
  WorkflowVersionView,
} from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { Card, CardHeader } from '@luma/ui/components/primitives/card';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { ArrowRight, Clock3, Play, ShieldCheck, Zap } from 'lucide-react';
import { useState } from 'react';

import { IdentityError } from '../identity/data';
import { cancelWorkflowStart, fireWorkflow, workflowError } from './data';
import { workflowTriggerLabel } from './presentation';

const actions = {
  manual: 'Start workflow',
  schedule: 'Schedule start',
  event: 'Submit event',
  condition: 'Evaluate condition',
  exception: 'Submit detection',
};

/** Reviews versioned trigger requirements and starts a scoped run with retry-safe evidence. */
export function WorkflowTriggers({
  detail,
  version,
  organizationId,
  refresh,
  accessLost,
}: {
  detail: WorkflowDetail;
  version: WorkflowVersionView;
  organizationId: string;
  refresh: () => Promise<void>;
  accessLost: () => Promise<void>;
}) {
  const trigger = version.applicability.trigger;
  const [subject, setSubject] = useState('');
  const [source, setSource] = useState('');
  const [observedAt, setObservedAt] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [request, setRequest] = useState<FireWorkflow | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const external = ['event', 'condition', 'exception'].includes(trigger.kind);
  const legacy = version.format === 'resolution-playbook/0';
  const [openedAt] = useState(() => Date.now());
  const expired =
    trigger.kind === 'schedule' && Date.parse(trigger.at) <= openedAt;
  const sections = [
    ['inputs', version.inputs],
    ['facts', version.context.fields],
  ] as const;
  const fields = (group: string, types: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(types).map(([name, type]) => {
        const value = values[`${group}.${name}`] ?? '';

        return [
          name,
          type === 'null'
            ? null
            : type === 'number'
              ? Number(value)
              : type === 'boolean'
                ? value === 'true'
                : value,
        ];
      }),
    );

  async function submit() {
    if (pending) return;
    const now = new Date().toISOString();
    const observationTime = external ? new Date(observedAt).toISOString() : now;
    const sourceId = external ? source.trim() : crypto.randomUUID();
    const body: FireWorkflow = request ?? {
      version: version.version,
      reviewedDigest: version.digest,
      subject: { kind: version.applicability.subjectKind, id: subject.trim() },
      signal: { kind: trigger.kind, sourceId, occurredAt: observationTime },
      context: {
        inputs: fields('inputs', version.inputs),
        evidence: {
          kind: version.context.kind,
          facts: fields('facts', version.context.fields),
          observations: [
            {
              id: crypto.randomUUID(),
              observedAt: observationTime,
              source: external ? source.trim() : 'manual-entry',
            },
          ],
        },
        provenance: { reference: sourceId, capturedAt: now },
      },
    };
    setRequest(body);
    setPending(true);
    setError('');
    setSuccess('');
    try {
      const run = await fireWorkflow(organizationId, detail.summary.id, body);
      setSuccess(
        run.triggerState === 'scheduled'
          ? 'Start scheduled. You can cancel it from Recent runs.'
          : 'Run started. Review its evidence and admission status in Recent runs.',
      );
      await refresh();
    } catch (error) {
      setError(workflowError(error));
      if (
        error instanceof IdentityError &&
        [400, 403, 404, 409].includes(error.status)
      )
        setRequest(null);
      if (error instanceof IdentityError && [401, 403].includes(error.status))
        await accessLost();
    } finally {
      setPending(false);
    }
  }

  return (
    <Card
      as="section"
      className="workflow-section"
      aria-labelledby="trigger-title"
    >
      <CardHeader className="workflows-heading">
        <h2 id="trigger-title">
          <Zap size={16} aria-hidden="true" /> Trigger
        </h2>
        <Badge tone="neutral">v{version.version}</Badge>
      </CardHeader>
      <div className="workflow-contract-flow">
        <div>
          <span className="workflow-contract-label">When</span>
          <strong>{workflowTriggerLabel(trigger)}</strong>
          {trigger.kind === 'schedule' ? (
            <p>
              <Clock3 size={14} aria-hidden="true" />{' '}
              <WorkspaceDate value={trigger.at} /> · Once
            </p>
          ) : (
            <p>
              {external
                ? `Accepts ${version.context.kind} evidence.`
                : 'An owner or administrator starts this workflow.'}
            </p>
          )}
        </div>
        <ArrowRight
          className="workflow-contract-arrow"
          size={18}
          aria-hidden="true"
        />
        <div>
          <span className="workflow-contract-label">
            <ShieldCheck size={14} aria-hidden="true" /> Before any action
          </span>
          <strong>Execution permission is checked separately</strong>
          <p>
            A trigger records intent and evidence. It does not approve a change.
          </p>
        </div>
      </div>
      {legacy ? (
        <Alert tone="neutral">
          Issue detection starts this workflow automatically through Resolution.
          Review its runs for the recorded trigger and evidence.
        </Alert>
      ) : !detail.canManage ? (
        <Alert tone="neutral">
          Only workspace owners and admins can submit triggers.
        </Alert>
      ) : expired ? (
        <Alert tone="warning">
          This scheduled time has passed. Publish a new version to schedule
          another start.
        </Alert>
      ) : (
        <form
          className="workflow-activation workflow-trigger-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <fieldset disabled={pending || request !== null}>
            <legend>Resource scope</legend>
            <label>
              {version.applicability.subjectKind} ID
              <Input
                required
                value={subject}
                maxLength={200}
                onChange={(event) => setSubject(event.target.value)}
                placeholder={`Enter the ${version.applicability.subjectKind} ID`}
              />
            </label>
            {external ? (
              <label>
                Source event or observation ID
                <Input
                  required
                  value={source}
                  maxLength={200}
                  onChange={(event) => setSource(event.target.value)}
                />
                <span>
                  Use the original source ID. Repeated delivery starts only one
                  run.
                </span>
              </label>
            ) : null}
            {external ? (
              <label>
                Observed at
                <Input
                  required
                  type="datetime-local"
                  value={observedAt}
                  onChange={(event) => setObservedAt(event.target.value)}
                />
                <span>Enter the observation time in your local timezone.</span>
              </label>
            ) : null}
          </fieldset>
          {sections.map(([group, schema]) =>
            Object.keys(schema).length ? (
              <fieldset key={group} disabled={pending || request !== null}>
                <legend>
                  {group === 'inputs' ? 'Workflow inputs' : 'Observed context'}
                </legend>
                {Object.entries(schema).map(([name, type]) => (
                  <label key={name}>
                    {name
                      .replace(/([a-z])([A-Z])/g, '$1 $2')
                      .replaceAll('_', ' ')}{' '}
                    <span className="text-muted-foreground">· {type}</span>
                    {type === 'boolean' ? (
                      <Select
                        required
                        aria-label={name}
                        value={values[`${group}.${name}`] ?? ''}
                        onValueChange={(value) =>
                          setValues((previous) => ({
                            ...previous,
                            [`${group}.${name}`]: value ?? '',
                          }))
                        }
                        options={[
                          { value: '', label: 'Select a value' },
                          { value: 'true', label: 'True' },
                          { value: 'false', label: 'False' },
                        ]}
                      />
                    ) : type === 'null' ? (
                      <Input value="No value" disabled />
                    ) : (
                      <Input
                        required
                        aria-label={name}
                        type={type === 'number' ? 'number' : 'text'}
                        step={type === 'number' ? 'any' : undefined}
                        maxLength={2000}
                        value={values[`${group}.${name}`] ?? ''}
                        onChange={(event) =>
                          setValues((previous) => ({
                            ...previous,
                            [`${group}.${name}`]: event.target.value,
                          }))
                        }
                      />
                    )}
                  </label>
                ))}
              </fieldset>
            ) : null,
          )}
          <Disclosure>
            <summary>Version and evidence binding</summary>
            <p>
              Resource: {version.applicability.subjectKind}. Context:{' '}
              {version.context.kind}. Evidence is stored with this exact
              version.
            </p>
            <code>{version.digest}</code>
          </Disclosure>
          {error ? (
            <Alert tone="danger" role="alert">
              {error}
            </Alert>
          ) : null}
          {success ? (
            <Alert tone="success" role="status">
              {success}
            </Alert>
          ) : null}
          <div className="workflow-dialog-actions">
            {success ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setRequest(null);
                  setSuccess('');
                  setSubject('');
                  setSource('');
                  setObservedAt('');
                  setValues({});
                }}
              >
                Start another run
              </Button>
            ) : null}
            <Button type="submit" disabled={pending || !!success}>
              <Play size={14} aria-hidden="true" />{' '}
              {pending
                ? 'Confirming…'
                : request && !success
                  ? 'Retry same request'
                  : actions[trigger.kind]}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

/** Cancels a pending schedule and refreshes history; uncertain results can be retried safely. */
export function CancelScheduledStart({
  organizationId,
  definitionId,
  runId,
  refresh,
}: {
  organizationId: string;
  definitionId: string;
  runId: string;
  refresh: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  return (
    <div>
      <Button
        variant="outline"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError('');
          try {
            await cancelWorkflowStart(organizationId, definitionId, runId);
            await refresh();
          } catch (error) {
            setError(workflowError(error));
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? 'Cancelling…' : 'Cancel scheduled start'}
      </Button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
