import type { StoredCondition, StoredWhere } from '../application/lists.js';

/**
 * How one stored list field reads in SQL. `value`: one value per row, null when the record has
 * none; `date` values are calendar days. `lines`: one value per purchase-order line in the JSON
 * array `from`, read through `l`; the row matches when any line does and negative operators
 * when none does. `set`: a text array that is empty, never null, without values. `flag`: a
 * boolean predicate; null matches neither true nor false.
 */
export type StoredFieldSql =
  | {
      kind: 'value';
      sql: string;
      cast: 'text' | 'uuid' | 'timestamptz' | 'numeric' | 'date';
    }
  | { kind: 'lines'; from: string; sql: string }
  | { kind: 'set'; sql: string }
  | { kind: 'flag'; sql: string };

/** Binds `value` as the next query parameter and returns its cast placeholder. */
export type BindParameter = (value: unknown, cast: string) => string;

/** Escapes ILIKE wildcards so text matches literally. */
export const likePattern = (text: string) =>
  `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

function linesPredicate(
  field: Extract<StoredFieldSql, { kind: 'lines' }>,
  condition: StoredCondition,
  bind: BindParameter,
) {
  const exists = (test: string) =>
    `EXISTS(SELECT 1 FROM jsonb_array_elements(${field.from}) l WHERE ${test})`;
  const value = field.sql;
  switch (condition.op) {
    case 'any_of':
      return exists(`${value}=ANY(${bind(condition.values, 'text[]')})`);
    case 'none_of':
      return `NOT ${exists(`${value}=ANY(${bind(condition.values, 'text[]')})`)}`;
    case 'empty':
      return `NOT ${exists(`${value} IS NOT NULL`)}`;
    case 'not_empty':
      return exists(`${value} IS NOT NULL`);
    case 'contains':
      return exists(
        `${value} ILIKE ${bind(likePattern(condition.text), 'text')}`,
      );
    case 'not_contains':
      return `NOT ${exists(`${value} ILIKE ${bind(likePattern(condition.text), 'text')}`)}`;
    case 'is':
      return exists(`${value}=${bind(condition.text, 'text')}`);
    case 'is_not':
      return `NOT ${exists(`${value}=${bind(condition.text, 'text')}`)}`;
    default:
      throw new Error(`Unsupported stored line condition ${condition.op}`);
  }
}

function setPredicate(
  sql: string,
  condition: StoredCondition,
  bind: BindParameter,
) {
  switch (condition.op) {
    case 'any_of':
      return `${sql} && ${bind(condition.values, 'text[]')}`;
    case 'all_of':
      return `${sql} @> ${bind(condition.values, 'text[]')}`;
    case 'none_of':
      return `NOT (${sql} && ${bind(condition.values, 'text[]')})`;
    case 'empty':
      return `cardinality(${sql})=0`;
    case 'not_empty':
      return `cardinality(${sql})>0`;
    default:
      throw new Error(`Unsupported stored set condition ${condition.op}`);
  }
}

const comparisonSql = {
  eq: '=',
  ne: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
} as const;

function valuePredicate(
  field: Extract<StoredFieldSql, { kind: 'value' }>,
  condition: StoredCondition,
  bind: BindParameter,
) {
  const { sql, cast } = field;
  switch (condition.op) {
    case 'any_of':
      return `COALESCE(${sql}=ANY(${bind(condition.values, `${cast}[]`)}),false)`;
    case 'none_of':
      return `NOT COALESCE(${sql}=ANY(${bind(condition.values, `${cast}[]`)}),false)`;
    case 'empty':
      return `${sql} IS NULL`;
    case 'not_empty':
      return `${sql} IS NOT NULL`;
    case 'contains':
      return `COALESCE(${sql} ILIKE ${bind(likePattern(condition.text), 'text')},false)`;
    case 'not_contains':
      return `NOT COALESCE(${sql} ILIKE ${bind(likePattern(condition.text), 'text')},false)`;
    case 'is':
      return `COALESCE(${sql}=${bind(condition.text, 'text')},false)`;
    case 'is_not':
      return `NOT COALESCE(${sql}=${bind(condition.text, 'text')},false)`;
    case 'compare':
      // Comparisons never match rows without a value.
      return condition.comparisons.length
        ? `COALESCE(${condition.comparisons
            .map(
              (comparison) =>
                `${sql} ${comparisonSql[comparison.op]} ${bind(comparison.value, 'numeric')}`,
            )
            .join(' AND ')},false)`
        : `${sql} IS NOT NULL`;
    case 'range': {
      const bound = cast === 'date' ? 'date' : 'timestamptz';
      const parts = [
        ...(condition.from
          ? [
              `${sql} ${condition.from.inclusive ? '>=' : '>'} ${bind(condition.from.at, bound)}`,
            ]
          : []),
        ...(condition.to
          ? [
              `${sql} ${condition.to.inclusive ? '<=' : '<'} ${bind(condition.to.at, bound)}`,
            ]
          : []),
      ];

      return parts.length ? parts.join(' AND ') : `${sql} IS NOT NULL`;
    }
    default:
      throw new Error(`Unsupported stored condition ${condition.op}`);
  }
}

/**
 * Compiles resolved stored conditions into one SQL predicate over `fields`. Every value is
 * bound as a parameter through `bind`; SQL comes only from the trusted field map. Returns
 * `true` without conditions. Throws for fields or operators the map does not support, which
 * the application's field definitions rule out.
 */
export function storedWhereSql(
  where: StoredWhere | undefined,
  fields: Readonly<Record<string, StoredFieldSql>>,
  bind: BindParameter,
): string {
  if (!where?.conditions.length) return 'true';
  const predicates = where.conditions.map((condition) => {
    const field = Object.hasOwn(fields, condition.field)
      ? fields[condition.field]
      : undefined;
    if (!field)
      throw new Error(`Unsupported stored list field ${condition.field}`);
    if (field.kind === 'flag') {
      if (condition.op !== 'flag')
        throw new Error(`Unsupported stored flag condition ${condition.op}`);

      return condition.value ? `(${field.sql})` : `NOT (${field.sql})`;
    }

    return `(${
      field.kind === 'lines'
        ? linesPredicate(field, condition, bind)
        : field.kind === 'set'
          ? setPredicate(field.sql, condition, bind)
          : valuePredicate(field, condition, bind)
    })`;
  });

  return `(${predicates.join(where.match === 'any' ? ' OR ' : ' AND ')})`;
}
