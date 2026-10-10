import type {
  AuthoringVocabulary,
  DraftValidation,
  WorkflowDiagnostic,
  WorkflowDraftContent,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Card } from '@luma/ui/components/primitives/card';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { Textarea } from '@luma/ui/components/primitives/textarea';
import { WorkspaceTimezone } from '@luma/ui/components/primitives/workspace-date';
import { workspaceDateValue, workspaceInstant } from '@luma/ui/lib/timezone';
import { useContext, useState } from 'react';

import { diagnosticsAt, type FieldType } from './draft-model';
import { Field, FieldListEditor, ScalarInput } from './step-forms';

const triggerFields: Record<string, string> = {
  event: 'eventType',
  exception: 'issueType',
};

/**
 * Edits a one-time start in workspace time and reports it as a UTC instant. A local time that
 * doesn't exist, such as one skipped by a clock change, is shown as a problem and not reported.
 */
function ScheduleField({
  at,
  diagnostics,
  readOnly,
  onChange,
}: {
  at: string;
  diagnostics: WorkflowDiagnostic[];
  readOnly: boolean;
  onChange(at: string): void;
}) {
  const timeZone = useContext(WorkspaceTimezone);
  const [rejected, setRejected] = useState<{ text: string; message: string }>();
  const stored = Number.isNaN(Date.parse(at))
    ? ''
    : workspaceDateValue(new Date(at), timeZone, true).slice(0, 16);
  const problem: WorkflowDiagnostic[] = rejected
    ? [
        {
          severity: 'error',
          code: 'schedule_time',
          stepIndex: null,
          stepId: null,
          field: 'applicability.trigger.at',
          message: rejected.message,
          detail: '',
        },
      ]
    : [];

  return (
    <Field
      label={m.authoring_settings_schedule()}
      hint={m.authoring_settings_schedule_hint({ timeZone })}
      diagnostics={[...problem, ...diagnostics]}
    >
      {(props) => (
        <Input
          {...props}
          type="datetime-local"
          disabled={readOnly}
          value={rejected?.text ?? stored}
          onChange={(event) => {
            const text = event.target.value;
            if (!text) {
              setRejected(undefined);
              onChange('');

              return;
            }
            try {
              onChange(workspaceInstant(text, timeZone));
              setRejected(undefined);
            } catch (error) {
              setRejected({
                text,
                message:
                  error instanceof Error
                    ? error.message
                    : m.ui_time_error_invalid(),
              });
            }
          }}
        />
      )}
    </Field>
  );
}

