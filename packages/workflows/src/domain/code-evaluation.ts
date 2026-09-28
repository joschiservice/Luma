import type { CodeResult } from './code-step.js';
import type { PlaybookScalar } from './playbook.js';

/** A reproducible example with supplied replies instead of live capabilities. */
export interface EvaluateCode {
  id: string;
  version: string;
  reviewedDigest: string;
  stepId: string;
  now: string;
  input: {
    inputs: Record<string, PlaybookScalar>;
    evidence: Record<string, PlaybookScalar>;
    steps: Record<string, Record<string, PlaybookScalar>>;
  };
  replies: Record<string, Record<string, PlaybookScalar>>;
  expected: Record<string, PlaybookScalar>;
}

/** An actor-owned evaluation and its filtered terminal result. */
export interface CodeEvaluation {
  id: string;
  version: string;
  stepId: string;
  state: 'running' | 'passed' | 'failed' | 'cancelled';
  createdAt: string;
  expiresAt: string;
  result: CodeResult | null;
}
