import type { AppDecision } from '@luma/app-host';

import type { RecoveryView } from '../domain/fulfillment-recovery.js';
import type { CorrectionView } from '../domain/inventory-correction.js';

const tail = (gid: string) => gid.split('/').at(-1) ?? gid;

const units = (value: number) => `${value} ${value === 1 ? 'unit' : 'units'}`;

const actionLabels: Record<RecoveryView['choice']['capability'], string> = {
  'fulfillment.hold.release': 'Release hold',
  'fulfillment.open': 'Reopen fulfillment',
  'fulfillment.move': 'Move remaining items',
};

type Stage = Pick<
  AppDecision,
  'reason' | 'response' | 'why' | 'consequences' | 'deadline'
>;

// Shared lifecycle wording for Shopify actions: a second approver, a run by the requester, then
// an independent read. A receipt is never presented as the outcome.
function stage(
  view: RecoveryView | CorrectionView,
  actorId: string,
  verify: string,
): Stage {
  if (view.observeOnly)
    return {
      reason: 'approval',
      response: 'view_only',
      deadline: null,
      why: 'Would run when writes are enabled. No provider change was made.',
      consequences: [],
    };
  if (view.state === 'uncertain')
    return {
      reason: 'recovery',
      response: 'check',
      deadline: null,
      why: 'Luma sent this change, but Shopify’s answer was lost, so the outcome is unknown. Luma will not send it again.',
      consequences: [
        {
          response: 'Check',
          text: `Luma reads Shopify again to learn whether the change took effect. ${verify}`,
        },
      ],
    };
  if (view.state === 'recovery_required')
    return {
      reason: 'recovery',
      response: 'check',
      deadline: null,
      why: 'Shopify accepted this change, but no fresh read has confirmed the result yet. An accepted change is not a verified one.',
      consequences: [
        {
          response: 'Check',
          text: `Luma reads Shopify again. ${verify} If it doesn’t, review the order in Shopify.`,
        },
      ],
    };
  if (view.canExecute || view.approved)
    return {
      reason: 'run',
      response: view.canExecute ? 'run' : 'view_only',
      deadline: view.expiresAt,
      why:
        view.requesterId === actorId
          ? 'Approved by someone else. Only you, as the requester, can run it before it expires.'
          : 'Approved. Only the person who requested it can run it before it expires.',
      consequences: [
        {
          response: 'Run',
          text: `Luma checks eligibility with Shopify again, sends this one change and never resends it. ${verify}`,
        },
      ],
    };

  return {
    reason: 'approval',
    response: view.canApprove
      ? 'decide'
      : view.requesterId === actorId
        ? 'awaiting_other'
        : 'view_only',
    deadline: view.expiresAt,
    why: 'Changing Shopify needs someone else who can approve changes to approve this exact action before the requester can run it.',
    consequences: [
      {
        response: 'Approve',
        text: 'The requester can run it until it expires. Shopify eligibility is checked again right before it runs.',
      },
      {
        response: 'Reject',
        text: 'Nothing changes in Shopify. Trying again needs a new preview.',
      },
    ],
  };
}

const groupLabels: Record<
  AppDecision['kind'],
  Record<AppDecision['reason'], string>
> = {
  fulfillment_recovery: {
    approval: 'Fulfillment recoveries awaiting approval',
    run: 'Approved fulfillment recoveries to run',
    recovery: 'Fulfillment recoveries to check',
  },
  inventory_correction: {
    approval: 'Stock corrections awaiting approval',
    run: 'Approved stock corrections to run',
    recovery: 'Stock corrections to check',
  },
};

/**
 * A decision about a target keeps one ID while it waits for approval or a run, so a refreshed
 * proposal updates the same item. Checks of sent changes stay separate per attempt.
 */
const decisionId = (
  kind: AppDecision['kind'],
  reason: AppDecision['reason'],
  target: string,
  attempt: string,
) => `shopify:${kind}:${reason === 'recovery' ? attempt : target}`;

const group = (kind: AppDecision['kind'], reason: AppDecision['reason']) => ({
  key: `shopify:${kind}:${reason}`,
  label: groupLabels[kind][reason],
});

