import type { ActionAdmission } from '@luma/execution';
import { makeTenantContext } from '@luma/identity';
import { expect, it, vi } from 'vitest';

import { processVersion } from '../domain/process.fixture.js';
import type { ProcessStep, ProcessWorkflowVersion } from '../domain/process.js';
import type { WorkflowTriggerRun } from '../domain/workflow.js';
import { createProcessActivities } from './process-activities.js';
import { runProcess } from './process-runtime.js';

it('admits each consequential step independently under the exact run and version', async () => {
  const action = processVersion.steps[3]!;
  const verification = processVersion.steps[4]!;
  if (action.kind !== 'capability' || verification.kind !== 'verification')
    throw new Error('Invalid process fixture');
  const second: ProcessStep[] = [
    {
      id: 'review2',
      kind: 'approval',
      forStep: 'reserve2',
      expiresAfterSeconds: 3600,
    },
    { ...action, id: 'reserve2' },
    { ...verification, id: 'verify2', forStep: 'reserve2' },
  ];
  const version: ProcessWorkflowVersion = {
    ...processVersion,
    steps: [
      ...processVersion.steps.slice(0, 5),
      ...second,
      processVersion.steps[6]!,
    ],
  };
  const tenantId = 'tenant';
  const userId = 'operator';
  const context = makeTenantContext(
    { userId, sessionId: 'session' },
    {
      id: tenantId,
      name: 'Tenant',
      slug: 'tenant',
      dataRegion: 'EU',
      status: 'active',
    },
    { id: 'membership', organizationId: tenantId, userId, role: 'owner' },
    'request',
  );
  const run: WorkflowTriggerRun = {
    id: 'run',
    tenantId,
    definitionId: version.definition.id,
    version: version.version,
    versionDigest: version.digest,
    activationId: null,
    artifactDigest: null,
    trigger: { kind: 'manual' },
    subject: { kind: 'order', id: 'order' },
    actor: { kind: 'user', id: userId },
    context: {
      inputs: { quantity: 2 },
      evidence: {
        kind: 'inventory',
        facts: { ready: true },
        observations: [
          {
            id: 'observation',
            observedAt: '2026-09-27T00:00:00Z',
            source: 'inventory',
          },
        ],
      },
      provenance: { reference: 'source', capturedAt: '2026-09-27T00:00:00Z' },
    },
    contextDigest: 'snapshot',
    evidence: { sourceId: 'manual', occurredAt: '2026-09-27T00:00:00Z' },
    requestDigest: 'request',
    createdAt: '2026-09-27T00:00:00Z',
    state: 'awaiting_admission',
    triggeredAt: '2026-09-27T00:00:00Z',
  };
  const execute = vi.fn(
    async (
      _context: unknown,
      reference: { runId: string; stepId: string },
    ) => ({
      state: 'succeeded',
      record: {
        proposalId: reference.stepId,
        admission: { runId: reference.runId, stepId: reference.stepId },
        attempt: { id: `receipt-${reference.stepId}` },
      },
    }),
  );
  const outputs: string[] = [];
  const activities = createProcessActivities({
    resolveContext: async () => context,
    loadRun: async () => run,
    loadVersion: async () => version,
    admission: {
      get: async () => null,
      execute,
      reconcile: async () => {
        throw new Error('Unexpected reconciliation');
      },
    } as unknown as Pick<ActionAdmission, 'get' | 'execute' | 'reconcile'>,
    bindAction: async (_context, _run, _version, step) => ({
      proposalId: step.id,
    }),
    read: async () => ({
      values: { ready: true },
      evidenceRefs: ['read'],
      observedAt: '2026-09-27T00:00:00Z',
    }),
    decision: async () => ({ state: 'approved', decisionId: 'decision' }),
    verify: async () => ({
      state: 'verified',
      values: { reserved: true },
      evidenceRefs: ['verification'],
    }),
    record: async (_context, _runId, output) => {
      outputs.push(output.stepId);
    },
  });
  const result = await runProcess(run, version, activities, {
    now: () => '2026-09-27T00:00:00Z',
    wait: async () => undefined,
    decisionChanged: async () => true,
  });
  expect(result.state).toBe('verified');
  expect(execute.mock.calls.map((call) => call[1])).toEqual([
    { runId: 'run', stepId: 'reserve' },
    { runId: 'run', stepId: 'reserve2' },
  ]);
  expect(outputs).toContain('verify2');
});
