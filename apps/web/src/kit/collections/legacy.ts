import type { CollectionCondition, CollectionWhere } from '@luma/api-contract';

/**
 * Adds conditions converted from the filters of older links to the URL's conditions. They must
 * all hold, so conditions that match "any" are replaced only when they can't be combined: one
 * condition matches the same under either rule.
 */
export function withLegacyConditions(
  where: CollectionWhere | undefined,
  legacy: readonly CollectionCondition[],
): CollectionWhere {
  const current = where?.conditions ?? [];
  const kept = where?.match === 'any' && current.length > 1 ? [] : current;

  return { match: 'all', conditions: [...kept, ...legacy].slice(0, 20) };
}

/** An "is any of" condition for one value of an older link's filter. */
export function anyOf(field: string, value: string): CollectionCondition {
  return { field, op: 'any_of', value: [value] };
}
