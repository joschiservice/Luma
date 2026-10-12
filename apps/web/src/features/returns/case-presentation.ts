import type {
  ResolutionKind,
  ReturnCaseDetail,
  ReturnCaseReason,
  ReturnCaseStage,
  ReturnCreationBlocker,
  ReturnCreationFailure,
  ReturnCreationState,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import type { OperationalState } from '@luma/ui/components/primitives/state';

import { localized } from './presentation';

export const caseStageLabels = localized({
  awaiting_receipt: m.returns_case_stage_awaiting_receipt,
  awaiting_inspection: m.returns_case_stage_awaiting_inspection,
  awaiting_proposal: m.returns_case_stage_awaiting_proposal,
  proposed: m.returns_case_stage_proposed,
  completed: m.returns_case_stage_completed,
  cancelled: m.returns_case_stage_cancelled,
} satisfies Record<ReturnCaseStage, () => string>);

export const caseStageDescriptions = localized({
  awaiting_receipt: m.returns_case_stage_awaiting_receipt_description,
  awaiting_inspection: m.returns_case_stage_awaiting_inspection_description,
  awaiting_proposal: m.returns_case_stage_awaiting_proposal_description,
  proposed: m.returns_case_stage_proposed_description,
  completed: m.returns_case_stage_completed_description,
  cancelled: m.returns_case_stage_cancelled_description,
} satisfies Record<ReturnCaseStage, () => string>);

export const caseStageStates: Record<ReturnCaseStage, OperationalState> = {
  awaiting_receipt: 'waiting',
  awaiting_inspection: 'attention',
  awaiting_proposal: 'attention',
  proposed: 'waiting',
  completed: 'verified',
  cancelled: 'idle',
};

export const reasonLabels = localized({
  damaged: m.returns_case_reason_damaged,
  defective: m.returns_case_reason_defective,
  wrong_item: m.returns_case_reason_wrong_item,
  not_as_described: m.returns_case_reason_not_as_described,
  size_or_fit: m.returns_case_reason_size_or_fit,
  no_longer_needed: m.returns_case_reason_no_longer_needed,
  other: m.returns_case_reason_other,
} satisfies Record<ReturnCaseReason, () => string>);

export const resolutionLabels = localized({
  refund: m.returns_case_resolution_refund,
  exchange: m.returns_case_resolution_exchange,
  store_credit: m.returns_case_resolution_store_credit,
  rejection: m.returns_case_resolution_rejection,
} satisfies Record<ResolutionKind, () => string>);

export const creationStateLabels = localized({
  approval_required: m.returns_case_creation_state_approval_required,
  approved: m.returns_case_creation_state_approved,
  rejected: m.returns_case_creation_state_rejected,
  expired: m.returns_case_creation_state_expired,
  sending: m.returns_case_creation_state_sending,
  uncertain: m.returns_case_creation_state_uncertain,
  created: m.returns_case_creation_state_created,
  failed: m.returns_case_creation_state_failed,
  not_executed: m.returns_case_creation_state_not_executed,
} satisfies Record<ReturnCreationState, () => string>);

export const creationStateStates: Record<
  ReturnCreationState,
  OperationalState
> = {
  approval_required: 'approval',
  approved: 'running',
  rejected: 'idle',
  expired: 'idle',
  sending: 'running',
  uncertain: 'attention',
  created: 'verified',
  failed: 'error',
  not_executed: 'idle',
};

const failureMessages = {
  withheld: m.returns_case_creation_failure_withheld,
  not_accepted: m.returns_case_creation_failure_not_accepted,
  mismatch: m.returns_case_creation_failure_mismatch,
  changed: m.returns_case_creation_failure_changed,
  not_sent: m.returns_case_creation_failure_not_sent,
} satisfies Record<ReturnCreationFailure, () => string>;

/** Explains why a creation request ended without a created return. */
export const creationFailure = (failure: ReturnCreationFailure) =>
  failureMessages[failure]();

/** Explains why the return can't be created in the order's system now. */
export function creationBlocker(
  blocker: ReturnCreationBlocker,
  system: string,
): string {
  switch (blocker) {
    case 'completed':
      return m.returns_case_stage_completed_description();
    case 'cancelled':
      return m.returns_case_blocker_cancelled();
    case 'execution_disabled':
      return m.returns_case_blocker_execution_disabled();
    case 'unsupported':
      return m.returns_case_blocker_unsupported();
    case 'reconnect':
      return m.returns_case_blocker_reconnect({ system });
    case 'connection_inactive':
      return m.returns_case_blocker_connection_inactive({ system });
    case 'unmapped':
      return m.returns_case_blocker_unmapped({ system });
    case 'in_progress':
      return m.returns_case_blocker_in_progress();
    case 'created':
      return m.returns_case_blocker_created({ system });
  }
}

type HistoryEntry = ReturnCaseDetail['history'][number];

/** Names what a history entry recorded, with its resolution, reason or return number. */
export function historyTitle(entry: HistoryEntry, system: string): string {
  const { details } = entry;
  switch (entry.kind) {
    case 'opened':
      return m.returns_case_history_opened({
        units: (details.lines ?? []).reduce(
          (sum, line) => sum + (line.quantity ?? 0),
          0,
        ),
      });
    case 'assigned':
      return details.assignee
        ? m.returns_case_history_assigned({
            name: details.assignee.name ?? m.returns_case_former_member(),
          })
        : m.returns_case_history_unassigned();
    case 'receipt_recorded':
      return m.returns_case_history_receipt({
        units: (details.lines ?? []).reduce(
          (sum, line) => sum + (line.received ?? 0),
          0,
        ),
      });
    case 'inspection_recorded':
      return m.returns_case_history_inspection({
        resellable: (details.lines ?? []).reduce(
          (sum, line) => sum + (line.resellable ?? 0),
          0,
        ),
        damaged: (details.lines ?? []).reduce(
          (sum, line) => sum + (line.damaged ?? 0),
          0,
        ),
      });
    case 'resolution_proposed':
      return m.returns_case_history_proposal({
        resolution: details.resolution
          ? resolutionLabels[details.resolution]
          : '',
      });
    case 'cancelled':
      return m.returns_case_history_cancelled({ reason: details.reason ?? '' });
    case 'creation_requested':
      return m.returns_case_history_creation_requested({ system });
    case 'creation_approved':
      return m.returns_case_history_creation_approved();
    case 'creation_rejected':
      return m.returns_case_history_creation_rejected();
    case 'exchange_completed':
      return m.returns_case_history_exchange_completed();
    case 'exchange_reopened':
      return m.returns_case_history_exchange_reopened();
    case 'creation_created':
      return m.returns_case_history_creation_created({
        system,
        number: details.externalNumber ?? '—',
      });
  }
}

/** A person's recorded name, or a placeholder for someone no longer named in the workspace. */
export const personName = (person: { name: string | null }) =>
  person.name ?? m.returns_case_former_member();
