import type { VerificationResult } from '@luma/connections';

export interface ExecutionFailure {
  id: string;
  proposalId: string;
  occurredAt: string;
  phase: 'dispatch' | 'verification';
  code: string;
  retry: 'never' | 'after_delay' | 'reconcile';
  effect: 'none' | 'unknown';
  providerRequestId?: string;
}

export interface VerificationAttempt {
  id: string;
  proposalId: string;
  phase: 'pending' | 'completed';
  actorId: string;
  startedAt: string;
  finishedAt?: string;
  result?: VerificationResult;
  failure?: ExecutionFailure;
}
