import type {
  AuthoringVocabulary,
  DraftValidation,
  WorkflowDraftContent,
} from '@luma/api-contract';
import { Card } from '@luma/ui/components/primitives/card';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { Textarea } from '@luma/ui/components/primitives/textarea';

import { diagnosticsAt, type FieldType } from './draft-model';
import { Field, FieldListEditor, ScalarInput } from './step-forms';

const triggerFields: Record<string, string> = {
  event: 'eventType',
  schedule: 'at',
  exception: 'issueType',
};

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
      <h2 id="authoring-settings-title">About this workflow</h2>
      <div className="authoring-settings-grid">
        <Field label="Name" diagnostics={at('definition.name')}>
          {(props) => (
            <Input
              {...props}
              disabled={readOnly}
              value={definition.name}
              onChange={(event) => setDefinition({ name: event.target.value })}
            />
          )}
        </Field>
        <Field label="Version" diagnostics={at('version')}>
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
        <Field label="What it’s for" diagnostics={at('definition.intent')}>
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
        <Field label="Category" diagnostics={at('definition.category')}>
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
          label="When it starts"
          diagnostics={at('applicability.trigger')}
          hint={triggerEntry?.executable ? triggerEntry.description : undefined}
        >
          {(props) => (
            <Select
              aria-label="When it starts"
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
                label: `${item.label}${item.executable ? '' : ' · can’t run here'}`,
              }))}
            />
          )}
        </Field>
        {trigger.kind in triggerFields ? (
          <Field
            label={
              trigger.kind === 'event'
                ? 'Event name'
                : trigger.kind === 'schedule'
                  ? 'Start time (UTC)'
                  : 'Issue type'
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
              label="Condition field"
              diagnostics={at('applicability.trigger.field')}
            >
              {() => (
                <Select
                  aria-label="Condition field"
                  disabled={readOnly}
                  value={trigger.field}
                  placeholder="Choose an evidence field"
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
              label="Starts when it is"
              diagnostics={at('applicability.trigger.equals')}
            >
              {(props) => (
                <ScalarInput
                  {...props}
                  aria-label="Starts when it is"
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
          label="What it acts on"
          hint="Each run is about one of these."
          diagnostics={at('applicability.subjectKind')}
        >
          {(props) => (
            <Select
              aria-label="What it acts on"
              {...(props['aria-describedby']
                ? { 'aria-describedby': props['aria-describedby'] }
                : {})}
              disabled={readOnly}
              value={content.applicability.subjectKind}
              placeholder="Choose a subject"
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
                        label: `${content.applicability.subjectKind} (unknown)`,
                      },
                    ]
                  : []),
              ]}
            />
          )}
        </Field>
      </div>
      <Disclosure variant="plain" className="authoring-advanced">
        <summary>Inputs, evidence and ID</summary>
        <div className="authoring-settings-grid">
          <FieldListEditor
            label="Inputs"
            fields={content.inputs as Record<string, FieldType>}
            disabled={readOnly}
            diagnostics={at('inputs')}
            onChange={(inputs) => onChange({ ...content, inputs })}
          />
          <FieldListEditor
            label="Evidence fields"
            fields={content.context.fields as Record<string, FieldType>}
            disabled={readOnly}
            diagnostics={at('context.fields')}
            onChange={(fields) =>
              onChange({ ...content, context: { ...content.context, fields } })
            }
          />
          <Field label="Evidence type" diagnostics={at('context.kind')}>
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
            label="Evidence must be newer than (seconds)"
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
            label="Workflow ID"
            hint="Used in links. It can’t change after the first version is published."
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
