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

export type ActivityType =
  | 'issue'
  | 'decision'
  | 'execution'
  | 'verification'
  | 'resolution'
  | 'connection'
  | 'procurement';

export interface ActivityQuery {
  from: string;
  to: string;
  q?: string | undefined;
  system?: string | undefined;
  connectionId?: string | undefined;
  type?: ActivityType | undefined;
  outcome?: ActivityOutcome | undefined;
  limit: number;
  cursor?: string | undefined;
}

export interface ActivityEvent {
  id: string;
  recordedAt: string;
  occurredAt: string | null;
  actorId: string | null;
  actorKind: string | null;
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