/** Presents a fulfillment recovery that waits on a person, including its exact Shopify change. */
export function recoveryDecision(
  view: RecoveryView,
  actorId: string,
): AppDecision {
  const { before, choice, target } = view;
  const remaining = before.lines.reduce((sum, line) => sum + line.remaining, 0);
  const total = before.lines.reduce((sum, line) => sum + line.total, 0);
  const hold =
    choice.capability === 'fulfillment.hold.release'
      ? before.holds.find((item) => item.id === choice.holdId)
      : undefined;
  const destination =
    choice.capability === 'fulfillment.move'
      ? before.locations.find((item) => item.id === choice.locationId)
      : undefined;
  const state = stage(
    view,
    actorId,
    'Only fewer unfulfilled items on the same lines count as progress.',
  );
  const title =
    choice.capability === 'fulfillment.move'
      ? `Move fulfillment to ${destination?.name ?? 'another location'}`
      : choice.capability === 'fulfillment.hold.release'
        ? `Release fulfillment hold at ${before.locationName}`
        : `Reopen fulfillment at ${before.locationName}`;

  return {
    id: decisionId(
      'fulfillment_recovery',
      state.reason,
      `${target.connectionId}:${tail(target.fulfillmentOrderId)}`,
      view.id,
    ),
    observeOnly: view.observeOnly ?? false,
    kind: 'fulfillment_recovery',
    domain: 'fulfillment',
    title,
    ...state,
    change: [
      { label: 'Action', value: actionLabels[choice.capability] },
      { label: 'Shopify order', value: tail(target.orderId) },
      { label: 'Fulfillment order', value: tail(target.fulfillmentOrderId) },
      { label: 'Location', value: before.locationName },
      ...(hold ? [{ label: 'Hold reason', value: hold.reason }] : []),
      ...(choice.capability === 'fulfillment.move'
        ? [
            {
              label: 'Destination',
              value: destination?.name ?? tail(choice.locationId),
            },
          ]
        : []),
      {
        label: 'Unfulfilled',
        value: `${units(remaining)} of ${total} on ${before.lines.length} ${before.lines.length === 1 ? 'line' : 'lines'}`,
      },
      { label: 'Shopify status', value: before.status.toLowerCase() },
    ],
    impact: {
      level: 'unknown',
      text: `${units(remaining)} not yet fulfilled`,
    },
    requestedAt: before.observedAt,
    requesterId: view.requesterId,
    evidence: { observedAt: before.observedAt, validUntil: view.expiresAt },
    subject: {
      label: `Fulfillment at ${before.locationName}`,
      detail: `Shopify order ${tail(target.orderId)}`,
    },
    record: {
      kind: 'fulfillment',
      source: {
        connectionId: target.connectionId,
        externalId: target.fulfillmentOrderId,
      },
    },
    owner: {
      kind: 'app_fulfillment',
      connectionId: target.connectionId,
      orderId: target.orderId,
      fulfillmentId: target.fulfillmentOrderId,
    },
    group: group('fulfillment_recovery', state.reason),
  };
}

/** Presents an ERP-to-Shopify stock correction that waits on a person, with both quantities. */
export function correctionDecision(
  view: CorrectionView,
  actorId: string,
): AppDecision {
  const { before, target } = view;
  const set = before.source.available;
  const delta = before.available === null ? null : set - before.available;
  const state = stage(
    view,
    actorId,
    `It counts as corrected only when Shopify shows ${set} and ${before.source.label} is unchanged.`,
  );
  const observed = [before.observedAt, before.source.observedAt].sort()[0]!;

  return {
    id: decisionId(
      'inventory_correction',
      state.reason,
      `${target.positionId}:${target.connectionId}`,
      view.id,
    ),
    observeOnly: view.observeOnly ?? false,
    kind: 'inventory_correction',
    domain: 'inventory',
    title: `Correct Shopify stock at ${before.locationName}`,
    ...state,
    change: [
      { label: 'Location', value: before.locationName },
      {
        label: 'Shopify now',
        value: before.available === null ? 'Unknown' : units(before.available),
      },
      { label: `${before.source.label} (authority)`, value: units(set) },
      {
        label: 'Change',
        value:
          delta === null
            ? `Set to ${set}`
            : `Set to ${set} (${delta > 0 ? '+' : ''}${delta})`,
      },
    ],
    impact: {
      level: 'unknown',
      text:
        delta === null
          ? 'Shopify quantity unknown'
          : `${units(Math.abs(delta))} differ from ${before.source.label}`,
    },
    requestedAt: before.observedAt,
    requesterId: view.requesterId,
    evidence: { observedAt: observed, validUntil: view.expiresAt },
    subject: {
      label: `Shopify stock at ${before.locationName}`,
      detail: `Authority: ${before.source.label}`,
    },
    record: { kind: 'position', id: target.positionId },
    owner: { kind: 'app_inventory', positionId: target.positionId },
    group: group('inventory_correction', state.reason),
  };
}
