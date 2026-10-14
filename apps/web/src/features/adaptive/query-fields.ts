import {
  type AdaptiveViewDomain,
  adaptiveViewDomainSchema,
  adaptiveViewOwnerFilters,
  type AdaptiveViewQuery,
  collectionCatalogs,
  type CollectionCondition,
  type CollectionDomain,
  type CollectionFieldType,
  type CollectionGranularity,
  type CollectionOperator,
  collectionOperators,
  type CustomField,
} from '@luma/api-contract';

/**
 * A field the view editor offers, by catalog field ID or `custom:<id>`. Owner filters accept
 * only `any_of` with exactly one value.
 */
export interface EditorField {
  id: string;
  type: CollectionFieldType;
  operators: readonly CollectionOperator[];
  options?: readonly string[] | undefined;
  custom?: CustomField | undefined;
  ownerFilter?: boolean | undefined;
  permission?: string | undefined;
}

/** A field a view can be grouped by; date fields with periods must name one. */
export interface GroupField {
  id: string;
  granularities?: readonly CollectionGranularity[] | undefined;
}

const customTypes: Record<CustomField['type'], CollectionFieldType> = {
  text: 'text',
  number: 'number',
  date: 'date',
  boolean: 'boolean',
  single_choice: 'enum',
  multi_choice: 'tags',
  person: 'person',
};

/** Whether the saved-view preview can read records of this list. */
export function previewable(
  domain: CollectionDomain,
): domain is AdaptiveViewDomain {
  return adaptiveViewDomainSchema.safeParse(domain).success;
}

/** The custom field record type a list shows, or null when it has none. */
export function customRecordType(domain: CollectionDomain) {
  return collectionCatalogs[domain].customFields ?? null;
}

function customField(field: CustomField): EditorField {
  const type = customTypes[field.type];

  return {
    id: `custom:${field.id}`,
    type,
    operators: collectionOperators[type],
    options: field.choices.length
      ? field.choices.map((choice) => choice.key)
      : undefined,
    custom: field,
  };
}

function readable(domain: CollectionDomain, custom: readonly CustomField[]) {
  return customRecordType(domain)
    ? custom.filter((field) => !field.archived).map(customField)
    : [];
}

/**
 * Fields conditions may use: catalog filters, the owner filters the view engine runs, and the
 * list's readable custom fields.
 */
export function conditionFields(
  domain: CollectionDomain,
  custom: readonly CustomField[] = [],
): EditorField[] {
  const catalog = collectionCatalogs[domain];
  const owner = adaptiveViewOwnerFilters[domain] ?? {};
  const native = catalog.fields.flatMap((field): EditorField[] => {
    if (field.filter)
      return [
        {
          id: field.id,
          type: field.type,
          operators: field.filter,
          options: field.options,
          permission: field.permission,
        },
      ];
    if (field.id in owner)
      return [
        {
          id: field.id,
          type: field.type,
          operators: ['any_of'],
          options: field.options,
          ownerFilter: true,
          permission: field.permission,
        },
      ];

    return [];
  });

  return [...native, ...readable(domain, custom)];
}

/** Columns a view may show: every catalog column and readable custom field. */
export function columnFields(
  domain: CollectionDomain,
  custom: readonly CustomField[] = [],
): string[] {
  return [
    ...collectionCatalogs[domain].fields
      .filter((field) => field.column)
      .map((field) => field.id),
    ...readable(domain, custom).map((field) => field.id),
  ];
}

/** Fields a view may sort by: catalog sorts and readable custom fields. */
export function sortFields(
  domain: CollectionDomain,
  custom: readonly CustomField[] = [],
): string[] {
  return [
    ...collectionCatalogs[domain].fields
      .filter((field) => field.sort)
      .map((field) => field.id),
    ...readable(domain, custom).map((field) => field.id),
  ];
}

/**
 * Fields a view may group by: catalog groups, which need a period for dates, and any other
 * column, which the view engine groups by its exact value.
 */
export function groupFields(
  domain: CollectionDomain,
  custom: readonly CustomField[] = [],
): GroupField[] {
  return [
    ...collectionCatalogs[domain].fields
      .filter((field) => field.group || field.column)
      .map((field) => ({
        id: field.id,
        granularities:
          field.type === 'date' && Array.isArray(field.group)
            ? field.group
            : undefined,
      })),
    ...readable(domain, custom).map((field) => ({ id: field.id })),
  ];
}

/** Numeric fields metrics can sum or average. */
export function metricFields(
  domain: CollectionDomain,
  custom: readonly CustomField[] = [],
): string[] {
  return [
    ...collectionCatalogs[domain].fields
      .filter((field) => field.column && field.type === 'number')
      .map((field) => field.id),
    ...readable(domain, custom)
      .filter((field) => field.type === 'number')
      .map((field) => field.id),
  ];
}

/** The columns a view shows; an empty list means the list's default columns. */
export function viewColumns(query: AdaptiveViewQuery): string[] {
  return query.state.columns.length
    ? query.state.columns.map((column) => column.id)
    : [...collectionCatalogs[query.domain].defaultColumns];
}

