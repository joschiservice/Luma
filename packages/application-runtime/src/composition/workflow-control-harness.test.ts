import { builtInMembership, makeTenantContext } from '@luma/identity';
import type { ProcessWorkflowVersion } from '@luma/workflows';
import { expect, it, vi } from 'vitest';

import { createWorkflowImprovementControlHarness } from './workflow-control-harness.js';

const context = makeTenantContext(
  { userId: 'operator', sessionId: 'session' },
  {
    id: 'tenant',
    name: 'Fixture',
    slug: 'fixture',
    status: 'active',
    dataRegion: 'AU',
  },
  builtInMembership(
    { id: 'membership', organizationId: 'tenant', userId: 'operator' },
    'owner',
  ),
  'request',
);
const baseline: ProcessWorkflowVersion = {
  schemaVersion: 2,
  format: 'workflow/2',
  definition: {
    id: 'sync',
    name: 'Sync',
    intent: 'Inspect sync',
    category: 'operations',
  },
  version: '1',
  digest: 'a'.repeat(64),
  applicability: { trigger: { kind: 'manual' }, subjectKind: 'connection' },
  inputs: {},
  context: { kind: 'sync_failure', fields: {}, maxAgeSeconds: 300 },
  steps: [{ id: 'end', kind: 'end', outcome: 'Inspected' }],
  provenance: {
    kind: 'native',
    reference: 'synthetic',
    authoredBy: 'operator',
    evidenceRefs: [],
  },
};

it.each(['steps', 'actions', 'waits', 'coordination'] as const)(
  'refuses unsupported %s before allocating resources or executing effects',
  async (kind) => {
    const candidate = structuredClone(baseline);
    if (kind === 'steps')
      candidate.steps = Array.from({ length: 25 }, (_, index) => ({
        id: `wait-${index}`,
        kind: 'wait',
        seconds: 1,
      }));
    if (kind === 'waits')
      candidate.steps = [{ id: 'wait', kind: 'wait', seconds: 61 }];
    if (kind === 'actions')
      candidate.steps = Array.from({ length: 5 }, (_, index) => ({
        id: `action-${index}`,
        kind: 'capability',
        capability: 'stock.reserve',
        capabilityVersion: '1',
        targetKind: 'sku',
        minimumRisk: 'medium',
        parameters: {},
        expectedPostcondition: {},
      }));
    if (kind === 'coordination')
      candidate.steps = [
        {
          id: 'task',
          kind: 'human_task',
          assignee: { kind: 'role', key: 'owner' },
          instructions: 'Review',
          choices: ['Continue'],
          evidence: 'text',
          dueAfterSeconds: 60,
          escalationTarget: { kind: 'role', key: 'owner' },
        },
      ];
    const open = vi.fn();
    const harness = createWorkflowImprovementControlHarness({
      identity: { refreshContext: async (current) => current },
      open,
    });
    await expect(
      harness.evaluate(context, baseline, candidate),
    ).rejects.toThrow('Control evaluation supports');
    expect(open).not.toHaveBeenCalled();
  },
);
