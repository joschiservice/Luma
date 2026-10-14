import type {
  CollectionCondition,
  CollectionGranularity,
  CollectionGroup,
  CollectionSort,
  CollectionWhere,
  ReturnStage,
} from '@luma/api-contract';
import { formatCalendarDate } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';

import type {
  CatalogPresentation,
  RuntimeOptions,
} from '../../kit/collections/fields';
import { anyOf } from '../../kit/collections/legacy';
import { refundLabels, stageLabels, viewLabels } from './presentation';

const returned = () => m.returns_area_return();
const money = () => m.returns_area_money();
const source = () => m.returns_area_source();

const kindLabels: Readonly<Record<string, () => string>> = {
  return: m.returns_kind_return,
  refund: m.returns_kind_refund,
};

/** How the Returns list names each catalog field and its options. */
export const returnsPresentation: CatalogPresentation = {
  name: { label: m.returns_column_return, group: returned },
  kind: {
    label: m.returns_field_kind,
    group: returned,
    option: (value) => kindLabels[value]?.() ?? value,
  },
  stage: {
    label: m.returns_column_stage,
    description: m.returns_field_stage_description,
    group: returned,
    option: (value) =>
      (stageLabels as Readonly<Record<string, string>>)[value] ?? value,
  },
  items: { label: m.returns_column_items, group: returned },
  partiallyReceived: {
    label: m.returns_field_partially_received,
    description: m.returns_field_partially_received_description,
    group: returned,
  },
  reasons: { label: m.returns_field_reasons, group: returned },
  requested: { label: m.returns_column_requested, group: returned },
  activity: { label: m.returns_column_activity, group: returned },
  refund: { label: m.returns_column_refund, group: money },
  refundState: {
    label: m.returns_field_refund_state,
    group: money,
    option: (value) =>
      (refundLabels as Readonly<Record<string, string>>)[value] ?? value,
  },
  pendingRefund: { label: m.returns_field_pending_refund, group: money },
  value: { label: m.returns_money_item_value, group: money },
  failedAttempts: { label: m.returns_money_failed_attempts, group: money },
  source: { label: m.returns_filter_source, group: source },
};

/** Names a built-in Returns view. */
export function returnSegmentLabel(segment: string) {
  return (viewLabels as Readonly<Record<string, string>>)[segment] ?? segment;
}

/**
 * The sort a built-in view uses when its definition names none: the oldest request first for
 * work that needs action or waits, the newest first otherwise.
 */
export function segmentSort(segment: string | null): CollectionSort {
  return {
    field: 'requested',
    direction: segment === 'action' || segment === 'waiting' ? 'asc' : 'desc',
  };
}

/**
 * Names one group of the Returns list: a stage, refund state, kind or source, a reason as
 * reported, a calendar period in the workspace time zone (the server returns the period's first
 * day), or "No value" for returns without one.
 */
export function returnGroupLabel(
  field: string,
  granularity: CollectionGranularity | undefined,
  key: CollectionGroup['key'],
  options: RuntimeOptions = {},
): string {
  if (key === null) return m.collections_group_none();
  const presentation = returnsPresentation[field];
  if (typeof key === 'boolean')
    return m.collections_group_boolean({
      field: presentation?.label() ?? field,
      value: key ? m.common_yes() : m.common_no(),
    });
  const text = String(key);
  if (field === 'source')
    return (
      options.connections?.find((option) => option.value === text)?.label ??
      m.returns_source_fallback()
    );
  const day = /^\d{4}-\d{2}-\d{2}/.exec(text)?.[0];
  if (granularity && day)
    return granularity === 'day'
      ? formatCalendarDate(day)
      : granularity === 'week'
        ? m.collections_group_week({ date: formatCalendarDate(day) })
        : formatCalendarDate(day, { month: 'long', year: 'numeric' });

  return presentation?.option?.(text) ?? text;
}

/** URL keys of Returns links from before configurable views, such as Home's stage rows. */
export interface LegacyReturnSearch {
  stage?: ReturnStage | undefined;
  connectionId?: string | undefined;
}

/** Converts the filters older links use into conditions that select the same returns. */
export function legacyReturnConditions(
  search: LegacyReturnSearch,
): CollectionCondition[] {
  const conditions: CollectionCondition[] = [];
  if (search.stage) conditions.push(anyOf('stage', search.stage));
  if (search.connectionId)
    conditions.push(anyOf('source', search.connectionId));

  return conditions;
}

/**
 * The stage a view narrows to with one "Stage is" condition, as the stage cards and the Stage
 * pill set it, or undefined when it names none or several.
 */
export function chosenStage(where: CollectionWhere): ReturnStage | undefined {
  if (where.match !== 'all') return undefined;
  const stages = where.conditions.filter(
    (condition) => condition.field === 'stage',
  );
  const [only] = stages;
  if (stages.length !== 1 || only?.op !== 'any_of') return undefined;
  const values = Array.isArray(only.value) ? only.value : [];

  return values.length === 1 && typeof values[0] === 'string'
    ? (values[0] as ReturnStage)
    : undefined;
}

/** Replaces the view's stage conditions with "Stage is `stage`", or removes them. */
export function withStage(
  where: CollectionWhere,
  stage: ReturnStage | undefined,
): CollectionWhere {
  return {
    match: 'all',
    conditions: [
      ...where.conditions.filter((condition) => condition.field !== 'stage'),
      ...(stage
        ? [{ field: 'stage', op: 'any_of' as const, value: [stage] }]
        : []),
    ],
  };
}
