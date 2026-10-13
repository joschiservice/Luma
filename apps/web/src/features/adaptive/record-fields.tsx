import './adaptive.css';

import type {
  AdaptiveRecordType,
  CustomField,
  CustomFieldRecord,
  CustomFieldValue,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import { Field, FieldLabel } from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { PersonPicker } from '@luma/ui/components/primitives/person-picker';
import { Select } from '@luma/ui/components/primitives/select';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { contextOptions } from '../../kit/identity/data';
import { usePermissions } from '../../kit/identity/permissions';
import { membersOptions } from '../../kit/settings/data';
import { adaptiveApi, adaptiveAvailabilityOptions, adaptiveKey } from './data';
import { RecordFieldWorkflowReviews } from './field-workflow-review';
import { adaptiveLabel, cellValue } from './presentation';

/** Adds permission-scoped workspace fields to a record without mutating provider observations. */
export function RecordFields({
  organizationId,
  recordType,
  recordId,
}: {
  organizationId: string;
  recordType: AdaptiveRecordType;
  recordId: string;
}) {
  const availability = useQuery(adaptiveAvailabilityOptions(organizationId));
  const { can } = usePermissions(organizationId);
  const key = [
    ...adaptiveKey(organizationId),
    'record-fields',
    recordType,
    recordId,
  ];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      adaptiveApi.adaptiveFields.readValues(
        { params: { organizationId, recordType, recordId } },
        { signal },
      ),
    enabled: !!availability.data?.fields && can('adaptive.fields.read'),
  });
  if (!availability.data?.fields || !can('adaptive.fields.read')) return null;
  if (query.isPending)
    return <Alert role="status">{m.adaptive_loading()}</Alert>;
  if (query.isError)
    return (
      <Alert tone="warning">
        {m.adaptive_load_failed()}
        <Button variant="outline" onClick={() => void query.refetch()}>
          {m.adaptive_retry()}
        </Button>
      </Alert>
    );
  if (!query.data?.fields.length) return null;

  return (
    <RecordFieldEditor
      key={JSON.stringify(
        query.data.values.map((value) => [value.fieldId, value.revision]),
      )}
      organizationId={organizationId}
      recordType={recordType}
      recordId={recordId}
      data={query.data}
      can={can}
    />
  );
}

