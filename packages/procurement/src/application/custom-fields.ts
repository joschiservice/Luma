import type { TenantContext } from '@luma/identity';
import { IdentityError } from '@luma/identity';

import {
  type ListField,
  type ListFields,
  listQueryError,
} from './list-conditions.js';
import type {
  CustomFieldType,
  CustomSort,
  ListCondition,
  ListCustomField,
  ListOperator,
  ListWhere,
} from './lists.js';

/** A live custom field definition with the permission needed to read its values. */
export interface CustomFieldDefinition extends ListCustomField {
  readPermission: string | null;
}

/** Record types of procurement lists that carry custom fields. */
export type CustomFieldRecordType = 'purchase_order' | 'supplier';

const text = [
  'contains',
  'not_contains',
  'is',
  'is_not',
  'empty',
  'not_empty',
] as const satisfies readonly ListOperator[];
const choice = [
  'any_of',
  'none_of',
  'empty',
  'not_empty',
] as const satisfies readonly ListOperator[];
const tags = [
  'any_of',
  'all_of',
  'none_of',
  'empty',
  'not_empty',
] as const satisfies readonly ListOperator[];
const quantity = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'empty',
  'not_empty',
] as const satisfies readonly ListOperator[];
const moment = [
  'before',
  'after',
  'between',
  'within_last',
  'within_next',
  'empty',
  'not_empty',
] as const satisfies readonly ListOperator[];

/**
 * How a custom field type filters; every operator runs in SQL. The operators are the
 * collection catalog's operators for the field type, so conditions work alike on every list.
 * Dates are calendar days and compare as days.
 */
function customField<T>(type: CustomFieldType): ListField<T> {
  switch (type) {
    case 'text':
      return { kind: 'text', operators: text, stored: text };
    case 'single_choice':
    case 'person':
      return { kind: 'choice', operators: choice, stored: choice };
    case 'multi_choice':
      return { kind: 'choices', operators: tags, stored: tags };
    case 'number':
      return { kind: 'number', operators: quantity, stored: quantity };
    case 'date':
      return { kind: 'day', operators: moment, stored: moment };
    case 'boolean':
      return { kind: 'flag', operators: ['is'], stored: ['is'] };
  }
}

/** Whether a sort names a custom field. */
export function isCustomSort(sort: string): sort is CustomSort {
  return sort.startsWith('custom:');
}

/** Field IDs a query names as `custom:<id>` in its conditions or sort, each once. */
export function customFieldIds(
  where: ListWhere | undefined,
  sort: string,
): string[] {
  return [
    ...new Set(
      [...(where?.conditions.map((condition) => condition.field) ?? []), sort]
        .filter(isCustomSort)
        .map((name) => name.slice(7)),
    ),
  ];
}

/**
 * Checks that every named field is live and readable by the reader. Archived, unknown and
 * malformed field IDs throw a 400 error, so a view that uses them needs repair; fields behind a
 * permission the reader lacks throw a 403 error, so their values can't be inferred through
 * filters or the sort.
 */
export function readableCustomFields(
  context: TenantContext,
  ids: readonly string[],
  definitions: readonly CustomFieldDefinition[],
): ListCustomField[] {
  return ids.map((id) => {
    const found = definitions.find((definition) => definition.id === id);
    if (!found) throw listQueryError('A custom field is unavailable.');
    if (!found.readPermission || !context.permissions.has(found.readPermission))
      throw new IdentityError(
        403,
        'FORBIDDEN',
        'Your role cannot use one of these custom fields.',
      );

    return { id: found.id, type: found.type };
  });
}

/** List fields for custom fields, keyed `custom:<id>`; the store evaluates them in SQL. */
export function customListFields<T>(
  fields: readonly ListCustomField[],
): ListFields<T> {
  return Object.fromEntries(
    fields.map((field) => [`custom:${field.id}`, customField<T>(field.type)]),
  );
}

/**
 * Resolves `me` in custom person conditions to the reader, so they compare as user IDs.
 * Other conditions are returned unchanged.
 */
export function withCustomReader(
  where: ListWhere | undefined,
  userId: string,
): ListWhere | undefined {
  if (!where) return where;
  const resolve = (condition: ListCondition): ListCondition => {
    if (!isCustomSort(condition.field) || !Array.isArray(condition.value))
      return condition;

    return {
      ...condition,
      value: condition.value.map((item) =>
        typeof item === 'object' && item.dynamic === 'me' ? userId : item,
      ),
    };
  };

  return { ...where, conditions: where.conditions.map(resolve) };
}

/**
 * The custom field a sort names, or null for other sorts. Throws a 400 error for fields with
 * several values, which cannot order rows.
 */
export function customSortField(
  fields: readonly ListCustomField[],
  sort: string,
): ListCustomField | null {
  if (!isCustomSort(sort)) return null;
  const field = fields.find((item) => `custom:${item.id}` === sort);
  if (!field || field.type === 'multi_choice')
    throw listQueryError('This custom field cannot order the list.');

  return field;
}
