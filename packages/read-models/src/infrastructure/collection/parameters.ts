/** SQL type names the collection compiler binds values as. */
export type CollectionSqlCast =
  'text' | 'numeric' | 'integer' | 'boolean' | 'timestamptz' | 'uuid' | 'date';

/**
 * Appends values to a query's positional parameter list. Every compiled value goes through
 * `bind`, so request text never becomes SQL. Parameters already in `values` keep their numbers.
 */
export class SqlParameters {
  constructor(readonly values: unknown[]) {}

  /** Appends one value and returns its placeholder, cast to `cast` (a `[]` suffix binds an array). */
  bind(value: unknown, cast: CollectionSqlCast | `${CollectionSqlCast}[]`) {
    this.values.push(value);

    return `$${this.values.length}::${cast}`;
  }
}

/**
 * A 400 error whose message is shown to the person who made the request, such as an invalid
 * condition or a page link from another query.
 */
export function collectionQueryError(message: string) {
  return Object.assign(new Error(message), { statusCode: 400, expose: true });
}

/** Escapes LIKE wildcards and the escape character so text matches literally. */
export function likePattern(text: string) {
  return `%${text.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}
