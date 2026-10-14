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
  | 'access';

export interface ActivityQuery {
  from: string;
  to: string;
  q?: string | undefined;
  system?: string | undefined;
  connectionId?: string | undefined;
  type?: ActivityType | undefined;
  outcome?: ActivityOutcome | undefined;
  /**
   * Keeps events recorded by any of these actors: user IDs, `luma` for Luma itself and Luma
   * support, `workflow` for events a workflow run recorded. The service resolves `me` to the
   * reader's user ID before the store reads.
   */
  actor?: readonly string[] | undefined;
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
