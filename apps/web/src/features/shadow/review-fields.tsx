import { m } from '@luma/i18n/messages';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { useId } from 'react';

export type ActionField = {
  id: string;
  name: string;
  kind: 'text' | 'number' | 'boolean' | 'none';
  value: string;
};

/** Builds editable rows from scalar action fields. */
export function fieldRows(
  fields: Record<string, string | number | boolean | null>,
): ActionField[] {
  return Object.entries(fields).map(([name, value]) => ({
    id: crypto.randomUUID(),
    name,
    kind:
      value === null
        ? 'none'
        : typeof value === 'string'
          ? 'text'
          : typeof value === 'number'
            ? 'number'
            : 'boolean',
    value: value === null ? '' : String(value),
  }));
}

/** Rejects duplicate names and invalid scalar values instead of silently changing an operator action. */
export function readFields(rows: ActionField[]) {
  const result: Record<string, string | number | boolean | null> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (!name || Object.hasOwn(result, name))
      throw new Error(m.shadow_fields_error_unique());
    if (
      row.kind === 'number' &&
      (!row.value.trim() || !Number.isFinite(Number(row.value)))
    )
      throw new Error(m.shadow_fields_error_number({ field: name }));
    if (row.kind === 'boolean' && !['true', 'false'].includes(row.value))
      throw new Error(m.shadow_fields_error_boolean({ field: name }));
    Object.defineProperty(result, name, {
      value:
        row.kind === 'none'
          ? null
          : row.kind === 'number'
            ? Number(row.value)
            : row.kind === 'boolean'
              ? row.value === 'true'
              : row.value,
      enumerable: true,
    });
  }

  return result;
}

const groups = {
  parameters: {
    title: m.shadow_fields_parameters,
    add: m.shadow_fields_add_parameters,
  },
  expected: {
    title: m.shadow_fields_expected,
    add: m.shadow_fields_add_expected,
  },
} satisfies Record<string, { title: () => string; add: () => string }>;

/** Edits parameters or expected results without requiring JSON input. */
export function ActionFieldsEditor({
  group,
  rows,
  change,
}: {
  group: keyof typeof groups;
  rows: ActionField[];
  change: (rows: ActionField[]) => void;
}) {
  const id = useId();
  const title = groups[group].title();
  const update = (rowId: string, patch: Partial<ActionField>) =>
    change(rows.map((row) => (row.id === rowId ? { ...row, ...patch } : row)));

  return (
    <fieldset className="shadow-fields">
      <legend>{title}</legend>
      <FieldGroup>
        {rows.map((row, i) => (
          <div className="shadow-field-row" key={row.id}>
            <Field>
              <FieldLabel htmlFor={`${id}-${i}-name`}>
                {m.shadow_fields_name()}
              </FieldLabel>
              <Input
                id={`${id}-${i}-name`}
                value={row.name}
                onChange={(e) => update(row.id, { name: e.target.value })}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-${i}-type`}>
                {m.shadow_fields_type()}
              </FieldLabel>
              <Select
                id={`${id}-${i}-type`}
                aria-label={m.shadow_fields_type_row({
                  group: title,
                  row: i + 1,
                })}
                value={row.kind}
                onValueChange={(value) =>
                  value &&
                  update(row.id, {
                    kind: value,
                    value: value === 'boolean' ? 'true' : '',
                  })
                }
                options={[
                  { value: 'text', label: m.shadow_fields_kind_text() },
                  { value: 'number', label: m.shadow_fields_kind_number() },
                  { value: 'boolean', label: m.shadow_fields_kind_boolean() },
                  { value: 'none', label: m.shadow_fields_kind_none() },
                ]}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-${i}-value`}>
                {m.shadow_fields_value()}
              </FieldLabel>
              {row.kind === 'boolean' ? (
                <Select
                  id={`${id}-${i}-value`}
                  aria-label={m.shadow_fields_value_row({
                    group: title,
                    row: i + 1,
                  })}
                  value={row.value}
                  onValueChange={(value) => value && update(row.id, { value })}
                  options={[
                    { value: 'true', label: m.common_yes() },
                    { value: 'false', label: m.common_no() },
                  ]}
                />
              ) : (
                <Input
                  id={`${id}-${i}-value`}
                  disabled={row.kind === 'none'}
                  type={row.kind === 'number' ? 'number' : 'text'}
                  step="any"
                  value={row.value}
                  onChange={(e) => update(row.id, { value: e.target.value })}
                />
              )}
            </Field>
            <Button
              type="button"
              variant="ghost"
              aria-label={m.shadow_fields_remove_row({
                group: title,
                row: i + 1,
              })}
              onClick={() => change(rows.filter((r) => r.id !== row.id))}
            >
              {m.common_remove()}
            </Button>
          </div>
        ))}
      </FieldGroup>
      <Button
        type="button"
        variant="outline"
        onClick={() =>
          change([
            ...rows,
            { id: crypto.randomUUID(), name: '', kind: 'text', value: '' },
          ])
        }
      >
        {groups[group].add()}
      </Button>
    </fieldset>
  );
}
