import {
  type CollectionCatalog,
  type CollectionFieldDefinition,
  collectionOperators,
  type CollectionOptionSource,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import type {
  DisplayColumn,
  DisplayGrouping,
} from '@luma/ui/components/primitives/collection-display';
import type { ConditionField } from '@luma/ui/components/primitives/condition-builder';

/**
 * How a page names one catalog field. Message functions are stored, not called, so text
 * follows the reader's language at render time.
 */
interface FieldPresentation {
  label: () => string;
  description?: () => string;
  /** The area the field is listed under, such as Fulfillment. */
  group?: () => string;
  /** Names an option of an enum field; unknown values show as they are. */
  option?: (value: string) => string;
}

export type CatalogPresentation = Readonly<Record<string, FieldPresentation>>;

/** Options loaded at run time, such as connections or members, by source. */
export type RuntimeOptions = Partial<
  Record<CollectionOptionSource, readonly { value: string; label: string }[]>
>;

/** A custom field the reader may see on this list. */
export interface CustomFieldColumn {
  id: string;
  label: string;
  type: CollectionFieldDefinition['type'];
  options?: readonly { value: string; label: string }[];
  archived: boolean;
}

function label(presentation: CatalogPresentation, id: string) {
  return presentation[id]?.label() ?? id;
}

function allowed(
  field: CollectionFieldDefinition,
  can: (permission: string) => boolean,
) {
  return !field.permission || can(field.permission);
}

/** Fields the condition builder offers, with options in the reader's language. */
export function conditionFields(
  catalog: CollectionCatalog,
  presentation: CatalogPresentation,
  context: {
    can: (permission: string) => boolean;
    options?: RuntimeOptions;
    currencies?: readonly string[];
    sources?: readonly { value: string; label: string }[];
    custom?: readonly CustomFieldColumn[];
  },
): ConditionField[] {
  const native = catalog.fields
    .filter((field) => field.filter)
    .map((field): ConditionField => {
      const shown = presentation[field.id];
      const runtime = field.optionSource
        ? context.options?.[field.optionSource]
        : undefined;

      return {
        id: field.id,
        label: label(presentation, field.id),
        type: field.type,
        operators: field.filter ?? [],
        group: shown?.group?.(),
        options:
          runtime ??
          field.options?.map((value) => ({
            value,
            label: shown?.option?.(value) ?? value,
          })),
        offerMe: field.type === 'person',
        perSource: field.perSource,
        sources: field.perSource ? context.sources : undefined,
        currencies: field.type === 'money' ? context.currencies : undefined,
        unavailable: allowed(field, context.can)
          ? undefined
          : m.collections_field_no_permission(),
      };
    });
  const custom = (context.custom ?? [])
    .filter((field) => !field.archived)
    .map((field): ConditionField => ({
      id: `custom:${field.id}`,
      label: field.label,
      type: field.type,
      operators: collectionOperators[field.type],
      group: m.collections_custom_fields(),
      options: field.options,
      currencies: field.type === 'money' ? context.currencies : undefined,
    }));

  return [...native, ...custom];
}

/** Columns the Display menu offers; unreadable or archived ones stay listed as unavailable. */
export function displayColumns(
  catalog: CollectionCatalog,
  presentation: CatalogPresentation,
  context: {
    can: (permission: string) => boolean;
    custom?: readonly CustomFieldColumn[];
    required?: readonly string[];
  },
): DisplayColumn[] {
  const native = catalog.fields
    .filter((field) => field.column)
    .map((field): DisplayColumn => ({
      key: field.id,
      label: label(presentation, field.id),
      description: presentation[field.id]?.description?.(),
      group: presentation[field.id]?.group?.(),
      origin: field.origin,
      required: context.required?.includes(field.id),
      unavailable: allowed(field, context.can)
        ? undefined
        : m.collections_field_no_permission(),
    }));
  const custom = (context.custom ?? []).map((field): DisplayColumn => ({
    key: `custom:${field.id}`,
    label: field.label,
    group: m.collections_custom_fields(),
    origin: 'luma',
    unavailable: field.archived ? m.collections_field_archived() : undefined,
  }));

  return [...native, ...custom];
}

/** Fields a list can be grouped by, with date periods where the catalog offers them. */
export function groupFields(
  catalog: CollectionCatalog,
  presentation: CatalogPresentation,
  can: (permission: string) => boolean,
) {
  return catalog.fields
    .filter((field) => field.group && allowed(field, can))
    .map((field) => ({
      value: field.id,
      label: label(presentation, field.id),
      granularities: Array.isArray(field.group) ? field.group : undefined,
    }));
}

/**
 * Sort options for the toolbar's Sort menu. Custom fields are offered when the list supports
 * them and they hold one value; multiple choices have no order.
 */
export function sortOptions(
  catalog: CollectionCatalog,
  presentation: CatalogPresentation,
  can: (permission: string) => boolean,
  custom: readonly CustomFieldColumn[] = [],
) {
  return [
    ...catalog.fields
      .filter((field) => field.sort && allowed(field, can))
      .map((field) => ({
        value: field.id,
        label: label(presentation, field.id),
      })),
    ...(catalog.customFields ? custom : [])
      .filter((field) => !field.archived && field.type !== 'tags')
      .map((field) => ({ value: `custom:${field.id}`, label: field.label })),
  ];
}

/** Converts the Display menu's grouping to the view state's grouping. */
export function grouping(value: DisplayGrouping | null) {
  return value
    ? {
        field: value.field,
        showEmpty: value.showEmpty,
        ...(value.granularity ? { granularity: value.granularity } : {}),
      }
    : null;
}
