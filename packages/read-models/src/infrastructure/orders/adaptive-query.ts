import type { TenantContext } from '@luma/identity';
import { IdentityError } from '@luma/identity';
import type { SqlTransaction } from '@luma/platform';

import type { OrderAdaptiveSelection } from '../../application/orders.js';

interface FieldRow extends Record<string, unknown> {
  id: string;
  field_type: string;
  document: { readPermission?: unknown; choices?: { key: string }[] };
}

/** Compiles authorized custom-field predicates into the native filtered order relation. */
export async function adaptiveOrderSelection(
  tx: SqlTransaction,
  context: TenantContext,
  input: OrderAdaptiveSelection,
  values: unknown[],
) {
  const fields = (
    await tx.query<FieldRow>(
      "SELECT id,field_type,document FROM adaptive_fields WHERE tenant_id=$1 AND record_type='order' AND NOT archived",
      [context.tenantId],
    )
  ).rows;
  const param = (value: unknown) => {
    values.push(value);

    return `$${values.length}`;
  };
  const definition = (id: string) => {
    const field = fields.find((item) => item.id === id);
    if (
      !field ||
      typeof field.document.readPermission !== 'string' ||
      !context.permissions.has(field.document.readPermission)
    )
      throw new IdentityError(
        422,
        'VALIDATION_ERROR',
        'A custom field is unavailable.',
      );

    return field;
  };
  const column = (type: string) =>
    type === 'number'
      ? 'number_value'
      : type === 'boolean'
        ? 'boolean_value'
        : type === 'date'
          ? 'date_value'
          : 'text_value';
  const predicates: string[] = [];
  if (input.filters.length > 20)
    throw new IdentityError(
      422,
      'VALIDATION_ERROR',
      'Too many custom-field filters.',
    );
  for (const filter of input.filters) {
    const field = definition(filter.fieldId);
    const relation = `v.tenant_id=$1 AND v.record_type='order' AND v.record_id=o.entity_id AND v.field_id=${param(field.id)}::uuid`;
    if (filter.operator === 'is_empty') {
      predicates.push(
        `NOT EXISTS(SELECT 1 FROM adaptive_field_values v WHERE ${relation} AND v.value<>'null'::jsonb)`,
      );
      continue;
    }
    if (filter.operator === 'contains') {
      if (field.field_type === 'multi_choice')
        predicates.push(
          `EXISTS(SELECT 1 FROM adaptive_field_values v WHERE ${relation} AND v.value @> ${param(JSON.stringify([filter.value]))}::jsonb)`,
        );
      else if (field.field_type === 'text' && typeof filter.value === 'string')
        predicates.push(
          `EXISTS(SELECT 1 FROM adaptive_field_values v WHERE ${relation} AND strpos(v.text_value,${param(filter.value)})>0)`,
        );
      else
        throw new IdentityError(
          422,
          'VALIDATION_ERROR',
          'Contains requires text or multiple-choice fields.',
        );
      continue;
    }
    if (field.field_type === 'multi_choice')
      throw new IdentityError(
        422,
        'VALIDATION_ERROR',
        'Multiple-choice filters use contains or is-empty.',
      );
    if (filter.value === null && !['eq', 'ne'].includes(filter.operator))
      throw new IdentityError(
        422,
        'VALIDATION_ERROR',
        'Only equality filters accept an empty value.',
      );
    if (
      filter.value !== null &&
      ((field.field_type === 'number' && typeof filter.value !== 'number') ||
        (field.field_type === 'boolean' && typeof filter.value !== 'boolean') ||
        (!['number', 'boolean'].includes(field.field_type) &&
          typeof filter.value !== 'string'))
    )
      throw new IdentityError(
        422,
        'VALIDATION_ERROR',
        'The filter value does not match the custom field type.',
      );
    if (
      ['gt', 'gte', 'lt', 'lte'].includes(filter.operator) &&
      !['number', 'date'].includes(field.field_type)
    )
      throw new IdentityError(
        422,
        'VALIDATION_ERROR',
        'Range filters require number or date fields.',
      );
    const operator = {
      eq: '=',
      ne: '<>',
      gt: '>',
      gte: '>=',
      lt: '<',
      lte: '<=',
    }[filter.operator];
    if (filter.value === null)
      predicates.push(
        `${filter.operator === 'eq' ? 'NOT ' : ''}EXISTS(SELECT 1 FROM adaptive_field_values v WHERE ${relation} AND v.value<>'null'::jsonb)`,
      );
    else
      predicates.push(
        `EXISTS(SELECT 1 FROM adaptive_field_values v WHERE ${relation} AND v.${column(field.field_type)} ${operator} ${param(filter.value)})`,
      );
  }
  if (input.selectedRecordIds)
    predicates.push(
      `o.entity_id=ANY(${param(input.selectedRecordIds)}::uuid[])`,
    );
  let sort: string | undefined;
  if (input.sort) {
    const field = definition(input.sort.fieldId);
    if (field.field_type === 'multi_choice')
      throw new IdentityError(
        422,
        'VALIDATION_ERROR',
        'Multiple-choice fields cannot order records.',
      );
    const value = `(SELECT v.${column(field.field_type)} FROM adaptive_field_values v WHERE v.tenant_id=$1 AND v.record_type='order' AND v.record_id=entity_id AND v.field_id=${param(field.id)}::uuid)`;
    sort = `${value} ${input.sort.direction === 'asc' ? 'ASC' : 'DESC'} NULLS LAST,entity_id`;
  }

  return {
    predicate: predicates.length ? predicates.join(' AND ') : 'true',
    sort,
    offsetParameter: param(input.offset ?? 0),
  };
}
