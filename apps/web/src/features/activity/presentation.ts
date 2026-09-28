import type { ActivityEvent } from '@luma/api-contract';
import type { OperationalState } from '@luma/ui/components/primitives/state';

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
