import { createHash } from 'node:crypto';

import type { AuditLog } from '@luma/audit';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';
import { canonicalJson, notFound } from '@luma/platform';

import type {
  CustomFieldEvent,
  CustomFieldQuery,
  FieldsStore,
} from '../application/fields.js';
import type {
  AdaptiveRecordType,
  CustomField,
  CustomFieldRecordValue,
} from '../domain/fields.js';
import {
  customFieldSchema,
  customFieldValueSchema,
} from './fields-validation.js';

/** Produces a bounded SQL query with indexed field predicates before pagination. */
export function customFieldQuerySql(
  tenantId: string,
  input: CustomFieldQuery,
  definitions: CustomField[],
) {
  const values: unknown[] = [tenantId, input.recordType];
  const param = (value: unknown) => {
    values.push(value);

    return `$${values.length}`;
  };
  const records = recordRelation(input.recordType);
  const predicates = [
    `r.tenant_id=$1`,
    ...(records.kind ? [`r.kind='${records.kind}'`] : []),
  ];
  for (const filter of input.filters ?? []) {
    const field = definitions.find((f) => f.id === filter.fieldId)!;
    const fieldId = param(filter.fieldId);
    const base = `v.tenant_id=$1 AND v.record_type=$2 AND v.field_id=${fieldId} AND v.record_id=r.id`;
    if (filter.operator === 'is_empty') {
      predicates.push(
        `NOT EXISTS (SELECT 1 FROM adaptive_field_values v WHERE ${base} AND v.value<>'null'::jsonb)`,
      );
      continue;
    }
    const column =
      field.type === 'number'
        ? 'number_value'
        : field.type === 'boolean'
          ? 'boolean_value'
          : field.type === 'date'
            ? 'date_value'
            : 'text_value';
    const operators = {
      eq: '=',
      ne: '<>',
      gt: '>',
      gte: '>=',
      lt: '<',
      lte: '<=',
      contains: '@>',
    } as const;
    const operator = operators[filter.operator];
    const value = param(
      filter.operator === 'contains'
        ? JSON.stringify([filter.value])
        : field.type === 'multi_choice'
          ? JSON.stringify(filter.value)
          : filter.value,
    );
    predicates.push(
      `EXISTS (SELECT 1 FROM adaptive_field_values v WHERE ${base} AND ${filter.operator === 'contains' ? `v.value @> ${value}::jsonb` : field.type === 'multi_choice' ? `v.value ${operator} ${value}::jsonb` : filter.value === null ? `v.value ${operator} 'null'::jsonb` : `v.${column} ${operator} ${value}`})`,
    );
  }
  const filterValues = [...values];
  let join = '';
  let sort = 'r.id';
  if (input.sort) {
    const field = definitions.find((f) => f.id === input.sort!.fieldId)!;
    const column =
      field.type === 'number'
        ? 'number_value'
        : field.type === 'boolean'
          ? 'boolean_value'
          : field.type === 'date'
            ? 'date_value'
            : field.type === 'multi_choice'
              ? 'value'
              : 'text_value';
    join = `LEFT JOIN adaptive_field_values s ON s.tenant_id=$1 AND s.record_type=$2 AND s.record_id=r.id AND s.field_id=${param(field.id)}`;
    sort = `s.${column} ${input.sort.direction === 'asc' ? 'ASC' : 'DESC'} NULLS LAST,r.id`;
  }
  const where = predicates.join(' AND ');
  const limit = input.limit ?? 50;
  const rows = {
    sql: `SELECT r.id FROM ${records.table} r ${join} WHERE ${where} ORDER BY ${sort} LIMIT ${param(limit + 1)} OFFSET ${param(input.offset ?? 0)}`,
    values: [...values],
  };
  let groups: { sql: string; values: unknown[] } | undefined;
  if (input.groupBy) {
    // Group counts include unset values and use the same unpaginated predicates.
    const groupValues = [...filterValues];
    groupValues.push(input.groupBy);
    groups = {
      sql: `SELECT COALESCE(g.value,'null'::jsonb) AS value,count(*)::int AS count FROM ${records.table} r LEFT JOIN adaptive_field_values g ON g.tenant_id=$1 AND g.record_type=$2 AND g.record_id=r.id AND g.field_id=$${groupValues.length} WHERE ${where} GROUP BY COALESCE(g.value,'null'::jsonb) ORDER BY count(*) DESC,COALESCE(g.value,'null'::jsonb) LIMIT 100`,
      values: groupValues,
    };
  }

  return { rows, groups };
}

