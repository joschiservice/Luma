import type { CollectionCondition } from '../../application/collections.js';
import { collectionQueryError } from './parameters.js';
import {
  type CollectionCompileContext,
  type CollectionFieldMap,
  type CollectionFieldSql,
  compileWhere,
} from './where.js';

/** A field every source of a record reports separately, as SQL over one source row. */
export interface SourceFieldSql extends CollectionFieldSql {
  /**
   * Quantities only: an aggregate over the record's source rows giving the lowest reported
   * value, for the `lowest` scope. Sources without a value are ignored.
   */
  lowest?: string;
}

/**
 * Compiles conditions on per-source fields into boolean aggregate columns over a record's
 * source rows, so one grouped pass evaluates every scope:
 *
 * - no scope or `any`: some source reports a value that matches;
 * - `every`: every source reports a value and each matches;
 * - a connection ID: that source reports a matching value (no match when it has none);
 * - `lowest`: the lowest value any source reports matches (quantities only).
 *
 * Missing and unknown values follow the shared condition rules within each source, so a
 * source without a value never satisfies a comparison and never counts as zero.
 */
export class SourceConditions {
  /** Aggregate select-list entries, in the order conditions were compiled. */
  readonly columns: string[] = [];

  /**
   * Collects aggregates over source rows whose connection ID is the SQL `connection`. The record
   * row reads the generated columns as `o.<prefix><n>`.
   */
  constructor(
    private readonly connection: string,
    private readonly prefix = 'scoped_',
  ) {}

  /** Wraps per-source fields so their conditions compile into aggregate columns of `o`. */
  fields(fields: Readonly<Record<string, SourceFieldSql>>): CollectionFieldMap {
    return Object.fromEntries(
      Object.entries(fields).map(([id, field]) => [
        id,
        {
          type: field.type,
          predicate: (condition, context) =>
            this.column(this.aggregate(id, field, condition, context)),
        } satisfies CollectionFieldSql,
      ]),
    );
  }

  /** The select-list fragment adding every compiled aggregate, with a leading comma. */
  select() {
    return this.columns
      .map((sql, index) => `,${sql} AS ${this.prefix}${index}`)
      .join('');
  }

  private column(sql: string) {
    this.columns.push(sql);

    return `o.${this.prefix}${this.columns.length - 1}`;
  }

  private aggregate(
    id: string,
    field: SourceFieldSql,
    condition: CollectionCondition,
    context: CollectionCompileContext,
  ) {
    const { source, ...rest } = condition;
    const { lowest, ...row } = field;
    const compile = (value: CollectionFieldSql) =>
      compileWhere(
        { match: 'all', conditions: [rest] },
        { [id]: value },
        context,
      ).sql;
    if (source === 'lowest') {
      if (!lowest)
        throw collectionQueryError(
          'Only quantities can use the lowest value of all sources',
        );

      return `COALESCE(${compile({ ...row, sql: lowest })},false)`;
    }
    const predicate = compile(row);
    if (source === 'every')
      return `COALESCE(bool_and(COALESCE(${predicate},false)),false)`;
    if (source !== undefined && source !== 'any')
      return `COALESCE(bool_or(${predicate}) FILTER (WHERE ${this.connection}=${context.parameters.bind(source, 'uuid')}),false)`;

    return `COALESCE(bool_or(${predicate}),false)`;
  }
}
