import type {
  CollectionCatalog,
  CollectionCondition,
  CollectionWhere,
} from '@luma/api-contract';
import { collectionWhereIssues } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import {
  CollectionDisplay,
  type DisplayColumn,
} from '@luma/ui/components/primitives/collection-display';
import type { CollectionFilter } from '@luma/ui/components/primitives/collection-filters';
import type { CollectionSort } from '@luma/ui/components/primitives/collection-toolbar';
import type { CollectionConditions } from '@luma/ui/components/primitives/condition-builder';
import type { DataTableColumnState } from '@luma/ui/components/primitives/data-table';
import { WorkspaceTimezone } from '@luma/ui/components/primitives/workspace-date';
import { workspaceDateValue } from '@luma/ui/lib/timezone';
import { useQuery } from '@tanstack/react-query';
import { UserRound } from 'lucide-react';
import { type ReactNode, useContext, useMemo, useState } from 'react';

import { sessionOptions } from '../identity/data';
import {
  type CatalogPresentation,
  conditionFields,
  type CustomFieldColumn,
  displayColumns,
  groupFields,
  grouping,
  type RuntimeOptions,
  sortOptions,
} from './fields';
import {
  type OwnerChoice,
  ownerChoice,
  ownerCondition,
  type OwnerFilter,
} from './owner-filter';
import type { CollectionView } from './use-collection-view';

export interface CollectionControls {
  /** Quick filters shown as pills; each is one "is any of" condition. */
  filters: CollectionFilter[];
  conditions: CollectionConditions;
  sort: CollectionSort | undefined;
  display: ReactNode;
  /** Shown columns with the member's widths, for a configurable `DataTable`. */
  columnState: DataTableColumnState;
  onColumnStateChange: (state: DataTableColumnState) => void;
  /** Column keys in display order, for the table layout. */
  columns: readonly string[];
  /** Property keys in display order, for list and board rows; never includes `title`. */
  properties: readonly string[];
  /** Removes every condition; the caller clears search text. */
  clearConditions: () => void;
  /** Opens the builder at a field, as "Filter by this column" does. */
  filterBy: (field: string) => void;
  /** Issues the client can already see, such as fields that are no longer available. */
  issues: ReturnType<typeof collectionWhereIssues>;
}

function quickCondition(condition: CollectionCondition, quick: Set<string>) {
  return (
    quick.has(condition.field) &&
    condition.op === 'any_of' &&
    Array.isArray(condition.value) &&
    condition.value.every((value) => typeof value === 'string')
  );
}

/**
 * Connects a list's view to the shared toolbar, condition builder, Display menu and table.
 * Quick filters and conditions write the view's conditions; column order and visibility belong
 * to the view, while widths and density are the member's own display settings.
 */
