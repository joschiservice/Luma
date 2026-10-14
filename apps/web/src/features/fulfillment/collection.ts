import type {
  CollectionCondition,
  CollectionGranularity,
  CollectionGroup,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';

import type {
  CatalogPresentation,
  RuntimeOptions,
} from '../../kit/collections/fields';
import { collectionGroupLabel } from '../../kit/collections/groups';
import { anyOf } from '../../kit/collections/legacy';
import {
  deliveryLabels,
  handoffLabels,
  holdLabels,
  kindLabels,
  methodLabels,
  signalLabels,
  statusLabels,
  viewLabels,
} from './presentation';

const work = () => m.fulfillment_area_work();
const shipping = () => m.fulfillment_area_shipping();
const dates = () => m.fulfillment_area_dates();

const option = (labels: Readonly<Record<string, string>>) => (value: string) =>
  labels[value] ?? value;

/** How the Fulfillment list names each catalog field and its options. */
export const fulfillmentPresentation: CatalogPresentation = {
  order: { label: m.fulfillment_field_order, group: work },
  orderNumber: { label: m.fulfillment_field_order_number, group: work },
  waiting: { label: m.fulfillment_field_waiting, group: dates },
  deadline: {
    label: m.fulfillment_sort_deadline,
    description: m.fulfillment_field_deadline_description,
    group: dates,
  },
  kind: {
    label: m.fulfillment_fact_type,
    group: work,
    option: option(kindLabels),
  },
  source: { label: m.fulfillment_fact_source, group: work },
  status: {
    label: m.fulfillment_fact_status,
    group: work,
    option: option(statusLabels),
  },
  signals: {
    label: m.fulfillment_field_signals,
    description: m.fulfillment_field_signals_description,
    group: work,
    option: option(signalLabels),
  },
  holds: {
    label: m.fulfillment_fact_holds,
    description: m.fulfillment_field_holds_description,
    group: work,
    option: option(holdLabels),
  },
  units: { label: m.fulfillment_field_units, group: work },
  location: { label: m.fulfillment_fact_location, group: shipping },
  method: { label: m.fulfillment_fact_method, group: shipping },
  methodType: {
    label: m.fulfillment_field_method_type,
    group: shipping,
    option: option(methodLabels),
  },
  carrier: { label: m.fulfillment_field_carrier, group: shipping },
  stage: {
    label: m.fulfillment_field_stage,
    description: m.fulfillment_field_stage_description,
    group: shipping,
    option: option(handoffLabels),
  },
  delivery: {
    label: m.fulfillment_fact_carrier_status,
    group: shipping,
    option: option(deliveryLabels),
  },
  hasTracking: { label: m.fulfillment_field_has_tracking, group: shipping },
  fulfillAt: { label: m.fulfillment_fact_scheduled, group: dates },
  fulfillBy: { label: m.fulfillment_fact_fulfill_by, group: dates },
  estimatedDelivery: {
    label: m.fulfillment_fact_estimated_delivery,
    group: dates,
  },
  progress: {
    label: m.fulfillment_column_progress,
    description: m.fulfillment_field_progress_description,
    group: dates,
  },
  orderPlaced: { label: m.fulfillment_field_order_placed, group: dates },
  updated: { label: m.fulfillment_field_updated, group: dates },
};

/** Names a built-in Fulfillment view. */
export function fulfillmentSegmentLabel(segment: string) {
  const labels: Readonly<Record<string, string>> = viewLabels;

  return labels[segment] ?? segment;
}

/** Fields whose group keys are IDs named by options loaded at run time. */
const runtimeGroups: Readonly<Record<string, keyof RuntimeOptions>> = {
  source: 'connections',
  location: 'locations',
};

/**
 * Names one group of the Fulfillment list: an option's label, a source or location name, a
 * calendar period in the workspace time zone, or "No value".
 */
export function fulfillmentGroupLabel(
  field: string,
  granularity: CollectionGranularity | undefined,
  key: CollectionGroup['key'],
  options: RuntimeOptions = {},
): string {
  return collectionGroupLabel({
    presentation: fulfillmentPresentation,
    field,
    granularity,
    key,
    options,
    runtime: runtimeGroups,
  });
}

/** URL keys of Fulfillment links from before configurable views. */
export interface LegacyFulfillmentSearch {
  connectionId?: string | undefined;
  locationId?: string | undefined;
  kind?: string | undefined;
}

/** Converts the filters older links use into conditions that select the same work. */
export function legacyFulfillmentConditions(
  search: LegacyFulfillmentSearch,
): CollectionCondition[] {
  return [
    ...(search.connectionId ? [anyOf('source', search.connectionId)] : []),
    ...(search.locationId ? [anyOf('location', search.locationId)] : []),
    ...(search.kind ? [anyOf('kind', search.kind)] : []),
  ];
}
