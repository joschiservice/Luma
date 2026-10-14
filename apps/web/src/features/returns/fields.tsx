import type { ReturnListItem, ReturnSource } from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Badge } from '@luma/ui/components/primitives/badge';
import { StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import type { ReactNode } from 'react';

import { formatMoney } from '../../shared/orders/presentation';
import { returnsPresentation } from './collection';
import {
  refundLabels,
  refundMoney,
  refundSummary,
  stageLabels,
  stageStates,
  units,
} from './presentation';

/** Names a return's source, from the list's sources. */
export type ReturnSourceLabel = (connectionId: string) => string;

/** Looks up source names in a list's sources, with a generic name for unknown ones. */
export function returnSourceLabel(
  sources: readonly Pick<ReturnSource, 'connectionId' | 'label'>[],
): ReturnSourceLabel {
  return (connectionId) =>
    sources.find((source) => source.connectionId === connectionId)?.label ??
    m.returns_source_fallback();
}

/**
 * Where a return stands and what needs attention: its stage, and failed refund payments when
 * the stage doesn't already say so. Every layout shows these, whatever the Display settings.
 */
export function ReturnFlags({
  item,
  stage = true,
}: {
  item: ReturnListItem;
  /** Leave out the stage where the layout already shows it, as a board's column does. */
  stage?: boolean;
}) {
  const failed =
    item.refund.failedAttempts > 0 && item.refund.state !== 'failed';

  return stage || failed ? (
    <span className="returns-flags">
      {stage ? (
        <StatePill state={stageStates[item.stage]}>
          {stageLabels[item.stage]}
        </StatePill>
      ) : null}
      {failed ? (
        <Badge tone="danger">
          {m.returns_row_failed_payments({ count: item.refund.failedAttempts })}
        </Badge>
      ) : null}
    </span>
  ) : null;
}

const empty = () => (
  <span className="returns-muted">{m.common_empty_value()}</span>
);

/** Received and requested units, or refunded units for a refund without a return. */
export function returnUnits(item: ReturnListItem) {
  if (item.kind === 'refund')
    return item.refundedUnits
      ? m.returns_row_units_refunded({ units: units(item.refundedUnits) })
      : m.returns_row_no_items();

  return item.received === null
    ? m.returns_row_units_requested({ units: units(item.quantity) })
    : m.returns_row_units_received({
        received: units(item.received),
        quantity: units(item.quantity),
      });
}

/** Whether some but not all requested units arrived; null when the source doesn't say. */
function partiallyReceived(item: ReturnListItem): boolean | null {
  if (item.received === null || item.quantity === null) return null;
  const received = Number(item.received);

  return received > 0 && received < Number(item.quantity);
}

/**
 * Renders one Returns catalog field of a return, for table cells, list and board properties and
 * the preview. Values the source doesn't report show a dash or say so.
 */
export function returnField(
  item: ReturnListItem,
  key: string,
  sourceLabel: ReturnSourceLabel,
): ReactNode {
  switch (key) {
    case 'kind':
      return returnsPresentation.kind?.option?.(item.kind) ?? item.kind;
    case 'stage':
      return stageLabels[item.stage];
    case 'items':
      return returnUnits(item);
    case 'partiallyReceived': {
      const partial = partiallyReceived(item);

      return partial === null
        ? m.common_unknown()
        : partial
          ? m.common_yes()
          : m.common_no();
    }
    case 'reasons':
      return item.reasons.length
        ? item.reasons.join(', ')
        : m.returns_row_no_reason();
    case 'refund':
      return refundSummary(item);
    case 'refundState':
      return refundLabels[item.refund.state];
    case 'pendingRefund':
      return refundMoney(item.refund.pending, item.refund.currency) ?? empty();
    case 'value':
      return formatMoney(item.value) ?? empty();
    case 'failedAttempts':
      return formatNumber(item.refund.failedAttempts);
    case 'requested':
      return item.requestedAt ? (
        <WorkspaceDate value={item.requestedAt} />
      ) : (
        <span className="returns-muted">{m.common_not_reported()}</span>
      );
    case 'activity':
      return <WorkspaceDate value={item.activityAt} />;
    case 'source':
      return sourceLabel(item.connectionId);
    default:
      return null;
  }
}
