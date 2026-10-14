import type { SqlTransaction } from '@luma/platform';

import type {
  CustomFieldDefinition,
  CustomFieldRecordType,
} from '../application/custom-fields.js';
import type {
  CustomFieldType,
  ListCustomField,
  StoredWhere,
} from '../application/lists.js';
import type { BindParameter, StoredFieldSql } from './list-sql.js';

/*
 * Custom field values belong to the adaptive area. Procurement lists read them here, and only
 * here, with the reader's tenant bound as `$1`: definitions to check what a query may use, and
 * values of the list row to filter and sort by them in SQL before paging.
 */

/** A list row whose custom field values a query reads: its record type and ID column. */
export interface CustomFieldRow {
  type: CustomFieldRecordType;
  /** The row's record ID, such as `o.id`. */
  id: string;
}

const fieldTypes = new Set<string>([
  'text',
  'number',
  'date',
  'boolean',
  'single_choice',
  'multi_choice',
  'person',
] satisfies CustomFieldType[]);

function isFieldType(type: string): type is CustomFieldType {
  return fieldTypes.has(type);
}

/**
 * Reads live custom field definitions of `recordType` among `ids`, with their read permission.
 * Archived and unknown fields, and IDs that aren't UUIDs, are absent from the result.
 */
export async function readCustomFieldDefinitions(
  tx: SqlTransaction,
  tenantId: string,
  recordType: CustomFieldRecordType,
  ids: readonly string[],
): Promise<CustomFieldDefinition[]> {
  const uuids = ids.filter((id) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
  );
  if (!uuids.length) return [];
  const rows = await tx.query<{
    id: string;
    field_type: string;
    document: { readPermission?: unknown };
  }>(
    'SELECT id,field_type,document FROM adaptive_fields WHERE tenant_id=$1 AND record_type=$2 AND NOT archived AND id=ANY($3::uuid[])',
    [tenantId, recordType, uuids],
  );

  return rows.rows.flatMap((row) =>
    isFieldType(row.field_type)
      ? [
          {
            id: row.id,
            type: row.field_type,
            readPermission:
              typeof row.document.readPermission === 'string'
                ? row.document.readPermission
                : null,
          },
        ]
      : [],
  );
}

/** SQL reading `column` of one field's value of the row, NULL when the row has none. */
function valueSql(
  row: CustomFieldRow,
  field: ListCustomField,
  column: string,
  bind: BindParameter,
) {
  return `(SELECT ${column} FROM adaptive_field_values v WHERE v.tenant_id=$1 AND v.record_type='${row.type}' AND v.record_id=${row.id} AND v.field_id=${bind(field.id, 'uuid')})`;
}

/**
 * Stored list fields, keyed `custom:<id>`, for the custom fields of the row that `where` names.
 * Values are Luma-owned, so a row without a value is empty rather than unknown. Field IDs are
 * bound through `bind`, so only fields the query uses are bound.
 */
export function customFieldSql(
  row: CustomFieldRow,
  fields: readonly ListCustomField[],
  where: StoredWhere | undefined,
  bind: BindParameter,
): Record<string, StoredFieldSql> {
  const named = new Set(where?.conditions.map((condition) => condition.field));

  return Object.fromEntries(
    fields
      .filter((field) => named.has(`custom:${field.id}`))
      .map((field): [string, StoredFieldSql] => {
        const value = (column: string) => valueSql(row, field, column, bind);
        const name = `custom:${field.id}`;
        switch (field.type) {
          case 'text':
          case 'single_choice':
          case 'person':
            return [
              name,
              { kind: 'value', sql: value('v.text_value'), cast: 'text' },
            ];
          case 'number':
            return [
              name,
              { kind: 'value', sql: value('v.number_value'), cast: 'numeric' },
            ];
          case 'date':
            return [
              name,
              { kind: 'value', sql: value('v.date_value::date'), cast: 'date' },
            ];
          case 'boolean':
            return [name, { kind: 'flag', sql: value('v.boolean_value') }];
          case 'multi_choice':
            return [
              name,
              {
                kind: 'set',
                sql: `COALESCE(${value("ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(v.value)='array' THEN v.value ELSE '[]'::jsonb END))")},'{}'::text[])`,
              },
            ];
        }
      }),
  );
}

/**
 * The sort value of a custom field with one value, and its type for reading cursor keys back.
 * Text compares by its first 200 characters so cursor keys stay short. NULL when unset.
 */
export function customSortSql(
  row: CustomFieldRow,
  field: ListCustomField,
  bind: BindParameter,
): { sql: string; type: string } {
  const value = (column: string) => valueSql(row, field, column, bind);
  switch (field.type) {
    case 'number':
      return { sql: value('v.number_value'), type: 'numeric' };
    case 'date':
      return { sql: value('v.date_value::date'), type: 'date' };
    case 'boolean':
      return { sql: value('v.boolean_value'), type: 'boolean' };
    case 'multi_choice':
      throw new Error('Fields with several values cannot order rows');
    default:
      return { sql: `left(${value('v.text_value')},200)`, type: 'text' };
  }
}