export function useCollectionControls({
  view,
  catalog,
  presentation,
  can,
  options,
  currencies,
  sources,
  custom,
  required,
  title,
  defaultProperties,
  preview = false,
  customColumns = true,
  customFilters = true,
  extraColumns = [],
  defaultColumns,
  serverIssues,
  owner,
}: {
  view: CollectionView;
  catalog: CollectionCatalog;
  presentation: CatalogPresentation;
  can: (permission: string) => boolean;
  options?: RuntimeOptions;
  currencies?: readonly string[];
  sources?: readonly { value: string; label: string }[];
  custom?: readonly CustomFieldColumn[];
  /** Columns that are always shown, such as the record's name. */
  required?: readonly string[];
  /** The field list rows show as their title, which is never offered as a property. */
  title?: string;
  /** Properties a view without its own shows; the catalog's default columns otherwise. */
  defaultProperties?: readonly string[];
  /** The page can open records in a preview pane beside its table or list. */
  preview?: boolean;
  /** Custom fields can be shown as columns; lists that can't read their values filter only. */
  customColumns?: boolean;
  /**
   * Custom fields can be filtered and sorted; lists whose API can't do that show them as
   * columns only, and views that still use them need repair.
   */
  customFilters?: boolean;
  /** Columns beyond the catalog's, such as one per source, listed after the catalog's. */
  extraColumns?: readonly DisplayColumn[];
  /** Columns a view without its own shows; the catalog's default columns otherwise. */
  defaultColumns?: readonly string[];
  /** A condition problem the list reported. */
  serverIssues?: readonly { index: number | null; message: string }[];
  /**
   * A person field offered as the first pill, choosing Me, Unassigned or one member. Its one
   * condition shows as the pill; other conditions on the field stay chips.
   */
  owner?: OwnerFilter | undefined;
}): CollectionControls {
  const [builderOpen, setBuilderOpen] = useState(false);
  // Chips show who "me" is and which days relative periods cover for this reader.
  const session = useQuery(sessionOptions());
  const today = workspaceDateValue(new Date(), useContext(WorkspaceTimezone));
  const [builderField, setBuilderField] = useState<string | undefined>();
  const state = view.state;
  const quick = useMemo(
    () =>
      new Set(
        catalog.fields
          .filter(
            (field) =>
              field.quick && (!field.permission || can(field.permission)),
          )
          .map((field) => field.id),
      ),
    [can, catalog.fields],
  );
  // With "any", splitting conditions across pills and chips would hide how they combine.
  const split = state.where.match === 'all';
  // The owner pill shows the first owner condition it can express.
  const ownerPill = split
    ? state.where.conditions.find(
        (condition) => owner && ownerChoice(condition, owner) !== undefined,
      )
    : undefined;
  const pill = (condition: CollectionCondition) =>
    condition === ownerPill || quickCondition(condition, quick);
  const pills = split ? state.where.conditions.filter(pill) : [];
  const rest = split
    ? state.where.conditions.filter((condition) => !pill(condition))
    : state.where.conditions;
  const setWhere = (where: CollectionWhere) => view.change({ ...state, where });
  const filterable = customFilters ? custom : undefined;
  const fields = conditionFields(catalog, presentation, {
    can,
    ...(options ? { options } : {}),
    ...(currencies ? { currencies } : {}),
    ...(sources ? { sources } : {}),
    ...(filterable ? { custom: filterable } : {}),
  });
  const customTypes = new Map(
    (filterable ?? [])
      .filter((field) => !field.archived)
      .map((field) => [field.id, field.type] as const),
  );
  // Permissions the reader holds among those the catalog's fields need.
  const permissions = new Set(
    catalog.fields.flatMap((field) =>
      field.permission && can(field.permission) ? [field.permission] : [],
    ),
  );
  const issues = collectionWhereIssues(catalog, state.where, {
    customFieldTypes: customTypes,
    permissions,
  });
  const restIssues = [...issues, ...(serverIssues ?? [])].map((issue) => {
    const condition =
      issue.index === null ? undefined : state.where.conditions[issue.index];
    const index = condition ? rest.indexOf(condition) : -1;

    return { ...issue, index: index >= 0 ? index : null };
  });
  const ownerFilters: CollectionFilter[] = owner
    ? [
        {
          key: owner.field,
          kind: 'choice',
          label: presentation[owner.field]?.label() ?? owner.field,
          icon: UserRound,
          value: ownerPill ? ownerChoice(ownerPill, owner) : undefined,
          options: [
            { value: 'me', label: m.collections_owner_me() },
            ...(owner.unassigned
              ? [
                  {
                    value: 'unassigned',
                    label: m.collections_owner_unassigned(),
                  },
                ]
              : []),
            ...owner.members,
          ],
          onChange: (choice) =>
            setWhere({
              match: 'all',
              conditions: [
                ...state.where.conditions.filter(
                  (condition) => condition !== ownerPill,
                ),
                ...(choice
                  ? [ownerCondition(owner.field, choice as OwnerChoice)]
                  : []),
              ],
            }),
        },
      ]
    : [];
  const quickFilters: CollectionFilter[] = [...quick].map((id) => {
    const field = fields.find((item) => item.id === id);
    const current = pills.find((condition) => condition.field === id);

    return {
      key: id,
      kind: 'multi-choice',
      label: field?.label ?? id,
      value: Array.isArray(current?.value)
        ? current.value.filter(
            (value): value is string => typeof value === 'string',
          )
        : undefined,
      options: field?.options ?? [],
      onChange: (values) =>
        setWhere({
          match: 'all',
          conditions: [
            ...state.where.conditions.filter(
              (condition) =>
                !(condition.field === id && quickCondition(condition, quick)),
            ),
            ...(values?.length
              ? [{ field: id, op: 'any_of' as const, value: [...values] }]
              : []),
          ],
        }),
    };
  });
  const filters = [...ownerFilters, ...quickFilters];
  const shown = state.columns.length
    ? state.columns.map((column) => column.id)
    : [...(defaultColumns ?? catalog.defaultColumns)];
  const sortable = sortOptions(catalog, presentation, can, filterable);
  const columnCustom = customColumns && custom ? { custom } : {};
  const properties = (
    state.properties.length
      ? state.properties
      : (defaultProperties ?? catalog.defaultColumns)
  ).filter((key) => key !== title);
  const groups = groupFields(catalog, presentation, can);
  // A board needs a grouping, so it is offered only when the list can be grouped.
  const layouts = catalog.layouts.filter(
    (layout) => layout !== 'board' || groups.length > 0,
  );
  const table = state.layout === 'table';

  return {
    filters,
    conditions: {
      fields,
      resolution: { me: session.data?.user.name, today },
      where: { match: state.where.match, conditions: rest },
      onWhereChange: (where) =>
        setWhere({
          match: where.match,
          conditions: [
            ...(where.match === 'all' ? pills : []),
            ...where.conditions,
          ],
        }),
      issues: restIssues,
      open: builderOpen,
      onOpenChange: (open) => {
        setBuilderOpen(open);
        if (!open) setBuilderField(undefined);
      },
      field: builderField,
    },
    sort:
      sortable.length && state.sort
        ? {
            value: state.sort.field,
            options: sortable,
            onChange: (field) =>
              view.change({
                ...state,
                sort: { field, direction: state.sort?.direction ?? 'desc' },
              }),
            direction: state.sort.direction,
            onDirectionChange: (direction) =>
              state.sort &&
              view.change({ ...state, sort: { ...state.sort, direction } }),
          }
        : undefined,
    display: (
      <CollectionDisplay
        columns={
          table
            ? {
                options: [
                  ...displayColumns(catalog, presentation, {
                    can,
                    ...columnCustom,
                    ...(required ? { required } : {}),
                  }),
                  ...extraColumns,
                ],
                shown,
                onChange: (next) =>
                  view.change({
                    ...state,
                    columns: next.map((id) => ({ id })),
                  }),
              }
            : {
                kind: 'properties',
                options: [
                  ...displayColumns(catalog, presentation, {
                    can,
                    ...columnCustom,
                  }),
                  ...extraColumns,
                ].filter((column) => column.key !== title),
                shown: properties,
                onChange: (next) => view.change({ ...state, properties: next }),
              }
        }
        density={{
          value: state.density,
          onChange: (density) => view.setDisplay({ ...view.display, density }),
        }}
        layout={{
          value: state.layout,
          options: layouts,
          onChange: (layout) => view.change({ ...state, layout }),
        }}
        preview={
          preview && state.layout !== 'board'
            ? {
                value: state.preview,
                onChange: (next) => view.change({ ...state, preview: next }),
              }
            : undefined
        }
        grouping={{
          value: state.group,
          fields: groups,
          onChange: (next) => {
            const group = grouping(next);
            view.change({
              ...state,
              group,
              layout:
                !group && state.layout === 'board' ? 'table' : state.layout,
            });
          },
        }}
        onReset={view.reset}
        modified={view.modified}
      />
    ),
    columnState: {
      columns: shown.map((key) => ({
        key,
        ...(view.display.widths[key]
          ? { width: view.display.widths[key] }
          : {}),
      })),
    },
    onColumnStateChange: (next) => {
      const order = next.columns.map((column) => column.key);
      const widths: Record<string, number> = {};
      for (const column of next.columns)
        if (column.width !== undefined) widths[column.key] = column.width;
      if (JSON.stringify(order) !== JSON.stringify(shown))
        view.change({ ...state, columns: order.map((id) => ({ id })) });
      if (JSON.stringify(widths) !== JSON.stringify(view.display.widths))
        view.setDisplay({ ...view.display, widths });
    },
    columns: shown,
    properties,
    clearConditions: () => setWhere({ match: 'all', conditions: [] }),
    filterBy: (field) => {
      setBuilderField(field);
      setBuilderOpen(true);
    },
    issues,
  };
}
