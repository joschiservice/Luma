import { builtInMembership, makeTenantContext } from '@luma/identity';
import { expect, it } from 'vitest';

import { compareHistoricalImprovement } from '../application/historical-improvement.js';
import { draftFromVersion } from '../domain/draft.js';
import { processSource } from '../domain/process.fixture.js';
import type { HistoricalProcessCapture } from '../domain/workflow-improvement.js';
import { playbookHash } from './playbooks/schema.js';
import { compileProcessWorkflow } from './process-schema.js';

const context = makeTenantContext(
  { userId: 'operator', sessionId: 'session' },
  {
    id: 'tenant',
    name: 'Tenant',
    slug: 'tenant',
    dataRegion: 'EU',
    status: 'active',
  },
  builtInMembership(
    { id: 'member', organizationId: 'tenant', userId: 'operator' },
    'owner',
  ),
  'request',
);
const version = compileProcessWorkflow(processSource);
const baseline = draftFromVersion(version);

function capture(capturedVersion = version): HistoricalProcessCapture {
  const version = capturedVersion;
  const createdAt = '2026-01-01T00:00:00.000Z';
  const snapshot = {
    inputs: { quantity: 2 },
    evidence: {
      kind: 'inventory',
      facts: { ready: true },
      observations: [
        { id: 'source', source: 'provider', observedAt: createdAt },
      ],
    },
    provenance: { reference: 'case:incident', capturedAt: createdAt },
  };
  const outputs: HistoricalProcessCapture['outputs'] = version.steps.map(
    (step) => ({
      stepId: step.id,
      kind: step.kind,
      state: 'completed',
      values:
        step.kind === 'read'
          ? { ready: true }
          : step.kind === 'condition'
            ? { matched: true }
            : step.kind === 'approval'
              ? { approved: true }
              : step.kind === 'capability'
                ? { proposalId: 'proposal' }
                : step.kind === 'verification'
                  ? { reserved: true }
                  : step.kind === 'end'
                    ? { outcome: step.outcome }
                    : {},
      evidenceRefs: [step.kind === 'capability' ? 'receipt' : 'source'],
      recordedAt: step.kind === 'end' ? '2026-01-01T00:00:05.000Z' : createdAt,
      ...(step.kind === 'read' ? { observedAt: createdAt } : {}),
    }),
  );

  return {
    version,
    run: {
      id: 'run',
      tenantId: 'tenant',
      definitionId: version.definition.id,
      version: version.version,
      versionDigest: version.digest,
      subject: { kind: 'order', id: 'order' },
      actor: { kind: 'user', id: 'operator' },
      context: snapshot,
      contextDigest: playbookHash(snapshot),
      createdAt,
    },
    outputs,
  };
}

it('reconstructs pinned captured reads and decisions through the production interpreter without dispatch', async () => {
  const request = {
    context,
    baseline,
    candidate: version,
    captures: [capture()],
    hash: playbookHash,
  };
  const report = await compareHistoricalImprovement(request);
  expect(report).toMatchObject({
    passed: true,
    missingInputs: [],
    captures: [
      {
        passed: true,
        baseline: { outcome: 'verified' },
        candidate: { outcome: 'verified' },
      },
    ],
  });
  expect(report.captures[0]?.baseline.effects[0]?.parameters).toEqual({
    quantity: 2,
  });
  expect(await compareHistoricalImprovement(request)).toEqual(report);
});
it('retains a changed-quantity counterexample and fails closed on unavailable or foreign capture inputs', async () => {
  const changed = structuredClone(baseline);
  const action = changed.steps.find((step) => step.kind === 'capability');
  if (action?.kind !== 'capability') throw new Error('Missing fixture action');
  action.parameters.quantity = { source: 'literal', value: 999 };
  const report = await compareHistoricalImprovement({
    context,
    baseline,
    candidate: compileProcessWorkflow({
      ...changed,
      provenance: version.provenance,
    }),
    captures: [capture()],
    hash: playbookHash,
  });
  expect(report.passed).toBe(false);
  expect(report.counterexamples).toEqual(['run']);
  const partial = capture();
  partial.outputs = partial.outputs.filter((output) => output.kind !== 'read');
  const missing = await compareHistoricalImprovement({
    context,
    baseline,
    candidate: version,
    captures: [partial],
    hash: playbookHash,
  });
  expect(missing.passed).toBe(false);
  expect(missing.missingInputs).toContain('step:refresh');
  partial.run.tenantId = 'foreign';
  expect(
    (
      await compareHistoricalImprovement({
        context,
        baseline,
        candidate: version,
        captures: [partial],
        hash: playbookHash,
      })
    ).missingInputs,
  ).toContain('capture_binding');
});

it('reconstructs a sync read-only recovery with two independently captured reads', async () => {
  const sync = compileProcessWorkflow({
    ...processSource,
    definition: { ...processSource.definition, id: 'sync-check' },
    applicability: {
      trigger: { kind: 'exception', issueType: 'sync_failure' },
      subjectKind: 'connection',
    },
    context: { ...processSource.context, kind: 'sync_failure' },
    steps: [
      processSource.steps[0],
      processSource.steps[1],
      processSource.steps[5],
      { ...processSource.steps[0], id: 'recheck' },
      processSource.steps[6],
    ],
  });
  const retained = capture(sync);
  retained.run.subject.kind = 'connection';
  retained.run.context.evidence.kind = 'sync_failure';
  retained.run.contextDigest = playbookHash(retained.run.context);
  expect(
    await compareHistoricalImprovement({
      context,
      baseline: draftFromVersion(sync),
      candidate: sync,
      captures: [retained],
      hash: playbookHash,
    }),
  ).toMatchObject({ passed: true, missingInputs: [] });
});
