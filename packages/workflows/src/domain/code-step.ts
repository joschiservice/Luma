import type { PlaybookFields, PlaybookScalar } from './playbook.js';

/** A pinned interpreter contract. Source is compiled as TypeScript without module imports. */
export const codeRuntime = 'wasmtime-49.0.1/javy-9.1.0/typescript-5.9.3/1';

/** A bounded computation can request only named, published workflow steps. */
export interface CodeStep {
  id: string;
  kind: 'code';
  source: string;
  artifactDigest: string;
  runtime: typeof codeRuntime;
  fields: PlaybookFields;
  grants: string[];
  limits: {
    fuel: number;
    memoryBytes: number;
    wallTimeMs: number;
    maxRequests: number;
  };
}

/** Diagnostics contain classifications and measurements, never guest error messages or logs. */
export interface CodeTelemetry {
  runtime: string;
  artifactDigest: string;
  inputDigest: string;
  wallTimeMs: number;
  requests: number;
  verifiedActions?: number;
  peakProcessMemoryBytes?: number;
  outcome:
    | 'completed'
    | 'code_error'
    | 'resource_limit'
    | 'cancelled'
    | 'invalid_output'
    | 'capability_denied'
    | 'unavailable';
}

export interface CodeResult {
  values: Record<string, PlaybookScalar>;
  telemetry: CodeTelemetry;
}

/** Capability calls and replies are journaled in order before execution resumes. */
export interface CodeCall {
  grant: string;
  value: unknown;
  evidenceRefs: string[];
}

/** The host may suspend an instruction for policy approval without retaining a sandbox. */
export interface CodeActivityResult extends CodeResult {
  state: 'completed' | 'awaiting_approval' | 'failed';
  evidenceRefs: string[];
}

/** Runs an exact artifact. Capability requests must be authorized independently by the host. */
export interface CodeRunner {
  run(
    step: CodeStep,
    input: unknown,
    options: {
      now: string;
      signal?: AbortSignal;
      request(grant: string): Promise<unknown>;
    },
  ): Promise<CodeResult>;
}

/** Signals an expected RPC stop; other host failures must retry the durable activity. */
export class CodeRequestStopped extends Error {
  constructor(
    readonly outcome: 'capability_denied' | 'cancelled' | 'invalid_output',
  ) {
    super(`Code request stopped: ${outcome}`);
    this.name = 'CodeRequestStopped';
  }
}
