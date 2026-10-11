import type { TenantContext } from '@luma/identity';

import type { RecordState } from '../domain/replies.js';
import type { RecordRef } from './ports.js';

/**
 * Reads the current state of linked records for a draft, with the drafting person's
 * permissions. A record that does not exist, cannot be read or that the person may not read is
 * absent, and the draft states that it cannot be confirmed.
 */
export interface RecordStates {
  read(
    context: TenantContext,
    records: RecordRef[],
  ): Promise<Map<string, RecordState>>;
}

/** The exact send a reply asks Action Admission to perform; mirrors `ProposedAction`. */
export interface ReplyAction {
  schemaVersion: 1;
  id: string;
  tenantId: string;
  capability: 'messages.send';
  capabilityVersion: '0';
  connectionId: string;
  target: { kind: 'message_outbound'; id: string };
  parameters: Record<string, string | number | boolean | null>;
  preconditions: { evidenceRefs: string[]; validUntil: string };
  expectedPostcondition: Record<string, string | number | boolean | null>;
  risk: 'low' | 'high';
  proposedBy: { kind: 'user'; id: string };
  expiresAt: string;
}

/** The provider message a reply maps to at dispatch. */
export interface ReplyMessage {
  outboundId: string;
  thread: { externalId: string; scopeKey: string };
  inReplyTo: string | null;
  references: string[];
  to: { address: string; name: string | null }[];
  cc: { address: string; name: string | null }[];
  subject: string;
  text: string;
}

/** Execution state of a reply's send, as Action Admission recorded it. */
export type ReplyExecution =
  | { state: 'not_started' }
  | { state: 'not_executed' }
  | { state: 'withheld'; reason: string }
  | { state: 'verified' }
  | { state: 'failed'; reason: string }
  | { state: 'uncertain' };

interface ReplyDecision {
  id: string;
  outcome: 'allowed' | 'denied' | 'approval_required';
  /** The permission the requester needed; approvers need it too when it belongs to an app. */
  permission?: string | undefined;
}

/** Binds replies to Action Admission, workspace policy and audited, verified execution. */
export interface ReplyAdmission {
  /** Effective workspace and connection write controls; reads no provider data. */
  writeMode(
    context: TenantContext,
    connectionId: string,
  ): Promise<'observe_only' | 'writes_enabled'>;
  /** Binds the action to its admission step and evaluates policy with a fresh precondition check. */
  prepare(
    context: TenantContext,
    outboundId: string,
    action: ReplyAction,
  ): Promise<ReplyDecision>;
  respond(
    context: TenantContext,
    decisionId: string,
    outcome: 'approved' | 'rejected',
    expiresAt: string,
  ): Promise<void>;
  /** Dispatches once as `context`; repeated calls return the recorded attempt. */
  execute(context: TenantContext, outboundId: string): Promise<ReplyExecution>;
  /** Verifies again by reading; never dispatches. */
  reconcile(context: TenantContext, actionId: string): Promise<ReplyExecution>;
  get(context: TenantContext, actionId: string): Promise<ReplyExecution>;
}