function RecordFieldEditor({
  organizationId,
  recordType,
  recordId,
  data,
  can,
}: {
  organizationId: string;
  recordType: AdaptiveRecordType;
  recordId: string;
  data: CustomFieldRecord;
  can: (permission: string) => boolean;
}) {
  const client = useQueryClient();
  const context = useQuery(contextOptions(organizationId));
  const members = useQuery({
    ...membersOptions(organizationId),
    enabled: data.fields.some((field) => field.type === 'person'),
  });
  const editable = (field: CustomField) =>
    !context.data?.supportView &&
    field.source === 'luma' &&
    !field.archived &&
    can('adaptive.fields.write') &&
    can(field.writePermission);
  const values: Record<string, CustomFieldValue> = {};
  for (const field of data.fields)
    values[field.id] =
      data.values.find((value) => value.fieldId === field.id)?.value ?? null;
  const save = useMutation({
    mutationFn: (
      changed: { fieldId: string; value: CustomFieldValue; revision: number }[],
    ) =>
      adaptiveApi.adaptiveFields.writeValues({
        params: { organizationId, recordType, recordId },
        body: { values: changed },
      }),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: adaptiveKey(organizationId) }),
  });
  const form = useForm({
    defaultValues: { values },
    onSubmit: async ({ value }) => {
      const changed = data.fields
        .filter(
          (field) =>
            editable(field) &&
            JSON.stringify(value.values[field.id]) !==
              JSON.stringify(values[field.id]),
        )
        .map((field) => ({
          fieldId: field.id,
          value: value.values[field.id] ?? null,
          revision:
            data.values.find((item) => item.fieldId === field.id)?.revision ??
            0,
        }));
      if (changed.length) await save.mutateAsync(changed);
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">{m.adaptive_fields_title()}</CardTitle>
        <p>{m.adaptive_field_values_note()}</p>
      </CardHeader>
      <CardContent>
        <RecordFieldWorkflowReviews
          organizationId={organizationId}
          recordType={recordType}
          recordId={recordId}
        />
        <form
          className="adaptive-fields-section"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <div className="adaptive-fields-grid">
            {data.fields
              .filter((field) => !field.archived)
              .map((definition) => (
                <form.Field
                  key={definition.id}
                  name={`values.${definition.id}`}
                >
                  {(field) => {
                    const label = adaptiveLabel(definition.label);
                    const current = field.state.value;
                    if (!editable(definition))
                      return (
                        <Field>
                          <FieldLabel>{label}</FieldLabel>
                          <p>
                            {current === null
                              ? m.adaptive_not_set()
                              : definition.type === 'person'
                                ? (members.data?.find(
                                    (member) => member.userId === current,
                                  )?.name ?? m.adaptive_unknown())
                                : cellValue(current)}
                          </p>
                        </Field>
                      );

                    return (
                      <Field>
                        <FieldLabel htmlFor={`custom-${definition.id}`}>
                          {label}
                        </FieldLabel>
                        {definition.type === 'boolean' ? (
                          <Select
                            aria-label={label}
                            value={
                              current === null
                                ? '__unset'
                                : current === true
                                  ? 'true'
                                  : 'false'
                            }
                            options={[
                              { value: '__unset', label: m.adaptive_not_set() },
                              { value: 'true', label: m.adaptive_yes() },
                              { value: 'false', label: m.adaptive_no() },
                            ]}
                            onValueChange={(value) =>
                              field.handleChange(
                                value === '__unset' ? null : value === 'true',
                              )
                            }
                          />
                        ) : definition.type === 'single_choice' ? (
                          <Select
                            aria-label={label}
                            value={
                              typeof current === 'string' ? current : '__unset'
                            }
                            options={[
                              { value: '__unset', label: m.adaptive_not_set() },
                              ...definition.choices.map((choice) => ({
                                value: choice.key,
                                label: adaptiveLabel(choice.label),
                              })),
                            ]}
                            onValueChange={(value) =>
                              field.handleChange(
                                value === '__unset' ? null : value,
                              )
                            }
                          />
                        ) : definition.type === 'multi_choice' ? (
                          <div className="adaptive-checks">
                            {definition.choices.map((choice) => (
                              <label
                                className="adaptive-check"
                                key={choice.key}
                              >
                                <input
                                  type="checkbox"
                                  checked={
                                    Array.isArray(current) &&
                                    current.includes(choice.key)
                                  }
                                  onChange={(event) => {
                                    const selected = Array.isArray(current)
                                      ? current
                                      : [];
                                    field.handleChange(
                                      event.target.checked
                                        ? [...selected, choice.key]
                                        : selected.filter(
                                            (key) => key !== choice.key,
                                          ),
                                    );
                                  }}
                                />
                                {adaptiveLabel(choice.label)}
                              </label>
                            ))}
                          </div>
                        ) : definition.type === 'person' ? (
                          <div className="adaptive-actions">
                            <PersonPicker
                              title={label}
                              label={
                                members.data?.find(
                                  (member) => member.userId === current,
                                )?.name ?? m.adaptive_not_set()
                              }
                              people={(members.data ?? [])
                                .filter((member) => member.status === 'active')
                                .map((member) => ({
                                  id: member.userId,
                                  name:
                                    member.name ||
                                    member.email ||
                                    m.adaptive_unknown(),
                                  detail: member.email,
                                }))}
                              onSelect={(id) => field.handleChange(id)}
                              disabled={!members.data}
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              onClick={() => field.handleChange(null)}
                            >
                              {m.adaptive_remove()}
                            </Button>
                          </div>
                        ) : (
                          <Input
                            id={`custom-${definition.id}`}
                            type={
                              definition.type === 'number'
                                ? 'number'
                                : definition.type === 'date'
                                  ? 'date'
                                  : 'text'
                            }
                            step={
                              definition.type === 'number' ? 'any' : undefined
                            }
                            value={current === null ? '' : String(current)}
                            maxLength={4000}
                            onChange={(event) =>
                              field.handleChange(
                                event.target.value === ''
                                  ? null
                                  : definition.type === 'number'
                                    ? Number(event.target.value)
                                    : event.target.value,
                              )
                            }
                          />
                        )}
                      </Field>
                    );
                  }}
                </form.Field>
              ))}
          </div>
          {save.isError ? (
            <Alert tone="warning" role="alert">
              {m.adaptive_operation_failed()}
            </Alert>
          ) : null}
          {data.fields.some(editable) ? (
            <form.Subscribe selector={(state) => state.isDirty}>
              {(dirty) => (
                <Button type="submit" disabled={!dirty || save.isPending}>
                  {save.isPending
                    ? m.adaptive_saving()
                    : m.adaptive_save_values()}
                </Button>
              )}
            </form.Subscribe>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
