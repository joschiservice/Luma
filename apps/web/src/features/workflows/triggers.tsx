import type {
  FireWorkflow,
  WorkflowDetail,
  WorkflowTrigger,
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
import {
  WorkspaceDate,
  WorkspaceTimezone,
} from '@luma/ui/components/primitives/workspace-date';
import { workspaceInstant } from '@luma/ui/lib/timezone';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowRight, Clock3, Play, ShieldCheck, Zap } from 'lucide-react';
import { useContext, useState } from 'react';

import { ApiError } from '../../kit/identity/data';
import { ConfirmAction } from '../../kit/layout/confirm-action';
import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { vocabularyOptions } from './authoring/data';
import { cancelWorkflowStart, fireWorkflow, workflowError } from './data';
import { workflowTriggerLabel } from './presentation';
import { WorkflowSubjectPicker } from './subject-picker';

const api = createWebApiClient();

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
  const timeZone = useContext(WorkspaceTimezone);
  const vocabulary = useQuery(vocabularyOptions(organizationId));
  const params = { organizationId, definitionId: detail.summary.id };
  const subscriptions = useQuery({
    ...privateQueryDefaults,
    queryKey: [
      'private',
      organizationId,
      'workflow-subscriptions',
      detail.summary.id,
    ],
    queryFn: ({ signal }) =>
      api.workflows.subscriptions({ params }, { signal }),
    enabled:
      version.format === 'workflow/2' &&
      version.applicability.trigger.kind !== 'exception',
  });
  const [subscriptionId, setSubscriptionId] = useState('');
  const selectedSubscription = subscriptions.data?.find(
    (item) =>
      item.id === subscriptionId &&
      item.active &&
      item.versionDigest === version.digest,
  );
  const trigger =
    selectedSubscription?.trigger ?? version.applicability.trigger;
  const [subscriptionKind, setSubscriptionKind] = useState<
    'manual' | 'event' | 'condition'
  >('manual');
  const [eventType, setEventType] = useState(version.context.kind);
  const [conditionField, setConditionField] = useState(
    Object.keys(version.context.fields)[0] ?? '',
  );
  const [conditionValue, setConditionValue] = useState('');

  function subscriptionTrigger(): WorkflowTrigger {
    if (subscriptionKind === 'manual') return { kind: 'manual' };
    if (subscriptionKind === 'event') return { kind: 'event', eventType };
    const type = version.context.fields[conditionField];
    const equals =
      type === 'null'
        ? null
        : type === 'boolean'
          ? conditionValue === 'true'
          : type === 'number'
            ? Number(conditionValue)
            : conditionValue;
    if (
      (type === 'boolean' && !['true', 'false'].includes(conditionValue)) ||
      (type === 'number' &&
        (!conditionValue.trim() || !Number.isFinite(equals)))
    )
      throw new Error(m.authoring_coordination_invalid_condition());

    return { kind: 'condition', field: conditionField, equals };
  }

  const [scheduleId] = useState(() => crypto.randomUUID());
  const configure = useMutation({
    mutationFn: () =>
      api.workflows.configureSubscription({
        params,
        body: {
          id: selectedSubscription?.id ?? scheduleId,
          revision: selectedSubscription?.revision ?? 0,
          version: version.version,
          reviewedDigest: version.digest,
          trigger: subscriptionTrigger(),
          active: true,
        },
      }),
    onSuccess: async (value) => {
      await subscriptions.refetch();
      setSubscriptionId(value.id);
    },
  });
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
    let observationTime = now;
    if (external && !request) {
      try {
        observationTime = workspaceInstant(observedAt, timeZone);
      } catch (error) {
        setError(
          error instanceof Error ? error.message : m.ui_time_error_invalid(),
        );

        return;
      }
    }
    const sourceId = external ? source.trim() : crypto.randomUUID();
    const body: FireWorkflow = request ?? {
      ...(selectedSubscription
        ? {
            subscription: {
              id: selectedSubscription.id,
              revision: selectedSubscription.revision,
            },
          }
        : {}),
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
        error instanceof ApiError &&
        [400, 403, 404, 409].includes(error.status)
      )
        setRequest(null);
      if (error instanceof ApiError && [401, 403].includes(error.status))
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
      {version.format === 'workflow/2' &&
      version.applicability.trigger.kind !== 'exception' ? (
        <Disclosure>
          <summary>{m.authoring_coordination_subscriptions()}</summary>
          <Select
            aria-label={m.authoring_coordination_subscriptions()}
            value={subscriptionId}
            options={[
              {
                value: '',
                label: m.authoring_coordination_subscription_default(),
              },
              ...(subscriptions.data ?? [])
                .filter(
                  (item) =>
                    item.active && item.versionDigest === version.digest,
                )
                .map((item) => ({
                  value: item.id,
                  label: `${workflowTriggerLabel(item.trigger)} · ${item.revision}`,
                })),
            ]}
            onValueChange={(id) => {
              setSubscriptionId(id ?? '');
              setRequest(null);
            }}
          />
          {subscriptions.isError ? (
            <p role="alert">{m.authoring_coordination_unavailable()}</p>
          ) : null}
          {detail.canManage ? (
            <div>
              <label htmlFor="workflow-subscription-kind">
                {m.authoring_coordination_subscription_kind()}
              </label>
              <Select
                id="workflow-subscription-kind"
                value={subscriptionKind}
                options={['manual', 'event', 'condition'].map((kind) => ({
                  value: kind,
                  label: actions[kind as keyof typeof actions](),
                }))}
                onValueChange={(value) => {
                  if (
                    value === 'manual' ||
                    value === 'event' ||
                    value === 'condition'
                  )
                    setSubscriptionKind(value);
                }}
                disabled={configure.isPending}
              />
              {subscriptionKind === 'event' ? (
                <>
                  <label htmlFor="workflow-subscription-event">
                    {m.authoring_coordination_event_type()}
                  </label>
                  <Select
                    id="workflow-subscription-event"
                    aria-label={m.authoring_coordination_event_type()}
                    value={eventType}
                    options={
                      vocabulary.data?.triggers.find(
                        (entry) => entry.kind === 'event',
                      )?.options ?? []
                    }
                    onValueChange={(value) => setEventType(value ?? '')}
                    disabled={configure.isPending}
                  />
                </>
              ) : null}
              {subscriptionKind === 'condition' ? (
                <>
                  <label htmlFor="workflow-subscription-field">
                    {m.authoring_coordination_condition_field()}
                  </label>
                  <Select
                    id="workflow-subscription-field"
                    value={conditionField}
                    options={Object.entries(version.context.fields).map(
                      ([value, type]) => ({
                        value,
                        label: `${value} (${type})`,
                      }),
                    )}
                    onValueChange={(value) => setConditionField(value ?? '')}
                    disabled={configure.isPending}
                  />
                  <label htmlFor="workflow-subscription-value">
                    {m.authoring_coordination_condition_value()}
                  </label>
                  <Input
                    id="workflow-subscription-value"
                    value={conditionValue}
                    onChange={(event) => setConditionValue(event.target.value)}
                    disabled={configure.isPending}
                  />
                </>
              ) : null}
              <Button
                type="button"
                onClick={() => configure.mutate()}
                disabled={
                  configure.isPending ||
                  (subscriptionKind === 'event' && !eventType.trim()) ||
                  (subscriptionKind === 'condition' && !conditionField)
                }
              >
                {m.authoring_coordination_subscription_save()}
              </Button>
              {configure.isError ? (
                <p role="alert">{configure.error.message}</p>
              ) : null}
              {configure.isSuccess ? (
                <p role="status">
                  {m.authoring_coordination_subscription_saved()}
                </p>
              ) : null}
            </div>
          ) : null}
        </Disclosure>
      ) : null}
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
      ) : trigger.kind === 'schedule' ? (
        <Alert tone="warning">{m.workflows_schedule_unavailable()}</Alert>
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
            <div className="workflow-subject-field">
              <span>{m.workflows_record_select()}</span>
              <WorkflowSubjectPicker
                key={version.applicability.subjectKind}
                organizationId={organizationId}
                kind={version.applicability.subjectKind}
                value={subject}
                onChange={setSubject}
              />
            </div>
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
                <span>{m.workflows_triggers_occurred_help({ timeZone })}</span>
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
            <Button type="submit" disabled={pending || !!success || !subject}>
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

/**
 * Cancels a pending schedule after confirmation and refreshes history; uncertain results can be
 * retried safely.
 */
export function CancelScheduledStart({
  organizationId,
  definitionId,
  runId,
  refresh,
  coordination = false,
}: {
  organizationId: string;
  definitionId: string;
  runId: string;
  refresh: () => Promise<void>;
  coordination?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const cancel = async () => {
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
  };

  return (
    <div>
      <ConfirmAction
        variant="outline"
        disabled={pending}
        prompt={m.workflows_triggers_cancel_prompt()}
        confirmLabel={m.workflows_triggers_cancel_confirm()}
        dismissLabel={m.workflows_triggers_cancel_keep()}
        onConfirm={() => void cancel()}
      >
        {pending
          ? m.workflows_triggers_canceling()
          : coordination
            ? m.common_cancel()
            : m.workflows_triggers_cancel_scheduled()}
      </ConfirmAction>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
