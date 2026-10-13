import type { TransferSummary } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';

export const transferStates: Record<string, () => string> = {
  draft: m.inventory_transfer_draft,
  ready: m.inventory_transfer_ready_state,
  in_progress: m.inventory_transfer_in_progress,
  received: m.inventory_transfer_received_state,
  cancelled: m.inventory_transfer_cancelled,
  unknown: m.inventory_transfer_unknown,
  in_transit: m.inventory_transfer_in_transit,
  partially_received: m.inventory_transfer_partially_received,
};
const signals: Record<TransferSummary['signals'][number], () => string> = {
  inconsistent_quantities: m.inventory_transfer_inconsistent_quantities,
  rejected: m.inventory_transfer_rejected,
  terminal_unreceived: m.inventory_transfer_terminal_unreceived,
  receipt_late: m.inventory_transfer_receipt_late,
};
const evidence: Record<TransferSummary['evidence'], () => string> = {
  fresh: m.inventory_transfer_fresh,
  removed: m.inventory_transfer_removed,
  stale: m.inventory_transfer_stale,
  incomplete: m.inventory_transfer_incomplete,
  unavailable: m.inventory_transfer_unavailable,
};

/** Shows freshness and bounded receiving signals without claiming physical loss. */
export function TransferEvidence({ item }: { item: TransferSummary }) {
  return (
    <div>
      <small>{evidence[item.evidence]()}</small>
      {item.signals.map((signal) => (
        <Alert key={signal} tone="warning">
          {signals[signal]()}
        </Alert>
      ))}
    </div>
  );
}
