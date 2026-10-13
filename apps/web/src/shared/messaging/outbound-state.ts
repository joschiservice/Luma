import type { Outbound } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import type { OperationalState } from '@luma/ui/components/primitives/state';

/** Names the same governed send state wherever an outgoing message appears. */
export const outboundStateLabels: Record<Outbound['state'], () => string> = {
  draft: m.messaging_reply_state_draft,
  approval_required: m.messaging_reply_state_approval_required,
  approved: m.messaging_reply_state_approved,
  rejected: m.messaging_reply_state_rejected,
  expired: m.messaging_reply_state_expired,
  sending: m.messaging_reply_state_sending,
  uncertain: m.messaging_reply_state_uncertain,
  sent: m.messaging_reply_state_sent,
  failed: m.messaging_reply_state_failed,
  withheld: m.messaging_reply_state_withheld,
  discarded: m.messaging_reply_state_discarded,
};

/** Maps message verification and uncertain writes to the shared operational appearance. */
export const outboundStates: Record<Outbound['state'], OperationalState> = {
  draft: 'idle',
  approval_required: 'approval',
  approved: 'waiting',
  rejected: 'error',
  expired: 'idle',
  sending: 'running',
  uncertain: 'attention',
  sent: 'verified',
  failed: 'error',
  withheld: 'attention',
  discarded: 'idle',
};
