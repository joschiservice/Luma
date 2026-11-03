export type ActivityOutcome =
  | 'approved'
  | 'rejected'
  | 'escalated'
  | 'attempted'
  | 'provider_accepted'
  | 'verified'
  | 'failed'
  | 'uncertain'
  | 'manually_disposed'
  | 'recorded';

type ActivityType =
  | 'issue'
  | 'decision'
  | 'execution'
  | 'verification'
  | 'resolution'
  | 'connection'
  | 'procurement'
  /** Restricted changes to members, invitations, roles and workspace settings. */
  | 'access'
  /** Data-subject erasures, recorded with counts and never the customer's identifiers. */
  | 'privacy';

export interface ActivityQuery {
  /** Business groups hide routine checks and retain up to 100 authorized steps. */
  view?: 'events' | 'business' | undefined;
  /** Includes bounded earlier steps only when the reader opens the Activity page. */
  detail?: 'summary' | 'steps' | undefined;
  from: string;
  to: string;
  q?: string | undefined;
  system?: string | undefined;
  connectionId?: string | undefined;
  type?: ActivityType | undefined;
  /** Keeps events with any of these outcomes. */
  outcome?: readonly ActivityOutcome[] | undefined;
  /**
   * Keeps events recorded by any of these actors: user IDs, `luma` for Luma itself and Luma
   * support, `workflow` for events a workflow run recorded. The service resolves `me` to the
   * reader's user ID before the store reads.
   */
  actor?: readonly string[] | undefined;
  /**
   * Issue classes whose names match the search text in the reader's language; events of these
   * classes match the search too.
   */
  searchIssueClasses?: readonly string[] | undefined;
  /** Reads only the business group, or the event, with this ID instead of a page. */
  event?: string | undefined;
  limit: number;
  cursor?: string | undefined;
  /** Keeps only events for these linked issues, workflow runs or order references. */
  subjects?:
    { issueIds: string[]; runIds: string[]; orderRefs: string[] } | undefined;
}

/**
 * Who recorded an event. People are current or former members of the workspace; former
 * members keep the name recorded when they left, which may be missing. Email is present only
 * for current members. Luma records detection and verification itself; services keep their
 * recorded identifier as the name. `workflow` names the workflow whose run acted for a person.
 */
export interface ActivityActor {
  kind:
    'member' | 'former_member' | 'luma' | 'support' | 'service' | 'unrecorded';
  id: string | null;
  name: string | null;
  email: string | null;
  workflow: { id: string; name: string | null } | null;
}

export interface ActivityEvent {
  workflowRunId?: string | null;
  resourceKind?: string | null;
  /** The class of the issue the event concerns, such as `stuck_fulfillment`. */
  issueClass?: string | null;
  steps?: ActivityEvent[];
  id: string;
  recordedAt: string;
  occurredAt: string | null;
  actor: ActivityActor;
  action: string;
  type: ActivityType;
  outcome: ActivityOutcome;
  exceptionId: string | null;
  proposalId: string | null;
  attemptId: string | null;
  connectionId: string | null;
  system: string | null;
  resource: string | null;
  playbookId: string | null;
  mode: 'simulation' | 'shadow' | 'pilot' | 'unrecorded';
  summary: string | null;
  executionState: string | null;
  verificationPhase: string | null;
  failureCode: string | null;
  connections: { id: string; system: string | null }[];
  dispatch: string | null;
  verification: string | null;
  evidenceRefs: string[];
}

export interface ActivityPage {
  visibility: 'member' | 'admin';
  items: ActivityEvent[];
  nextCursor: string | null;
  coverage: string;
}

/**
 * How many business groups match the filters, without the outcome filter: in total, with an
 * outcome that asks a person to look, and per outcome. A group counts under every outcome one of
 * its meaningful events has, as the outcome filter would list it.
 */
export type ActivityCounts = {
  total: number;
  attention: number;
  outcomes: Partial<Record<ActivityOutcome, number>>;
  /** The counts stopped at the newest events, so each is a lower bound. */
  truncated: boolean;
};
