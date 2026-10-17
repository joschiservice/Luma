import { createHash } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { canonicalJson, invalid, unavailable } from '@luma/platform';

import type { ViewReadAdapter, ViewReadResult } from '../application/views.js';
import type { AdaptiveRecordType, CustomField } from '../domain/fields.js';
import type {
  AdaptiveViewPreview,
  ViewExecutionQuery,
} from '../domain/views.js';
import { customFieldSchema } from './fields-validation.js';

const candidateLimit = 2000;
const pageLimit = 50;

function cursorScope(context: TenantContext, query: ViewExecutionQuery) {
  return createHash('sha256')
    .update(canonicalJson({ tenantId: context.tenantId, query }))
    .digest('hex');
}

function offsetFrom(cursor: unknown, scope: string) {
  if (cursor === undefined) return 0;
  if (typeof cursor !== 'string') throw invalid('Invalid view cursor.');
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString(),
    );
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('scope' in parsed) ||
      parsed.scope !== scope ||
      !('offset' in parsed) ||
      typeof parsed.offset !== 'number' ||
      !Number.isSafeInteger(parsed.offset) ||
      parsed.offset < 0 ||
      parsed.offset > candidateLimit
    )
      throw new Error();

    return parsed.offset;
  } catch {
    throw invalid(
      'The cursor belongs to a different query. Start from the first page.',
    );
  }
}

/**
 * Combines a complete, bounded owner query with tenant custom fields before final pagination.
 * Broad reads fail closed rather than presenting a filtered sample as a complete query.
 */