/** Edits name, trigger, subject, inputs and evidence for the whole workflow. */
export function WorkflowSettings({
  content,
  validation,
  vocabulary,
  readOnly,
  onChange,
}: {
  content: WorkflowDraftContent;
  validation: DraftValidation | undefined;
  vocabulary: AuthoringVocabulary;
  readOnly: boolean;
  onChange(next: WorkflowDraftContent): void;
}) {
  const at = (field: string) => diagnosticsAt(validation, null, field);
  const trigger = content.applicability.trigger;
  const definition = content.definition;
  const setDefinition = (patch: Partial<typeof definition>) =>
    onChange({ ...content, definition: { ...definition, ...patch } });
  const triggerEntry = vocabulary.triggers.find(
    (item) => item.kind === trigger.kind,
  );
  const conditionType =
    trigger.kind === 'condition'
      ? (content.context.fields[trigger.field] as FieldType | undefined)
      : undefined;

  return (
    <Card
      as="section"
      className="authoring-settings"
      aria-labelledby="authoring-settings-title"
    >
      <h2 id="authoring-settings-title">{m.authoring_settings_title()}</h2>
      <div className="authoring-settings-grid">
        <Field
          label={m.authoring_settings_name()}
          diagnostics={at('definition.name')}
        >
          {(props) => (
            <Input
              {...props}
              disabled={readOnly}
              value={definition.name}
              onChange={(event) => setDefinition({ name: event.target.value })}
            />
          )}
        </Field>
        <Field
          label={m.authoring_settings_version()}
          diagnostics={at('version')}
        >
          {(props) => (
            <Input
              {...props}
              disabled={readOnly}
              value={content.version}
              onChange={(event) =>
                onChange({ ...content, version: event.target.value })
              }
            />
          )}
        </Field>
        <Field
          label={m.authoring_settings_intent()}
          diagnostics={at('definition.intent')}
        >
          {(props) => (
            <Textarea
              {...props}
              rows={2}
              disabled={readOnly}
              value={definition.intent}
              onChange={(event) =>
                setDefinition({ intent: event.target.value })
              }
            />
          )}
        </Field>
        <Field
          label={m.authoring_settings_category()}
          diagnostics={at('definition.category')}
        >
          {(props) => (
            <Input
              {...props}
              disabled={readOnly}
              value={definition.category}
              onChange={(event) =>
                setDefinition({ category: event.target.value })
              }
            />
          )}
        </Field>
        <Field
          label={m.authoring_settings_trigger()}
          diagnostics={at('applicability.trigger')}
          hint={triggerEntry?.executable ? triggerEntry.description : undefined}
        >
          {(props) => (
            <Select
              aria-label={m.authoring_settings_trigger()}
              {...(props['aria-describedby']
                ? { 'aria-describedby': props['aria-describedby'] }
                : {})}
              disabled={readOnly}
              value={trigger.kind}
              onValueChange={(next) => {
                if (!next || next === trigger.kind) return;
                const kind = next as typeof trigger.kind;
                const replacement =
                  kind === 'manual'
                    ? { kind }
                    : kind === 'condition'
                      ? {
                          kind,
                          field: Object.keys(content.context.fields)[0] ?? '',
                          equals: true,
                        }
                      : kind === 'schedule'
                        ? {
                            kind,
                            at: new Date(Date.now() + 86_400_000).toISOString(),
                          }
                        : kind === 'event'
                          ? { kind, eventType: '' }
                          : { kind, issueType: '' };
                onChange({
                  ...content,
                  applicability: {
                    ...content.applicability,
                    trigger: replacement as typeof trigger,
                  },
                });
              }}
              options={vocabulary.triggers.map((item) => ({
                value: item.kind,
                label: item.executable
                  ? item.label
                  : m.authoring_option_limited({ option: item.label }),
              }))}
            />
          )}
        </Field>
        {trigger.kind === 'schedule' ? (
          <ScheduleField
            at={trigger.at}
            diagnostics={at('applicability.trigger.at')}
            readOnly={readOnly}
            onChange={(next) =>
              onChange({
                ...content,
                applicability: {
                  ...content.applicability,
                  trigger: { ...trigger, at: next },
                },
              })
            }
          />
        ) : null}
        {trigger.kind in triggerFields ? (
          <Field
            label={
              trigger.kind === 'event'
                ? m.authoring_settings_event()
                : m.authoring_settings_issue_type()
            }
            diagnostics={at(
              `applicability.trigger.${triggerFields[trigger.kind]}`,
            )}
          >
            {(props) => (
              <Input
                {...props}
                disabled={readOnly}
                value={String(
                  (trigger as Record<string, unknown>)[
                    triggerFields[trigger.kind]!
                  ] ?? '',
                )}
                onChange={(event) =>
                  onChange({
                    ...content,
                    applicability: {
                      ...content.applicability,
                      trigger: {
                        ...trigger,
                        [triggerFields[trigger.kind]!]: event.target.value,
                      } as typeof trigger,
                    },
                  })
                }
              />
            )}
          </Field>
        ) : null}
        {trigger.kind === 'condition' ? (
          <>
            <Field
              label={m.authoring_settings_condition_field()}
              diagnostics={at('applicability.trigger.field')}
            >
              {() => (
                <Select
                  aria-label={m.authoring_settings_condition_field()}
                  disabled={readOnly}
                  value={trigger.field}
                  placeholder={m.authoring_settings_condition_placeholder()}
                  onValueChange={(next) =>
                    next &&
                    onChange({
                      ...content,
                      applicability: {
                        ...content.applicability,
                        trigger: { ...trigger, field: next },
                      },
                    })
                  }
                  options={Object.keys(content.context.fields).map((name) => ({
                    value: name,
                    label: name,
                  }))}
                />
              )}
            </Field>
            <Field
              label={m.authoring_settings_condition_equals()}
              diagnostics={at('applicability.trigger.equals')}
            >
              {(props) => (
                <ScalarInput
                  {...props}
                  aria-label={m.authoring_settings_condition_equals()}
                  disabled={readOnly}
                  type={conditionType ?? 'boolean'}
                  value={trigger.equals}
                  onChange={(equals) =>
                    onChange({
                      ...content,
                      applicability: {
                        ...content.applicability,
                        trigger: { ...trigger, equals },
                      },
                    })
                  }
                />
              )}
            </Field>
          </>
        ) : null}
        <Field
          label={m.authoring_settings_subject()}
          hint={m.authoring_settings_subject_hint()}
          diagnostics={at('applicability.subjectKind')}
        >
          {(props) => (
            <Select
              aria-label={m.authoring_settings_subject()}
              {...(props['aria-describedby']
                ? { 'aria-describedby': props['aria-describedby'] }
                : {})}
              disabled={readOnly}
              value={content.applicability.subjectKind}
              placeholder={m.authoring_settings_subject_placeholder()}
              onValueChange={(next) =>
                next &&
                onChange({
                  ...content,
                  applicability: {
                    ...content.applicability,
                    subjectKind: next,
                  },
                })
              }
              options={[
                ...vocabulary.subjects.map((item) => ({
                  value: item.kind,
                  label: item.label,
                })),
                ...(content.applicability.subjectKind &&
                !vocabulary.subjects.some(
                  (item) => item.kind === content.applicability.subjectKind,
                )
                  ? [
                      {
                        value: content.applicability.subjectKind,
                        label: m.authoring_settings_subject_unknown({
                          subject: content.applicability.subjectKind,
                        }),
                      },
                    ]
                  : []),
              ]}
            />
          )}
        </Field>
      </div>
      <Disclosure variant="plain" className="authoring-advanced">
        <summary>{m.authoring_settings_advanced()}</summary>
        <div className="authoring-settings-grid">
          <FieldListEditor
            label={m.authoring_settings_inputs()}
            fields={content.inputs as Record<string, FieldType>}
            disabled={readOnly}
            diagnostics={at('inputs')}
            onChange={(inputs) => onChange({ ...content, inputs })}
          />
          <FieldListEditor
            label={m.authoring_settings_evidence_fields()}
            fields={content.context.fields as Record<string, FieldType>}
            disabled={readOnly}
            diagnostics={at('context.fields')}
            onChange={(fields) =>
              onChange({ ...content, context: { ...content.context, fields } })
            }
          />
          <Field
            label={m.authoring_settings_evidence_type()}
            diagnostics={at('context.kind')}
          >
            {(props) => (
              <Input
                {...props}
                disabled={readOnly}
                value={content.context.kind}
                onChange={(event) =>
                  onChange({
                    ...content,
                    context: { ...content.context, kind: event.target.value },
                  })
                }
              />
            )}
          </Field>
          <Field
            label={m.authoring_settings_evidence_age()}
            diagnostics={at('context.maxAgeSeconds')}
          >
            {(props) => (
              <Input
                {...props}
                type="number"
                min="1"
                max="300"
                disabled={readOnly}
                value={content.context.maxAgeSeconds}
                onChange={(event) =>
                  onChange({
                    ...content,
                    context: {
                      ...content.context,
                      maxAgeSeconds: Number(event.target.value || 1),
                    },
                  })
                }
              />
            )}
          </Field>
          <Field
            label={m.authoring_settings_id()}
            hint={m.authoring_settings_id_hint()}
            diagnostics={at('definition.id')}
          >
            {(props) => (
              <Input
                {...props}
                disabled={readOnly}
                value={definition.id}
                onChange={(event) => setDefinition({ id: event.target.value })}
              />
            )}
          </Field>
        </div>
      </Disclosure>
    </Card>
  );
}
