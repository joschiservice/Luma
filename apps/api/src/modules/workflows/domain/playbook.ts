/** V0 is a linear resolution: eligibility, one admitted action, verification and recovery. */
export type PlaybookScalar = string | number | boolean | null;
export type PlaybookFields = Record<
  string,
  'string' | 'number' | 'boolean' | 'null'
>;
export type PlaybookValue =
  | { source: 'input' | 'evidence'; field: string }
  | { source: 'literal'; value: PlaybookScalar };
export interface PlaybookDefinition {
  id: string;
  name: string;
  intent: string;
}
export interface PlaybookIR {
  schemaVersion: 1;
  inputs: PlaybookFields;
  evidence: { kind: string; fields: PlaybookFields; maxAgeSeconds: number };
  eligibility: {
    id: string;
    kind: 'eligibility';
    all: { field: string; equals: PlaybookScalar }[];
  };
  action: {
    id: string;
    kind: 'capability';
    capability: string;
    capabilityVersion: string;
    targetKind: string;
    minimumRisk: 'low' | 'medium' | 'high';
    parameters: Record<string, PlaybookValue>;
    expectedPostcondition: Record<string, PlaybookValue>;
  };
  approval: { id: string; kind: 'approval'; mode: 'policy' | 'required' };
  verification: {
    id: string;
    kind: 'verification';
    evaluatorVersion: string;
    maxDurationSeconds: number;
    maxAttempts: 1;
  };
  recovery: {
    id: string;
    kind: 'escalation';
    strategy: 'reconcile_then_escalate';
  };
}
export interface PlaybookVersion {
  definition: PlaybookDefinition;
  version: string;
  compatibility: { interpreter: 'resolution-playbook/0'; admission: 1 };
  provenance: {
    kind: 'resolution' | 'pilot';
    reference: string;
    authoredBy: string;
    evidenceRefs: string[];
  };
  ir: PlaybookIR;
  digest: string;
}
export interface PlaybookActivation {
  id: string;
  tenantId: string;
  definitionId: string;
  version: string;
  versionDigest: string;
  artifactDigest: string;
  grants: {
    principalIds: string[];
    connectionIds: string[];
    targetIds: string[];
  };
  policyVersion: string;
}
export interface PlaybookSnapshot {
  inputs: Record<string, PlaybookScalar>;
  evidence: {
    kind: string;
    facts: Record<string, PlaybookScalar>;
    observations: { id: string; observedAt: string; source: string }[];
  };
  provenance: { reference: string; capturedAt: string };
}
export function playbookValue(
  value: PlaybookValue,
  snapshot: PlaybookSnapshot,
): PlaybookScalar {
  if (value.source === 'literal') return value.value;
  const fields =
    value.source === 'input' ? snapshot.inputs : snapshot.evidence.facts;
  if (!Object.hasOwn(fields, value.field))
    throw new Error('Missing playbook value');
  return fields[value.field]!;
}
export function playbookEligible(
  ir: PlaybookIR,
  snapshot: PlaybookSnapshot,
  now: number,
): 'eligible' | 'ineligible' | 'stale_evidence' {
  const captured = Date.parse(snapshot.provenance.capturedAt);
  if (
    !Number.isFinite(captured) ||
    captured > now ||
    !snapshot.evidence.observations.length ||
    snapshot.evidence.observations.some((item) => {
      const time = Date.parse(item.observedAt);
      return (
        !Number.isFinite(time) ||
        time > captured ||
        now - time >= ir.evidence.maxAgeSeconds * 1000
      );
    })
  )
    return 'stale_evidence';
  return ir.eligibility.all.every(
    (check) =>
      Object.hasOwn(snapshot.evidence.facts, check.field) &&
      snapshot.evidence.facts[check.field] === check.equals,
  )
    ? 'eligible'
    : 'ineligible';
}
