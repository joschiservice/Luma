import type {
  FireWorkflow,
  WorkflowDetail,
  WorkflowVersionView,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
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
  manual: m.workflows_triggers_action_manual,
  schedule: m.workflows_triggers_action_schedule,
  event: m.workflows_triggers_action_event,
  condition: m.workflows_triggers_action_condition,
  exception: m.workflows_triggers_action_exception,
} satisfies Record<
  WorkflowVersionView['applicability']['trigger']['kind'],
  () => string
>;

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
          ? m.workflows_triggers_scheduled()
          : m.workflows_triggers_started(),
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
          <Zap size={16} aria-hidden="true" /> {m.workflows_triggers_title()}
        </h2>
        <Badge tone="neutral">
          {m.workflows_version_short({ version: version.version })}
        </Badge>
      </CardHeader>
      <div className="workflow-contract-flow">
        <div>
          <span className="workflow-contract-label">
            {m.workflows_triggers_when()}
          </span>
          <strong>{workflowTriggerLabel(trigger)}</strong>
          {trigger.kind === 'schedule' ? (
            <p>
              <Clock3 size={14} aria-hidden="true" />{' '}
              {rich(m.workflows_triggers_once, {
                date: <WorkspaceDate value={trigger.at} />,
              })}
            </p>
          ) : (
            <p>
              {external
                ? m.workflows_triggers_accepts({ kind: version.context.kind })
                : m.workflows_triggers_manual_help()}
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
            <ShieldCheck size={14} aria-hidden="true" />{' '}
            {m.workflows_triggers_before_change()}
          </span>
          <strong>{m.workflows_triggers_approval_separate()}</strong>
          <p>{m.workflows_triggers_approval_help()}</p>
        </div>
      </div>
      {legacy ? (
        <Alert tone="neutral">{m.workflows_triggers_automatic()}</Alert>
      ) : !detail.canManage ? (
        <Alert tone="neutral">{m.workflows_triggers_cannot_manage()}</Alert>
      ) : expired ? (
        <Alert tone="warning">{m.workflows_triggers_expired()}</Alert>
      ) : (
        <form
          className="workflow-activation workflow-trigger-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <fieldset disabled={pending || request !== null}>
            <legend>{m.workflows_triggers_record_legend()}</legend>
            <label>
              {m.workflows_triggers_record_id({
                kind: version.applicability.subjectKind,
              })}
              <Input
                required
                value={subject}
                maxLength={200}
                onChange={(event) => setSubject(event.target.value)}
                placeholder={m.workflows_triggers_record_placeholder({
                  kind: version.applicability.subjectKind,
                })}
              />
            </label>
            {external ? (
              <label>
                {m.workflows_triggers_source_id()}
                <Input
                  required
                  value={source}
                  maxLength={200}
                  onChange={(event) => setSource(event.target.value)}
                />
                <span>{m.workflows_triggers_source_help()}</span>
              </label>
            ) : null}
            {external ? (
              <label>
                {m.workflows_triggers_occurred_at()}
                <Input
                  required
                  type="datetime-local"
                  value={observedAt}
                  onChange={(event) => setObservedAt(event.target.value)}
                />
                <span>{m.workflows_triggers_occurred_help()}</span>
              </label>
            ) : null}
          </fieldset>
          {sections.map(([group, schema]) =>
            Object.keys(schema).length ? (
              <fieldset key={group} disabled={pending || request !== null}>
                <legend>
                  {group === 'inputs'
                    ? m.workflows_triggers_inputs_legend()
                    : m.workflows_triggers_data_legend()}
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
                          {
                            value: '',
                            label: m.workflows_triggers_choose_value(),
                          },
                          { value: 'true', label: m.workflows_triggers_true() },
                          {
                            value: 'false',
                            label: m.workflows_triggers_false(),
                          },
                        ]}
                      />
                    ) : type === 'null' ? (
                      <Input value={m.workflows_triggers_no_value()} disabled />
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
            <summary>{m.workflows_triggers_details()}</summary>
            <p>
              {m.workflows_triggers_details_body({
                subject: version.applicability.subjectKind,
                context: version.context.kind,
              })}
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
                {m.workflows_triggers_start_another()}
              </Button>
            ) : null}
            <Button type="submit" disabled={pending || !!success}>
              <Play size={14} aria-hidden="true" />{' '}
              {pending
                ? m.workflows_triggers_sending()
                : request && !success
                  ? m.workflows_triggers_retry()
                  : actions[trigger.kind]()}
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
        {pending
          ? m.workflows_triggers_canceling()
          : m.workflows_triggers_cancel_scheduled()}
      </Button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
