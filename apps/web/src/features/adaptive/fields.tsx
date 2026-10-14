import './adaptive.css';

import {
  type AdaptiveRecordType,
  type CustomField,
  type CustomFieldInput,
  customFieldInputSchema,
  customFieldTypeSchema,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Field, FieldLabel } from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { Textarea } from '@luma/ui/components/primitives/textarea';
import { PageTitle } from '@luma/ui/components/workspace/page-header';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useState } from 'react';

import { Pending } from '../../kit/identity/common';
import { NoAccess, usePermissions } from '../../kit/identity/permissions';
import { rolesOptions } from '../../kit/settings/roles-data';
import { adaptiveApi, adaptiveAvailabilityOptions, adaptiveKey } from './data';
import { adaptiveLabel } from './presentation';

/** Names the supported record owners for field definition and query forms. */
function recordTypeOptions() {
  return [
    { value: 'order', label: m.adaptive_order() },
    { value: 'product', label: m.adaptive_product() },
    { value: 'supplier', label: m.adaptive_supplier() },
    { value: 'purchase_order', label: m.adaptive_purchase_order() },
    { value: 'customer', label: m.adaptive_customer() },
  ] satisfies { value: AdaptiveRecordType; label: string }[];
}

function fieldTypes() {
  return [
    { value: 'text', label: m.adaptive_text() },
    { value: 'number', label: m.adaptive_number() },
    { value: 'date', label: m.adaptive_date() },
    { value: 'boolean', label: m.adaptive_boolean() },
    { value: 'single_choice', label: m.adaptive_select() },
    { value: 'multi_choice', label: m.adaptive_multi_select() },
    { value: 'person', label: m.adaptive_person() },
  ] satisfies { value: CustomField['type']; label: string }[];
}

