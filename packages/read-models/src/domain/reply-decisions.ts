import type { DecisionCandidate } from './decision-item.js';

/** A reply in flight that needs a person, as the messaging owner reports it. */
export interface ReplySendDecision {
  outboundId: string;
  actionId?: string | null;
  threadId: string;
  subject: string;
  /** Recipients as written, comma separated. */
  to: string;
  /** Why the reply needs approval; empty for replies sent at once. */
  reasons: ('date' | 'quantity' | 'money' | 'workspace_policy')[];
  state: 'approval_required' | 'approved' | 'sending' | 'uncertain';
  requestedBy: string;
  requestedAt: string;
  expiresAt: string | null;
  response: 'decide' | 'run' | 'check' | 'awaiting_other' | 'view_only';
}

const reasonText: Record<ReplySendDecision['reasons'][number], string> = {
  date: 'a date',
  quantity: 'a quantity',
  money: 'money',
  workspace_policy: 'the mailbox rule that every reply is approved',
};

/**
 * Presents a reply waiting for approval, for its requester to send, or for a check after an
 * unconfirmed send. Its controls live on the thread.
 */
export function presentReplySend(item: ReplySendDecision): DecisionCandidate {
  const subject = item.subject || '(no subject)';
  const base = {
    id: `message-send:${item.outboundId}`,
    ...(item.actionId
      ? { actionReference: { proposalId: item.actionId } }
      : {}),
    kind: 'message_reply' as const,
    domain: 'operations' as const,
    requestedAt: item.requestedAt,
    requesterId: item.requestedBy,
    subject: { label: subject, detail: item.to },
    record: null,
    owner: { kind: 'message_thread' as const, threadId: item.threadId },
    citedEvidence: {
      subject: { kind: 'reply' as const, id: item.outboundId },
    },
    response: item.response,
  };
  const change = [
    { label: 'To', value: item.to },
    { label: 'Subject', value: subject },
    ...(item.reasons.length
      ? [
          {
            label: 'Needs approval for',
            value: item.reasons.map((r) => reasonText[r]).join(', '),
          },
        ]
      : []),
  ];
  if (item.state === 'approval_required')
    return {
      ...base,
      reason: 'approval',
      title: `Approve reply: ${subject}`,
      why: 'This reply states something the business commits to. Someone other than the requester approves the exact text before it is sent.',
      consequences: [
        {
          response: 'Approve',
          text: 'Luma sends the reply once, as the requester, and confirms it with a fresh read of the thread.',
        },
        {
          response: 'Reject',
          text: 'Nothing is sent. The draft stays on the thread.',
        },
      ],
      change,
      impact: { level: 'high', text: 'Commits the business in writing' },
      deadline: item.expiresAt,
      evidence: { observedAt: item.requestedAt, validUntil: item.expiresAt },
      group: {
        key: 'message:send_approval',
        label: 'Replies waiting for approval',
      },
    };
  if (item.state === 'approved')
    return {
      ...base,
      reason: 'run',
      title: `Send approved reply: ${subject}`,
      why: 'The reply was approved but has not been sent yet.',
      consequences: [
        {
          response: 'Send',
          text: 'Luma sends the reply once and confirms it with a fresh read of the thread.',
        },
      ],
      change,
      impact: { level: 'medium', text: null },
      deadline: null,
      evidence: { observedAt: item.requestedAt, validUntil: null },
      group: { key: 'message:send_run', label: 'Approved replies to send' },
    };

  return {
    ...base,
    reason: 'recovery',
    title: `Check whether this reply was sent: ${subject}`,
    why: 'The mailbox did not confirm the send. Luma will not send it again until a read of the thread settles whether it arrived.',
    consequences: [
      {
        response: 'Check',
        text: 'Luma reads the thread. If the message is there, the reply counts as sent; otherwise it stays unresolved.',
      },
    ],
    change,
    impact: { level: 'high', text: 'Sending state unknown' },
    deadline: null,
    evidence: { observedAt: item.requestedAt, validUntil: null },
    group: {
      key: 'message:send_uncertain',
      label: 'Replies with an uncertain send',
    },
  };
}