function recordRelation(type: AdaptiveRecordType) {
  switch (type) {
    case 'order':
      return { table: 'orders_entities', kind: 'order' };
    case 'product':
      return { table: 'inventory_entities', kind: 'sku' };
    case 'supplier':
      return { table: 'procurement_suppliers', kind: null };
    case 'purchase_order':
      return { table: 'procurement_purchase_orders', kind: null };
    case 'customer':
      // Each source customer is its own record; values follow that profile.
      return { table: 'customer_profiles', kind: null };
  }
}

/** Persists fields and append-only history under the restricted adaptive runtime role. */
export function createFieldsStore(
  db: TenantDatabase,
  audit?: (db: TenantDatabase) => AuditLog,
): FieldsStore {
  return {
    transaction: (tenantId, write, run) =>
      db.transaction(tenantId, async (tx) => {
        if (write)
          await tx.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1,19))',
            [tenantId],
          );
        const list = async (recordType: AdaptiveRecordType, archived = false) =>
          (
            await tx.query<{ document: unknown }>(
              'SELECT document FROM adaptive_fields WHERE tenant_id=$1 AND record_type=$2 AND ($3 OR NOT archived) ORDER BY created_at,id',
              [tenantId, recordType, archived],
            )
          ).rows.map((row) => customFieldSchema.parse(row.document));
        const values = async (type: AdaptiveRecordType, id: string) =>
          (
            await tx.query<{ document: CustomFieldRecordValue }>(
              'SELECT document FROM adaptive_field_values WHERE tenant_id=$1 AND record_type=$2 AND record_id=$3 ORDER BY field_id',
              [tenantId, type, id],
            )
          ).rows.map((row) => ({
            ...row.document,
            value: customFieldValueSchema.parse(row.document.value),
          }));

        return run({
          effect: async (id) => {
            const row = (
              await tx.query<{
                digest: string;
                result: CustomFieldRecordValue;
              }>(
                'SELECT digest,result FROM adaptive_field_effects WHERE tenant_id=$1 AND id=$2',
                [tenantId, id],
              )
            ).rows[0];

            return row ?? null;
          },
          saveEffect: async (id, digest, result) => {
            await tx.query(
              'INSERT INTO adaptive_field_effects(tenant_id,id,digest,result) VALUES($1,$2,$3,$4::jsonb)',
              [tenantId, id, digest, JSON.stringify(result)],
            );
          },
          command: async (id) => {
            const row = (
              await tx.query<{ digest: string; result: unknown }>(
                'SELECT digest,result FROM adaptive_field_commands WHERE tenant_id=$1 AND id=$2',
                [tenantId, id],
              )
            ).rows[0];

            return row
              ? {
                  digest: row.digest,
                  result: customFieldSchema.parse(row.result),
                }
              : null;
          },
          saveCommand: async (id, digest, result) => {
            await tx.query(
              'INSERT INTO adaptive_field_commands(tenant_id,id,digest,result) VALUES($1,$2,$3,$4::jsonb)',
              [tenantId, id, digest, JSON.stringify(result)],
            );
          },
          list,
          get: async (id) => {
            const result = await tx.query<{ document: unknown }>(
              'SELECT document FROM adaptive_fields WHERE tenant_id=$1 AND id=$2',
              [tenantId, id],
            );

            return result.rows[0]
              ? customFieldSchema.parse(result.rows[0].document)
              : null;
          },
          save: async (field) => {
            await tx.query(
              `INSERT INTO adaptive_fields(tenant_id,id,record_type,field_key,field_type,archived,source,document,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT(tenant_id,id) DO UPDATE SET field_type=EXCLUDED.field_type,archived=EXCLUDED.archived,document=EXCLUDED.document`,
              [
                tenantId,
                field.id,
                field.recordType,
                field.key,
                field.type,
                field.archived,
                field.source,
                JSON.stringify(field),
                field.createdAt,
              ],
            );
          },
          hasValues: async (id) =>
            Boolean(
              (
                await tx.query(
                  "SELECT 1 FROM adaptive_field_values WHERE tenant_id=$1 AND field_id=$2 AND value<>'null'::jsonb LIMIT 1",
                  [tenantId, id],
                )
              ).rows.length,
            ),
          recordExists: async (type, id) => {
            const relation = recordRelation(type);

            return Boolean(
              (
                await tx.query(
                  `SELECT 1 FROM ${relation.table} WHERE tenant_id=$1 AND id=$2 ${relation.kind ? `AND kind='${relation.kind}'` : ''}`,
                  [tenantId, id],
                )
              ).rows.length,
            );
          },
          personExists: async (id) =>
            Boolean(
              (
                await tx.query(
                  "SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active'",
                  [tenantId, id],
                )
              ).rows.length,
            ),
          values,
          valuesMany: async (type, ids) =>
            (
              await tx.query<{
                record_id: string;
                document: CustomFieldRecordValue;
              }>(
                'SELECT record_id,document FROM adaptive_field_values WHERE tenant_id=$1 AND record_type=$2 AND record_id=ANY($3::uuid[]) ORDER BY record_id,field_id',
                [tenantId, type, ids],
              )
            ).rows.map((row) => ({
              ...row.document,
              recordId: row.record_id,
              value: customFieldValueSchema.parse(row.document.value),
            })),
          setValue: async (type, id, value) => {
            await tx.query(
              `INSERT INTO adaptive_field_values(tenant_id,record_type,record_id,field_id,value,document) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb) ON CONFLICT(tenant_id,record_type,record_id,field_id) DO UPDATE SET value=EXCLUDED.value,document=EXCLUDED.document`,
              [
                tenantId,
                type,
                id,
                value.fieldId,
                JSON.stringify(value.value),
                JSON.stringify(value),
              ],
            );
          },
          event: async (event) => {
            await insertEvent(tx, tenantId, event);
            if (audit)
              await audit({
                transaction: async (tenant, work) => {
                  if (tenant !== tenantId)
                    throw notFound('Workspace not found.');

                  return work(tx);
                },
              }).append({
                id: event.id,
                tenantId,
                eventKey: `adaptive-field:${event.id}`,
                eventType: `adaptive.field.${event.kind}`,
                schemaVersion: 1,
                occurredAt: event.occurredAt,
                actor: { kind: 'user', id: event.actorId },
                correlationId: event.id,
                proposalId: event.fieldId,
                actionHash: createHash('sha256')
                  .update(canonicalJson(event))
                  .digest('hex'),
                evidenceRefs: [],
                details: {
                  fieldId: event.fieldId,
                  recordId: event.recordId ?? '',
                  kind: event.kind,
                },
              });
          },
          history: async (fieldId, recordId) =>
            (
              await tx.query<{ document: CustomFieldEvent }>(
                'SELECT document FROM adaptive_field_events WHERE tenant_id=$1 AND field_id=$2 AND record_id IS NOT DISTINCT FROM $3::uuid ORDER BY occurred_at DESC,id DESC LIMIT 100',
                [tenantId, fieldId, recordId],
              )
            ).rows.map((row) => row.document),
          query: async (input, definitions) => {
            const query = customFieldQuerySql(tenantId, input, definitions);
            const result = await tx.query<{ id: string }>(
              query.rows.sql,
              query.rows.values,
            );
            const groups = query.groups
              ? (
                  await tx.query<{ value: unknown; count: number }>(
                    query.groups.sql,
                    query.groups.values,
                  )
                ).rows.map((row) => ({
                  value: customFieldValueSchema.parse(row.value),
                  count: row.count,
                }))
              : [];

            return {
              recordIds: result.rows
                .slice(0, input.limit ?? 50)
                .map((row) => row.id),
              groups,
              hasMore: result.rows.length > (input.limit ?? 50),
            };
          },
        });
      }),
  };
}

async function insertEvent(
  tx: SqlTransaction,
  tenantId: string,
  event: CustomFieldEvent,
) {
  await tx.query(
    'INSERT INTO adaptive_field_events(tenant_id,id,field_id,record_id,actor_id,occurred_at,document) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
    [
      tenantId,
      event.id,
      event.fieldId,
      event.recordId,
      event.actorId,
      event.occurredAt,
      JSON.stringify(event),
    ],
  );
}
