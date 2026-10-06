import type { ActivityEvent } from '@luma/api-contract';
import type { CollectionFilterOption } from '@luma/ui/components/primitives/collection-toolbar';
import type { OperationalState } from '@luma/ui/components/primitives/state';

import { providerName } from '../sync/presentation';

/** A workspace connection that activity can be filtered by. */
export interface ActivitySource {
  id: string;
  label: string;
  /** The connection's target kind, which activity records as its system. */
  system: string;
}

/** Readable names for activity codes that don't read well when title-cased. */
export const activityLabels: Record<string, string> = {
  provider_accepted: 'Provider accepted',
  manually_disposed: 'Manually disposed',
  uncertain: 'Uncertain',
  'purchase_order.created': 'Purchase order created',
  'purchase_order.status_changed': 'Purchase order status changed',
};

const verbs: Record<string, string> = {
  write: 'updated',
  update: 'updated',
  create: 'created',
  delete: 'deleted',
  read: 'read',
  cancel: 'cancelled',
  retry: 'retried',
};

const capitalize = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1);

/**
 * Turns an activity code into a readable label: `provider_accepted` becomes
 * "Provider accepted" and `orders.shipping-method.write` becomes
 * "Order shipping method updated".
 */
export function activityLabel(value: string) {
  if (activityLabels[value]) return activityLabels[value];
  const parts = value.split('.');
  if (parts.length === 3) {
    const [resource, field, verb] = parts as [string, string, string];
    const subject = resource.replace(/s$/, '').replaceAll(/[-_]/g, ' ');

    return capitalize(
      `${subject} ${field.replaceAll(/[-_]/g, ' ')} ${verbs[verb] ?? verb}`,
    );
  }

  return capitalize(value.replaceAll(/[._-]/g, ' '));
}

/**
 * Maps a recorded outcome to its operational state. Only `verified` counts as a
 * confirmed result; an accepted request is still in progress.
 */
export function activityState(
  outcome: ActivityEvent['outcome'],
): OperationalState {
  switch (outcome) {
    case 'verified':
      return 'verified';
    case 'failed':
    case 'rejected':
      return 'error';
    case 'escalated':
    case 'uncertain':
      return 'attention';
    case 'attempted':
    case 'provider_accepted':
      return 'running';
    case 'approved':
      return 'approval';
    default:
      return 'idle';
  }
}

/**
 * Offers each workspace connection by label. An applied connection that is no longer listed keeps
 * an option with its shortened ID, so its filter chip stays readable.
 */
export function activityConnectionOptions(
  sources: readonly ActivitySource[],
  applied: string | undefined,
): CollectionFilterOption[] {
  const options = sources.map((source) => ({
    value: source.id,
    label: source.label,
  }));
  if (applied && !options.some((option) => option.value === applied))
    options.push({
      value: applied,
      label: `Connection ${applied.slice(0, 8)}`,
    });

  return options;
}

/**
 * Offers each distinct system the workspace connects to, named by provider where Luma knows it.
 * An applied system that no connection uses any more keeps an option with its raw value.
 */
export function activitySystemOptions(
  sources: readonly ActivitySource[],
  applied: string | undefined,
): CollectionFilterOption[] {
  const systems = new Set(sources.map((source) => source.system));
  if (applied) systems.add(applied);

  return Array.from(systems, (system) => ({
    value: system,
    label: providerName(system),
  }));
}
