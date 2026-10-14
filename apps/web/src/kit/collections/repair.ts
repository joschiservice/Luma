import {
  type CollectionCatalog,
  collectionField,
  type CollectionViewState,
} from '@luma/api-contract';

/**
 * Removes what a view asks for that the reader's list can't do. Conditions with a known problem
 * go; a problem the list couldn't tie to one condition (a grouping or sort it refused, or a
 * custom field the reader may not read) removes the grouping, a custom sort and custom-field
 * conditions instead, keeping the other conditions so the view never matches more than needed.
 */
export function repairedState(
  catalog: CollectionCatalog,
  state: CollectionViewState,
  issues: readonly { index: number | null }[],
  can: (permission: string) => boolean,
): CollectionViewState {
  const broken = new Set(issues.map((issue) => issue.index));
  const general = broken.has(null);
  const usable = (field: string) => {
    const definition = collectionField(catalog, field);

    return !definition?.permission || can(definition.permission);
  };
  const group =
    state.group && usable(state.group.field) && !general ? state.group : null;

  return {
    ...state,
    where: {
      match: state.where.match,
      conditions: state.where.conditions.filter(
        (condition, index) =>
          !broken.has(index) &&
          !(general && condition.field.startsWith('custom:')),
      ),
    },
    sort:
      general && state.sort?.field.startsWith('custom:')
        ? catalog.defaultSort
        : state.sort,
    group,
    layout: !group && state.layout === 'board' ? 'table' : state.layout,
  };
}
