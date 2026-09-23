import { Button } from '@luma/ui/button';
import { Field, FieldGroup, FieldLabel } from '@luma/ui/components/field';
import { Input } from '@luma/ui/components/input';
import { Select } from '@luma/ui/components/select';
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
      throw new Error('Use a unique name for each action field.');
    if (
      row.kind === 'number' &&
      (!row.value.trim() || !Number.isFinite(Number(row.value)))
    )
      throw new Error(`Enter a valid number for ${name}.`);
    if (row.kind === 'boolean' && !['true', 'false'].includes(row.value))
      throw new Error(`Choose true or false for ${name}.`);
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

/** Edits parameters or expected results without requiring JSON input. */
export function ActionFieldsEditor({
  title,
  rows,
  change,
}: {
  title: string;
  rows: ActionField[];
  change: (rows: ActionField[]) => void;
}) {
  const id = useId();
  const update = (rowId: string, patch: Partial<ActionField>) =>
    change(rows.map((row) => (row.id === rowId ? { ...row, ...patch } : row)));

  return (
    <fieldset className="shadow-fields">
      <legend>{title}</legend>
      <FieldGroup>
        {rows.map((row, i) => (
          <div className="shadow-field-row" key={row.id}>
            <Field>
              <FieldLabel htmlFor={`${id}-${i}-name`}>Field name</FieldLabel>
              <Input
                id={`${id}-${i}-name`}
                value={row.name}
                onChange={(e) => update(row.id, { name: e.target.value })}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-${i}-type`}>Value type</FieldLabel>
              <Select
                id={`${id}-${i}-type`}
                aria-label={`${title} value type ${i + 1}`}
                value={row.kind}
                onValueChange={(value) =>
                  value &&
                  update(row.id, {
                    kind: value,
                    value: value === 'boolean' ? 'true' : '',
                  })
                }
                options={[
                  { value: 'text', label: 'Text' },
                  { value: 'number', label: 'Number' },
                  { value: 'boolean', label: 'True / false' },
                  { value: 'none', label: 'None' },
                ]}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-${i}-value`}>Value</FieldLabel>
              {row.kind === 'boolean' ? (
                <Select
                  id={`${id}-${i}-value`}
                  aria-label={`${title} value ${i + 1}`}
                  value={row.value}
                  onValueChange={(value) => value && update(row.id, { value })}
                  options={[
                    { value: 'true', label: 'True' },
                    { value: 'false', label: 'False' },
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
              aria-label={`Remove ${title.toLowerCase()} field ${i + 1}`}
              onClick={() => change(rows.filter((r) => r.id !== row.id))}
            >
              Remove
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
        Add {title.toLowerCase()} field
      </Button>
    </fieldset>
  );
}
