import type { ProcessWorkflowVersion } from '@luma/workflows';

const streamFields: ProcessWorkflowVersion['inputs'] = {
  ready: 'boolean',
  accessLost: 'boolean',
  failing: 'boolean',
  errorCode: 'string',
};

/**
 * Tells lost access from a passing outage when a connection's reads keep failing. Lost access goes
 * to a person at once; otherwise the run waits, checks again and hands over only if reads still
 * fail. It changes nothing in connected systems.
 */
export const connectionCheckSource: Omit<
  ProcessWorkflowVersion,
  'digest' | 'format'
> = {
  schemaVersion: 2,
  definition: {
    id: 'connection-sync-check',
    name: 'Check a failing connection',
    intent:
      'When a connection’s reads keep failing, hand lost access to a person straight away. Otherwise wait 15 minutes, check again, and hand the case over only if reads still fail.',
    category: 'connections',
  },
  version: '1.0.0',
  applicability: {
    trigger: { kind: 'exception', issueType: 'sync_failure' },
    subjectKind: 'connection',
  },
  inputs: { activationId: 'string', caseId: 'string' },
  context: {
    kind: 'sync_failure',
    fields: { severity: 'string' },
    maxAgeSeconds: 300,
  },
  steps: [
    {
      id: 'failure',
      kind: 'read',
      source: 'sync.stream',
      fields: streamFields,
    },
    {
      id: 'found',
      kind: 'condition',
      field: 'ready',
      equals: true,
      onFalse: 'escalate',
    },
    {
      id: 'access',
      kind: 'condition',
      field: 'accessLost',
      equals: false,
      onFalse: 'escalate',
    },
    {
      id: 'still-failing',
      kind: 'condition',
      field: 'failing',
      equals: true,
      onFalse: 'end',
    },
    { id: 'grace', kind: 'wait', seconds: 900 },
    {
      id: 'recheck',
      kind: 'read',
      source: 'sync.stream',
      fields: streamFields,
    },
    {
      id: 'recovered',
      kind: 'condition',
      field: 'failing',
      equals: false,
      onFalse: 'escalate',
    },
    {
      id: 'done',
      kind: 'end',
      outcome: 'Reads recovered without intervention',
    },
  ],
  provenance: {
    kind: 'native',
    reference: 'resolution-case-workflows/1',
    authoredBy: 'Luma',
    evidenceRefs: ['commerce-sync-v1'],
  },
};

/** Error codes that mean Luma lost access rather than a provider failing for a while. */
export const accessErrorCodes: readonly string[] = [
  'authentication',
  'permission_denied',
];
