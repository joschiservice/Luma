import type { TenantContext } from '@luma/identity';
import type { SqlTransaction } from '@luma/platform';
import { forbidden } from '@luma/platform';

import type { CollectionSortSql } from './keyset.js';
import type { SqlParameters } from './parameters.js';
import { collectionQueryError } from './parameters.js';
import type { CollectionFieldMap } from './where.js';

interface FieldRow extends Record<string, unknown> {
  id: string;
  field_type: string;
  document: { readPermission?: unknown };
}

/** Record types whose lists filter and sort by custom fields, with the list row's record ID. */
export type CustomFieldRecord =
  | { type: 'order'; id: 'o.entity_id' }
  | { type: 'customer'; id: 'o.id' }
  | { type: 'product'; id: 'o.sku_id' };

/** Field IDs a query names as `custom:<id>`, in order of first use. */
export function customFieldIds(names: readonly string[]): string[] {
  return [
    ...new Set(
      names
        .filter((name) => name.startsWith('custom:'))
        .map((name) => name.slice(7)),
    ),
  ];
}

/**
 * Custom fields of one record type as condition and sort SQL over the list row `o`, whose
 * record ID is `record.id`. Each field must exist, be live and be readable by the reader:
 * archived or unknown fields return 400 so the view reports that it needs repair, and fields
 * behind another permission return 403. Values are Luma-owned, so a missing value is empty
 * rather than unknown. The tenant must be bound as `$1`.
 */
export async function collectionCustomFields(
  tx: SqlTransaction,
  context: TenantContext,
  record: CustomFieldRecord,
  ids: readonly string[],
  parameters: SqlParameters,
  timeZone: string,
): Promise<{
  fields: CollectionFieldMap;
  sorts: Readonly<Record<string, CollectionSortSql>>;
}> {
  const rows = (
    await tx.query<FieldRow>(
      'SELECT id,field_type,document FROM adaptive_fields WHERE tenant_id=$1 AND record_type=$2 AND NOT archived AND id=ANY($3::uuid[])',
      [context.tenantId, record.type, ids],
    )
  ).rows;
  const fields: Record<string, CollectionFieldMap[string]> = {};
  const sorts: Record<string, CollectionSortSql> = {};
  for (const id of ids) {
    const row = rows.find((item) => item.id === id);
    if (!row) throw collectionQueryError('A custom field is unavailable');
    const permission = row.document.readPermission;
    if (typeof permission !== 'string' || !context.permissions.has(permission))
      throw forbidden('Your role cannot use one of these custom fields.');
    const field = parameters.bind(id, 'uuid');
    const value = (column: string) =>
      `(SELECT ${column} FROM adaptive_field_values v WHERE v.tenant_id=$1 AND v.record_type='${record.type}' AND v.record_id=${record.id} AND v.field_id=${field})`;
    const name = `custom:${id}`;
    const scalar = (
      type: CollectionFieldMap[string]['type'],
      sql: string,
      cast: 'text' | 'numeric' | 'boolean' | 'timestamptz',
    ) => {
      fields[name] = { type, sql, cast };
      sorts[name] = {
        present: `${sql} IS NOT NULL`,
        missing: `${sql} IS NULL`,
        // Text values can hold 4,000 characters; cursors keep at most 200 per key.
        keys: [{ sql: cast === 'text' ? `left(${sql},200)` : sql, cast }],
      };
    };
    switch (row.field_type) {
      case 'text':
        scalar('text', value('v.text_value'), 'text');
        break;
      case 'single_choice':
        scalar('enum', value('v.text_value'), 'text');
        break;
      case 'person':
        scalar('person', value('v.text_value'), 'text');
        break;
      case 'number':
        scalar('number', value('v.number_value'), 'numeric');
        break;
      case 'boolean':
        scalar('boolean', value('v.boolean_value'), 'boolean');
        break;
      case 'date':
        // Dates are calendar days in the workspace; compare them as that day's start.
        scalar(
          'date',
          value(
            `(v.date_value::timestamp AT TIME ZONE ${parameters.bind(timeZone, 'text')})`,
          ),
          'timestamptz',
        );
        break;
      case 'multi_choice':
        fields[name] = {
          type: 'tags',
          sql: `COALESCE(${value("ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(v.value)='array' THEN v.value ELSE '[]'::jsonb END))")},'{}'::text[])`,
        };
        break;
      default:
        throw collectionQueryError('A custom field is unavailable');
    }
  }

  return { fields, sorts };
}

/** The sort of a custom field the query loaded; multiple-choice fields cannot order rows. */
export function customSort(
  sorts: Readonly<Record<string, CollectionSortSql>> | undefined,
  sort: string,
): CollectionSortSql {
  const found = sorts?.[sort];
  if (!found)
    throw collectionQueryError('This custom field cannot order the list');

  return found;
}