/** Defines bilingual, permission-scoped fields and retains retired definitions for review. */
export function FieldsPage() {
  const { organizationId } = useParams({ from: '/app/$organizationId' });
  const { can } = usePermissions(organizationId);
  const availability = useQuery(adaptiveAvailabilityOptions(organizationId));
  const [recordType, setRecordType] = useState<AdaptiveRecordType>('order');
  const [selected, setSelected] = useState<CustomField | 'new' | null>(null);
  const client = useQueryClient();
  const list = useQuery({
    queryKey: [...adaptiveKey(organizationId), 'fields', recordType],
    queryFn: ({ signal }) =>
      adaptiveApi.adaptiveFields.list(
        {
          params: { organizationId },
          query: { recordType, includeArchived: true },
        },
        { signal },
      ),
    enabled: !!availability.data?.fields && can('adaptive.fields.read'),
  });
  const retire = useMutation({
    mutationFn: (field: CustomField) =>
      (field.archived
        ? adaptiveApi.adaptiveFields.restore
        : adaptiveApi.adaptiveFields.archive)({
        params: { organizationId, fieldId: field.id },
        body: { revision: field.revision },
      }),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: adaptiveKey(organizationId) }),
  });
  if (!can('adaptive.fields.read'))
    return (
      <NoAccess
        organizationId={organizationId}
        area={m.adaptive_fields_title()}
        permission="adaptive.fields.read"
      />
    );
  if (availability.isPending) return <Pending />;
  if (!availability.data?.fields)
    return <Alert>{m.adaptive_unavailable()}</Alert>;

  return (
    <div className="adaptive-workspace">
      <PageTitle
        title={m.adaptive_fields_title()}
        actions={
          can('adaptive.fields.manage') ? (
            <Button onClick={() => setSelected('new')}>
              <Plus aria-hidden="true" />
              {m.adaptive_new_field()}
            </Button>
          ) : null
        }
      />
      <p>{m.adaptive_fields_description()}</p>
      <Select
        aria-label={m.adaptive_domain()}
        options={recordTypeOptions()}
        value={recordType}
        onValueChange={(value) => {
          if (value) setRecordType(value);
        }}
      />
      {list.isPending ? (
        <Pending />
      ) : list.isError ? (
        <Alert tone="warning">
          {m.adaptive_load_failed()}
          <Button variant="outline" onClick={() => void list.refetch()}>
            {m.adaptive_retry()}
          </Button>
        </Alert>
      ) : (
        <DataTable
          caption={m.adaptive_fields_title()}
          rows={list.data ?? []}
          rowKey={(field) => field.id}
          empty={<Alert>{m.adaptive_field_empty()}</Alert>}
          columns={[
            {
              key: 'label',
              header: m.adaptive_name(),
              cell: (field) => adaptiveLabel(field.label),
            },
            {
              key: 'type',
              header: m.adaptive_field_type(),
              cell: (field) =>
                fieldTypes().find((type) => type.value === field.type)?.label,
            },
            {
              key: 'state',
              header: m.adaptive_result(),
              cell: (field) => (
                <Badge>
                  {field.archived ? m.adaptive_retired() : m.adaptive_active()}
                </Badge>
              ),
            },
            {
              key: 'actions',
              header: m.adaptive_actions(),
              cell: (field) =>
                can('adaptive.fields.manage') && field.source === 'luma' ? (
                  <div className="adaptive-actions">
                    {!field.archived ? (
                      <Button
                        variant="outline"
                        onClick={() => setSelected(field)}
                      >
                        {m.adaptive_edit_view()}
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      disabled={retire.isPending}
                      onClick={() => retire.mutate(field)}
                    >
                      {field.archived
                        ? m.adaptive_restore_field()
                        : m.adaptive_retire()}
                    </Button>
                  </div>
                ) : null,
            },
          ]}
        />
      )}
      {retire.isError ? (
        <Alert tone="warning" role="alert">
          {m.adaptive_operation_failed()}
        </Alert>
      ) : null}
      {selected ? (
        <FieldDefinitionEditor
          key={selected === 'new' ? `new:${recordType}` : selected.id}
          organizationId={organizationId}
          recordType={recordType}
          existing={selected === 'new' ? undefined : selected}
          close={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}

function FieldDefinitionEditor({
  organizationId,
  recordType,
  existing,
  close,
}: {
  organizationId: string;
  recordType: AdaptiveRecordType;
  existing?: CustomField | undefined;
  close: () => void;
}) {
  const client = useQueryClient();
  const [commandId] = useState(() => crypto.randomUUID());
  const [invalid, setInvalid] = useState(false);
  const roles = useQuery(rolesOptions(organizationId));
  const save = useMutation({
    mutationFn: (input: CustomFieldInput) =>
      existing
        ? adaptiveApi.adaptiveFields.update({
            params: { organizationId, fieldId: existing.id },
            body: { ...input, revision: existing.revision },
          })
        : adaptiveApi.adaptiveFields.create({
            params: { organizationId },
            body: { ...input, commandId },
          }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: adaptiveKey(organizationId) });
      close();
    },
  });
  const defaults: CustomFieldInput = existing ?? {
    recordType,
    key: '',
    label: { en: '', de: '' },
    type: 'text',
    choices: [],
    readPermission: 'adaptive.fields.read',
    writePermission: 'adaptive.fields.write',
  };
  const form = useForm({
    defaultValues: {
      ...defaults,
      choicesText:
        existing?.choices
          .map(
            (choice) => `${choice.key}|${choice.label.en}|${choice.label.de}`,
          )
          .join('\n') ?? '',
    },
    onSubmit: async ({ value }) => {
      const { choicesText, ...fields } = value;
      const choices = ['single_choice', 'multi_choice'].includes(fields.type)
        ? choicesText
            .split('\n')
            .filter((line) => line.trim())
            .map((line) => {
              const [key = '', en = '', de = ''] = line.split('|');

              return {
                key: key.trim(),
                label: { en: en.trim(), de: de.trim() },
              };
            })
        : [];
      const parsed = customFieldInputSchema.safeParse({
        recordType: fields.recordType,
        key: fields.key,
        label: fields.label,
        type: fields.type,
        choices,
        readPermission: fields.readPermission,
        writePermission: fields.writePermission,
      });
      setInvalid(!parsed.success);
      if (parsed.success) await save.mutateAsync(parsed.data);
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !save.isPending) close();
      }}
    >
      <DialogContent className="adaptive-dialog">
        <DialogHeader>
          <DialogTitle>
            {existing ? m.adaptive_fields_title() : m.adaptive_new_field()}
          </DialogTitle>
          <DialogDescription>
            {m.adaptive_fields_description()}
          </DialogDescription>
        </DialogHeader>
        <form
          className="adaptive-editor-form"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <form.Field name="key">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="field-key">
                  {m.adaptive_field_key()}
                </FieldLabel>
                <Input
                  id="field-key"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  disabled={!!existing}
                  required
                  pattern="[a-z][a-z0-9_]{0,63}"
                />
              </Field>
            )}
          </form.Field>
          <div className="adaptive-editor-pair">
            <form.Field name="label.en">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor="field-en">
                    {m.adaptive_label_en()}
                  </FieldLabel>
                  <Input
                    id="field-en"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                    required
                    maxLength={100}
                  />
                </Field>
              )}
            </form.Field>
            <form.Field name="label.de">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor="field-de">
                    {m.adaptive_label_de()}
                  </FieldLabel>
                  <Input
                    id="field-de"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                    required
                    maxLength={100}
                  />
                </Field>
              )}
            </form.Field>
          </div>
          <form.Field name="type">
            {(field) => (
              <Field>
                <FieldLabel>{m.adaptive_field_type()}</FieldLabel>
                <Select
                  aria-label={m.adaptive_field_type()}
                  value={field.state.value}
                  options={fieldTypes()}
                  onValueChange={(value) => {
                    const parsed = customFieldTypeSchema.safeParse(value);
                    if (parsed.success) field.handleChange(parsed.data);
                  }}
                />
              </Field>
            )}
          </form.Field>
          <form.Subscribe selector={(state) => state.values.type}>
            {(type) =>
              ['single_choice', 'multi_choice'].includes(type) ? (
                <form.Field name="choicesText">
                  {(field) => (
                    <Field>
                      <FieldLabel htmlFor="field-options">
                        {m.adaptive_field_options()}
                      </FieldLabel>
                      <Textarea
                        id="field-options"
                        value={field.state.value}
                        onChange={(event) =>
                          field.handleChange(event.target.value)
                        }
                        placeholder={m.adaptive_choice_placeholder()}
                      />
                      <p>{m.adaptive_choice_format()}</p>
                    </Field>
                  )}
                </form.Field>
              ) : null
            }
          </form.Subscribe>
          <div className="adaptive-editor-pair">
            <form.Field name="readPermission">
              {(field) => (
                <Field>
                  <FieldLabel>{m.adaptive_read_permission()}</FieldLabel>
                  <Select
                    aria-label={m.adaptive_read_permission()}
                    value={field.state.value}
                    options={(roles.data?.permissions ?? []).map(
                      (permission) => ({
                        value: permission.key,
                        label: permission.label,
                      }),
                    )}
                    onValueChange={(value) => {
                      if (value) field.handleChange(value);
                    }}
                  />
                </Field>
              )}
            </form.Field>
            <form.Field name="writePermission">
              {(field) => (
                <Field>
                  <FieldLabel>{m.adaptive_write_permission()}</FieldLabel>
                  <Select
                    aria-label={m.adaptive_write_permission()}
                    value={field.state.value}
                    options={(roles.data?.permissions ?? []).map(
                      (permission) => ({
                        value: permission.key,
                        label: permission.label,
                      }),
                    )}
                    onValueChange={(value) => {
                      if (value) field.handleChange(value);
                    }}
                  />
                </Field>
              )}
            </form.Field>
          </div>
          {invalid ? (
            <Alert tone="warning" role="alert">
              {m.adaptive_field_invalid()}
            </Alert>
          ) : null}
          {save.isError ? (
            <Alert tone="danger" role="alert">
              {m.adaptive_operation_failed()}
            </Alert>
          ) : null}
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? m.adaptive_saving() : m.adaptive_save_values()}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
