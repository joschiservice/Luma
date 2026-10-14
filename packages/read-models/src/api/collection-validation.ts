import {
  type CollectionCatalog,
  collectionGroupIssue,
  type CollectionWhere,
  collectionWhereIssues,
} from '@luma/api-contract';

/** The configurable part of a list query as the API contract parses it. */
interface CollectionQuery {
  where?: CollectionWhere | undefined;
  group?:
    | { field: string; granularity?: 'day' | 'week' | 'month' | undefined }
    | undefined;
  groupKey?: unknown;
}

/**
 * Checks conditions and grouping against a list catalog before the read model compiles them.
 * Throws a 400 error naming the first invalid condition or grouping. Field permissions are
 * checked by the workspace with the reader's current permissions, which answers 403. With
 * `customFields`, the read model checks custom-field conditions (`custom:<id>`) against the
 * workspace's live definitions, so they are skipped here and keep their positions in errors.
 */
export function validateCollectionQuery(
  catalog: CollectionCatalog,
  query: CollectionQuery,
  options: { customFields?: boolean } = {},
) {
  const checked = (query.where?.conditions ?? [])
    .map((condition, index) => ({ condition, index }))
    .filter(
      ({ condition }) =>
        !options.customFields || !condition.field.startsWith('custom:'),
    );
  const found = checked.length
    ? collectionWhereIssues(catalog, {
        match: query.where?.match ?? 'all',
        conditions: checked.map(({ condition }) => condition),
      })[0]
    : undefined;
  const issue = found && {
    ...found,
    index: found.index === null ? null : (checked[found.index]?.index ?? null),
  };
  const message = issue
    ? `Condition ${(issue.index ?? 0) + 1}: ${issue.message}.`
    : query.group
      ? collectionGroupIssue(
          catalog,
          query.group.field,
          query.group.granularity,
        )
      : query.groupKey !== undefined
        ? 'Choose a grouping to read one group'
        : null;
  if (message)
    throw Object.assign(
      new Error(message.endsWith('.') ? message : `${message}.`),
      { statusCode: 400, expose: true },
    );
}