/** A catalog field's type, or the mapped type of a custom field; null when unknown. */
export function fieldType(
  domain: CollectionDomain,
  id: string,
  custom: readonly CustomField[] = [],
): CollectionFieldType | null {
  if (id.startsWith('custom:')) {
    const field = custom.find((item) => `custom:${item.id}` === id);

    return field ? customTypes[field.type] : null;
  }

  return (
    collectionCatalogs[domain].fields.find((field) => field.id === id)?.type ??
    null
  );
}

/** How the editor collects a condition's value. */
export type ValueInput = 'none' | 'list' | 'single';

const valueless = new Set<CollectionOperator>([
  'empty',
  'not_empty',
  'unknown',
]);
const lists = new Set<CollectionOperator>(['any_of', 'none_of', 'all_of']);
const comparisons = new Set<CollectionOperator>([
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
]);

/** The value an operator takes, or null when the simple editor cannot collect it. */
export function valueInput(
  field: Pick<EditorField, 'type'>,
  op: CollectionOperator,
): ValueInput | null {
  if (valueless.has(op)) return 'none';
  if (lists.has(op)) return 'list';
  if (op === 'between' || op === 'within_last' || op === 'within_next')
    return null;
  if (field.type === 'money' && comparisons.has(op)) return null;

  return 'single';
}

/** Operators of a field that the simple editor can collect values for. */
export function editableOperators(field: EditorField): CollectionOperator[] {
  return field.operators.filter((op) => valueInput(field, op) !== null);
}

function scalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/**
 * Whether the simple editor can show and change a condition without losing meaning. Others,
 * such as ranges or "me", stay visible and removable.
 */
export function editableCondition(
  field: EditorField | undefined,
  condition: CollectionCondition,
): boolean {
  if (!field || !field.operators.includes(condition.op)) return false;
  const input = valueInput(field, condition.op);
  if (input === 'none') return condition.value === undefined;
  if (input === 'list')
    return (
      condition.value === undefined ||
      (Array.isArray(condition.value) && condition.value.every(scalar))
    );

  return (
    input === 'single' &&
    (condition.value === undefined || scalar(condition.value))
  );
}

/** The value a condition starts with after its field or operator changes. */
export function initialValue(
  field: EditorField,
  op: CollectionOperator,
): CollectionCondition['value'] {
  const input = valueInput(field, op);
  if (input === 'none') return undefined;
  if (field.type === 'boolean') return true;
  const first = field.options?.[0];
  if (input === 'list') return first === undefined ? undefined : [first];

  return first;
}

/** Starts a condition on a field with its first editable operator. */
export function newCondition(field: EditorField): CollectionCondition {
  const op = editableOperators(field)[0] ?? field.operators[0] ?? 'any_of';
  const value = initialValue(field, op);

  return value === undefined
    ? { field: field.id, op }
    : { field: field.id, op, value };
}

/** Reads typed text as a condition value: numbers for number fields, a list for list operators. */
export function parseValue(
  field: Pick<EditorField, 'type'>,
  op: CollectionOperator,
  text: string,
): CollectionCondition['value'] {
  const read = (part: string) => {
    if (field.type === 'number') {
      const number = Number(part);

      return part.trim() !== '' && Number.isFinite(number) ? number : null;
    }

    return part.trim() || null;
  };
  if (valueInput(field, op) === 'list') {
    const values = text
      .split(',')
      .map(read)
      .filter((value): value is string | number => value !== null);

    return values.length ? values : undefined;
  }

  return read(text) ?? undefined;
}

/** Shows a scalar or list value as editable text. */
export function valueText(value: CollectionCondition['value']): string {
  if (Array.isArray(value)) return value.filter(scalar).join(', ');

  return scalar(value) ? String(value) : '';
}

/**
 * Indexes of conditions the view could not run: unknown fields, unsupported operators, missing
 * values, and owner filters without exactly one value.
 */
export function invalidConditions(
  fields: readonly EditorField[],
  conditions: readonly CollectionCondition[],
): number[] {
  return conditions.flatMap((condition, index) => {
    const field = fields.find((item) => item.id === condition.field);
    if (!field || !field.operators.includes(condition.op)) return [index];
    if (field.ownerFilter)
      return Array.isArray(condition.value) && condition.value.length === 1
        ? []
        : [index];
    const input = valueInput(field, condition.op);
    if (input === 'none') return condition.value === undefined ? [] : [index];
    if (condition.value === undefined) return [index];
    if (input === 'list')
      return Array.isArray(condition.value) &&
        condition.value.length &&
        condition.value.every(
          (value) =>
            !field.options ||
            typeof value !== 'string' ||
            field.options.includes(value),
        )
        ? []
        : [index];
    if (field.type === 'boolean' && typeof condition.value !== 'boolean')
      return [index];
    if (
      field.type === 'number' &&
      comparisons.has(condition.op) &&
      typeof condition.value !== 'number'
    )
      return [index];

    return [];
  });
}
