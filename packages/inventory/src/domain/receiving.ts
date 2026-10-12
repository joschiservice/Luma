import type { ShipmentData, TransferData } from './transfers.js';

/** Bounded scalar facts for operational lists; quantities never change a stock position. */
export interface TransferFacts {
  requested: string | null;
  received: string | null;
  shipped: string | null;
  unreceived: string | null;
  rejected: string | null;
  expectedArrivalAt: string | null;
  origin: string | null;
  destination: string | null;
  complete: boolean;
  consistent: boolean;
}

const decimal = (value: string) => {
  const [whole = '0', fraction = ''] = value.split('.');

  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
};
const format = (value: bigint) => {
  const fraction = (value % 1_000_000n)
    .toString()
    .padStart(6, '0')
    .replace(/0+$/, '');

  return `${value / 1_000_000n}${fraction ? `.${fraction}` : ''}`;
};

/** Summarizes reported stages exactly, treating unavailable collections and unsupported units as incomplete. */
export function transferFacts(
  data: TransferData | ShipmentData,
): TransferFacts {
  const lines = data.lines;
  const complete =
    lines !== null && lines.every((line) => line.unit === 'each');
  if (data.type === 'inventory_transfer') {
    const requested = data.lines?.reduce(
      (sum, line) => sum + decimal(line.requested),
      0n,
    );

    return {
      requested: data.requestedQuantity,
      received: data.receivedQuantity,
      shipped: complete
        ? format(
            (data.lines ?? []).reduce(
              (sum, line) => sum + decimal(line.shipped),
              0n,
            ),
          )
        : null,
      unreceived: null,
      rejected: null,
      expectedArrivalAt: null,
      origin: data.origin?.name ?? null,
      destination: data.destination?.name ?? null,
      complete,
      consistent:
        complete &&
        requested === decimal(data.requestedQuantity) &&
        decimal(data.receivedQuantity) <= decimal(data.requestedQuantity) &&
        (data.lines ?? []).every(
          (line) =>
            decimal(line.shipped) <= decimal(line.requested) &&
            decimal(line.ready) <= decimal(line.requested) &&
            decimal(line.picked) <= decimal(line.requested),
        ),
    };
  }
  const sum = (field: 'quantity' | 'accepted' | 'rejected' | 'unreceived') =>
    (data.lines ?? []).reduce(
      (total, line) => total + decimal(line[field]),
      0n,
    );

  return {
    requested: data.quantity,
    received: data.receivedQuantity,
    shipped: ['in_transit', 'partially_received', 'received'].includes(
      data.status,
    )
      ? data.quantity
      : null,
    unreceived: complete ? format(sum('unreceived')) : null,
    rejected: data.rejectedQuantity,
    expectedArrivalAt: data.expectedArrivalAt,
    origin: null,
    destination: null,
    complete,
    consistent:
      complete &&
      sum('quantity') === decimal(data.quantity) &&
      sum('accepted') === decimal(data.acceptedQuantity) &&
      sum('rejected') === decimal(data.rejectedQuantity) &&
      decimal(data.acceptedQuantity) + decimal(data.rejectedQuantity) <=
        decimal(data.receivedQuantity) &&
      decimal(data.receivedQuantity) <= decimal(data.quantity) &&
      decimal(data.receivedQuantity) + sum('unreceived') ===
        decimal(data.quantity) &&
      (data.lines ?? []).every(
        (line) =>
          decimal(line.accepted) +
            decimal(line.rejected) +
            decimal(line.unreceived) <=
          decimal(line.quantity),
      ),
  };
}

export type ReceivingSignal =
  | 'inconsistent_quantities'
  | 'rejected'
  | 'terminal_unreceived'
  | 'receipt_late';

/** Evaluates fresh, complete receiving evidence. Estimates do not prove loss and cancellation-inclusive receipts do not prove acceptance. */
export function receivingSignals(
  facts: TransferFacts,
  kind: TransferData['type'] | ShipmentData['type'],
  status: string,
  observedAt: string,
  now: Date,
  available: boolean,
): ReceivingSignal[] {
  const age = now.getTime() - Date.parse(observedAt);
  if (
    !available ||
    age < 0 ||
    age > 300_000 ||
    !facts.complete ||
    status === 'unknown' ||
    status === 'cancelled' ||
    status === 'draft'
  )
    return [];
  if (!facts.consistent) return ['inconsistent_quantities'];
  if (kind !== 'inventory_shipment') return [];
  const signals: ReceivingSignal[] = [];
  if (facts.rejected !== null && decimal(facts.rejected) > 0n)
    signals.push('rejected');
  if (facts.unreceived !== null && decimal(facts.unreceived) > 0n) {
    if (status === 'received') signals.push('terminal_unreceived');
    else if (
      facts.expectedArrivalAt &&
      Date.parse(facts.expectedArrivalAt) < now.getTime()
    )
      signals.push('receipt_late');
  }

  return signals;
}