export function createAdaptiveViewReadAdapter(
  db: TenantDatabase,
  owner: ViewReadAdapter,
  options: { recordType?: AdaptiveRecordType; columns: readonly string[] },
): ViewReadAdapter {
  return {
    columns: options.columns,
    supportsCustomQueries:
      !!options.recordType || owner.supportsCustomQueries === true,
    supportsAggregates: true,
    async read(context, filters, query, selectedRecordIds) {
      if (
        owner.supportsCustomQueries &&
        !query.groupBy &&
        !query.metrics.length &&
        !query.charts.length
      ) {
        const result = await owner.read(
          context,
          filters,
          query,
          selectedRecordIds,
        );
        if (
          !options.recordType ||
          !query.columns.some((column) => column.startsWith('custom:'))
        )
          return result;

        return db.transaction(context.tenantId, async (tx) => {
          const fieldIds = query.columns
            .filter((column) => column.startsWith('custom:'))
            .map((column) => column.slice(7));
          const rows = await tx.query<{
            record_id: string;
            field_id: string;
            value: unknown;
            document: { readPermission: string };
          }>(
            `SELECT v.record_id,v.field_id,v.value,f.document FROM adaptive_field_values v JOIN adaptive_fields f ON f.tenant_id=v.tenant_id AND f.id=v.field_id WHERE v.tenant_id=$1 AND v.record_type=$2 AND v.record_id=ANY($3::uuid[]) AND v.field_id=ANY($4::uuid[]) AND NOT f.archived`,
            [
              context.tenantId,
              options.recordType,
              result.items.map((item) => item.id),
              fieldIds,
            ],
          );
          const additions = new Map<string, Record<string, unknown>>();
          for (const row of rows.rows)
            if (context.permissions.has(row.document.readPermission)) {
              const value = additions.get(row.record_id) ?? {};
              value[`custom:${row.field_id}`] = row.value;
              additions.set(row.record_id, value);
            }

          return {
            ...result,
            items: result.items.map((item) => ({
              ...item,
              ...(additions.get(String(item.id)) ?? {}),
            })),
          };
        });
      }
      const complex =
        !!query.customFilters.length ||
        !!query.sort?.field.startsWith('custom:') ||
        !!query.groupBy ||
        !!query.metrics.length ||
        !!query.charts.length ||
        !!selectedRecordIds?.length;
      if (
        !complex &&
        !query.columns.some((column) => column.startsWith('custom:'))
      )
        return owner.read(context, filters, query);
      const scope = cursorScope(context, query);
      const offset = offsetFrom(filters.cursor, scope);
      const records: Record<string, unknown>[] = [];
      const warnings: string[] = [];
      let next: string | undefined;
      let asOf = new Date().toISOString();
      const seen = new Set<string>();
      for (let page = 0; page < pageLimit; page++) {
        const nativeFilters = { ...filters };
        delete nativeFilters.cursor;
        if (next) nativeFilters.cursor = next;
        const result = await owner.read(context, nativeFilters, {
          ...query,
          customFilters: owner.supportsCustomQueries ? query.customFilters : [],
          sort: owner.supportsCustomQueries
            ? query.sort
            : query.sort?.field.startsWith('custom:')
              ? null
              : query.sort,
          groupBy: null,
          metrics: [],
          charts: [],
        });
        if (page === 0) asOf = result.asOf;
        else
          warnings.push(
            'Source pages were read independently. Records may change while this preview loads.',
          );
        records.push(...result.items);
        warnings.push(...(result.warnings ?? []));
        if (records.length > candidateLimit)
          throw invalid(
            'This query exceeds the 2,000-record aggregation limit. Add filters before using custom fields, grouping or metrics.',
          );
        if (!result.nextCursor) {
          next = undefined;
          break;
        }
        if (seen.has(result.nextCursor))
          throw unavailable('The record source could not finish this query.');
        seen.add(result.nextCursor);
        next = result.nextCursor;
      }
      if (next)
        throw invalid(
          'This query exceeds the bounded source-read limit. Add filters before using custom fields, grouping or metrics.',
        );
      // A record remains attributable to the owner; source summaries are never merged or summed.
      const unique = [
        ...new Map(
          records.map((record) => [String(record.id), record]),
        ).values(),
      ];

      return db.transaction(
        context.tenantId,
        async (tx): Promise<ViewReadResult> => {
          const definitions = options.recordType
            ? (
                await tx.query<{ document: unknown }>(
                  'SELECT document FROM adaptive_fields WHERE tenant_id=$1 AND record_type=$2 AND NOT archived',
                  [context.tenantId, options.recordType],
                )
              ).rows
                .map((row) => customFieldSchema.parse(row.document))
                .filter((field) =>
                  context.permissions.has(field.readPermission),
                )
            : [];
          const values: unknown[] = [
            context.tenantId,
            JSON.stringify(unique),
            options.recordType ?? null,
          ];
          const param = (value: unknown) => {
            values.push(value);

            return `$${values.length}`;
          };
          const joins: string[] = [];
          const fieldAliases = new Map<string, string>();

          function custom(fieldId: string) {
            let alias = fieldAliases.get(fieldId);
            if (alias) return alias;
            const field = definitions.find(
              (definition) => definition.id === fieldId,
            );
            if (!field) throw invalid('A custom field is unavailable.');
            alias = `f${fieldAliases.size}`;
            fieldAliases.set(fieldId, alias);
            joins.push(
              `LEFT JOIN adaptive_field_values ${alias} ON ${alias}.tenant_id=$1 AND ${alias}.record_type=$3 AND ${alias}.record_id=(r.document->>'id')::uuid AND ${alias}.field_id=${param(fieldId)}::uuid`,
            );

            return alias;
          }

          function expression(field: string, numeric = false) {
            if (field.startsWith('custom:')) {
              const definition = definitions.find(
                (item) => item.id === field.slice(7),
              );
              if (!definition) throw invalid('A custom field is unavailable.');
              const alias = custom(definition.id);
              if (numeric && definition.type !== 'number')
                throw invalid('Numeric metrics require a number field.');

              return numeric ? `${alias}.number_value` : `${alias}.value`;
            }
            if (!options.columns.includes(field))
              throw invalid('Unknown view field.');
            const key = param(field);

            return numeric
              ? `(CASE WHEN jsonb_typeof(r.document->${key}::text)='number' THEN (r.document->>${key}::text)::numeric END)`
              : `r.document->${key}::text`;
          }

          const predicates: string[] = [];
          for (const filter of query.customFilters) {
            const definition = definitions.find(
              (item) => item.id === filter.fieldId,
            );
            if (!definition)
              throw invalid('A filter references an unavailable custom field.');
            const alias = custom(filter.fieldId);
            if (filter.operator === 'is_empty') {
              predicates.push(
                `(${alias}.value IS NULL OR ${alias}.value='null'::jsonb)`,
              );
              continue;
            }
            if (filter.operator === 'contains') {
              if (definition.type === 'multi_choice')
                predicates.push(
                  `${alias}.value @> ${param(JSON.stringify([filter.value]))}::jsonb`,
                );
              else if (definition.type === 'text')
                predicates.push(
                  `strpos(${alias}.text_value,${param(filter.value)}::text)>0`,
                );
              else
                throw invalid(
                  'Contains requires text or multiple-choice fields.',
                );
              continue;
            }
            if (definition.type === 'multi_choice')
              throw invalid(
                'Multiple-choice filters use contains or is-empty.',
              );
            if (
              filter.value !== null &&
              ((definition.type === 'number' &&
                typeof filter.value !== 'number') ||
                (definition.type === 'boolean' &&
                  typeof filter.value !== 'boolean') ||
                (!['number', 'boolean'].includes(definition.type) &&
                  typeof filter.value !== 'string'))
            )
              throw invalid('The filter value does not match the field type.');
            if (
              filter.value === null &&
              !['eq', 'ne'].includes(filter.operator)
            )
              throw invalid('Only equality filters accept an empty value.');
            const operator = {
              eq: '=',
              ne: '<>',
              gt: '>',
              gte: '>=',
              lt: '<',
              lte: '<=',
            }[filter.operator];
            if (filter.value === null) {
              predicates.push(
                `COALESCE(${alias}.value,'null'::jsonb) ${operator} 'null'::jsonb`,
              );
              continue;
            }
            if (
              ['gt', 'gte', 'lt', 'lte'].includes(filter.operator) &&
              !['number', 'date'].includes(definition.type)
            )
              throw invalid('Range comparisons require number or date fields.');
            const column = fieldColumn(definition);
            predicates.push(
              `${alias}.${column} ${operator} ${param(filter.value)}`,
            );
          }
          if (selectedRecordIds?.length)
            predicates.push(
              `r.document->>'id'=ANY(${param(selectedRecordIds)}::text[])`,
            );
          const customColumns = query.columns
            .filter((column) => column.startsWith('custom:'))
            .map((column) => ({ column, id: column.slice(7) }))
            .filter((column) =>
              definitions.some((field) => field.id === column.id),
            );
          const additions = customColumns.flatMap(({ column, id }) => [
            `${param(column)}::text`,
            `COALESCE(${custom(id)}.value,'null'::jsonb)`,
          ]);
          const document = additions.length
            ? `r.document || jsonb_build_object(${additions.join(',')})`
            : 'r.document';
          const sort = query.sort?.field.startsWith('custom:')
            ? `${expression(query.sort.field)} ${query.sort.direction === 'asc' ? 'ASC' : 'DESC'} NULLS LAST,r.ordinal`
            : 'r.ordinal';
          const metricExpressions = query.metrics.map((metric) =>
            metric.field ? expression(metric.field, true) : null,
          );
          const groupExpression = query.groupBy
            ? expression(query.groupBy)
            : null;
          const chartExpressions = query.charts.map((chart) =>
            expression(chart.groupBy),
          );
          const where = [
            '$1::uuid IS NOT NULL',
            '$3::text IS NOT DISTINCT FROM $3::text',
            ...predicates,
          ].join(' AND ');
          const cte = `WITH filtered AS MATERIALIZED (SELECT ${document} AS document,r.ordinal${metricExpressions.map((value, index) => (value ? `,${value} AS m${index}` : '')).join('')}${groupExpression ? `,${groupExpression} AS group_value` : ''}${chartExpressions.map((value, index) => `,${value} AS c${index}`).join('')} FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY r(document,ordinal) ${joins.join(' ')} WHERE ${where})`;
          const rowSql = `${cte} SELECT ${document} AS document FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY r(document,ordinal) ${joins.join(' ')} WHERE ${where} ORDER BY ${sort} LIMIT ${param(51)} OFFSET ${param(offset)}`;
          const rows = await tx.query<{ document: Record<string, unknown> }>(
            rowSql,
            values,
          );
          const aggregateValues = values.slice(0, -2);
          const result = await tx.query<{ count: number }>(
            `${cte} SELECT count(*)::int AS count FROM filtered`,
            aggregateValues,
          );
          const aggregates: AdaptiveViewPreview['aggregates'] = [];
          const metricOperation = (index: number) =>
            query.metrics[index]!.operation === 'count'
              ? 'count(*)'
              : `${query.metrics[index]!.operation === 'sum' ? 'sum' : 'avg'}(${metricExpressions[index] ? `m${index}` : 'NULL::numeric'})`;
          for (let index = 0; index < query.metrics.length; index++) {
            const answer = await tx.query<{ value: string | null }>(
              `${cte} SELECT ${metricOperation(index)}::text AS value FROM filtered`,
              aggregateValues,
            );
            const value = answer.rows[0]?.value;
            aggregates.push({
              metricId: query.metrics[index]!.id,
              value:
                value === null || value === undefined ? null : Number(value),
              complete: warnings.length === 0,
            });
          }
          const groups: AdaptiveViewPreview['groups'] = [];
          if (groupExpression) {
            const result = await tx.query<{ key: unknown; count: number }>(
              `${cte} SELECT group_value AS key,count(*)::int AS count FROM filtered GROUP BY group_value ORDER BY count(*) DESC,group_value LIMIT 101`,
              aggregateValues,
            );
            groups.push(...result.rows.slice(0, 100));
            if (result.rows.length > 100)
              warnings.push(
                'Grouping contains more than 100 groups. Refine the query to display all groups.',
              );
          }
          const chartSeries: AdaptiveViewPreview['chartSeries'] = [];
          for (let index = 0; index < query.charts.length; index++) {
            const chart = query.charts[index]!;
            const metricIndex = query.metrics.findIndex(
              (metric) => metric.id === chart.metricId,
            );
            const result = await tx.query<{
              key: unknown;
              value: string | null;
              count: number;
            }>(
              `${cte} SELECT c${index} AS key,${metricOperation(metricIndex)}::text AS value,count(*)::int AS count FROM filtered GROUP BY c${index} ORDER BY c${index} LIMIT 101`,
              aggregateValues,
            );
            chartSeries.push({
              id: chart.id,
              points: result.rows.slice(0, 100).map((point) => ({
                ...point,
                value: point.value === null ? null : Number(point.value),
              })),
              truncated: result.rows.length > 100,
              complete: warnings.length === 0,
            });
          }
          const hasMore = rows.rows.length > 50;

          return {
            items: rows.rows.slice(0, 50).map((row) => row.document),
            nextCursor: hasMore
              ? Buffer.from(
                  JSON.stringify({ scope, offset: offset + 50 }),
                ).toString('base64url')
              : null,
            asOf,
            totalCount: result.rows[0]?.count ?? 0,
            warnings: [...new Set(warnings)],
            aggregates,
            groups,
            chartSeries,
          };
        },
      );
    },
  };
}

function fieldColumn(field: CustomField) {
  return field.type === 'number'
    ? 'number_value'
    : field.type === 'date'
      ? 'date_value'
      : field.type === 'boolean'
        ? 'boolean_value'
        : field.type === 'multi_choice'
          ? 'value'
          : 'text_value';
}
