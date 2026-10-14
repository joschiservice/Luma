import { builtInMembership, makeTenantContext } from '@luma/identity';
import { expect, it } from 'vitest';

import { evaluateWorkflowImprovement } from '../application/improvement-evaluation.js';
import { draftFromVersion } from '../domain/draft.js';
import { processVersion } from '../domain/process.fixture.js';
import { playbookHash } from './playbooks/schema.js';
import { checkDraftContent } from './process-schema.js';

const context = makeTenantContext(
  { userId: 'operator', sessionId: 'session' },
  {
    id: 'tenant',
    name: 'Tenant',
    slug: 'tenant',
    dataRegion: 'AU',
    status: 'active',
  },
  builtInMembership(
    { id: 'membership', organizationId: 'tenant', userId: 'operator' },
    'admin',
  ),
  'request',
);
const baseline = draftFromVersion(processVersion);
const compile = (content: typeof baseline) => {
  const checked = checkDraftContent(content, {
    kind: 'native',
    reference: 'trusted',
    authoredBy: 'operator',
    evidenceRefs: ['trusted-synthetic-fixture'],
  });
  if (!checked.version) throw new Error(JSON.stringify(checked.diagnostics));

  return checked.version;
};

it('runs the production interpreter with independent faults, no unexpected writes and reproducible restart markers', async () => {
  const request = {
    context,
    baseline,
    candidate: baseline,
    compile,
    hash: playbookHash,
  };
  const report = await evaluateWorkflowImprovement(request);
  expect(report.passed).toBe(true);
  expect(report.scenarios).toHaveLength(8);
  expect(
    report.scenarios.find((item) => item.id === 'ordinary')?.candidate.outcome,
  ).toBe('verified');
  for (const id of [
    'approval-denied',
    'policy-denied',
    'provider-outage',
    'stale-observation',
  ])
    expect(
      report.scenarios.find((item) => item.id === id)?.candidate.effects,
    ).toEqual([]);
  expect(
    report.scenarios.find((item) => item.id === 'verification-ambiguous')
      ?.candidate.outcome,
  ).not.toBe('verified');
  expect(
    report.scenarios.find((item) => item.id === 'restart-replay')?.candidate
      .effects,
  ).toHaveLength(1);
  expect(report.missingCoverage).toContain(
    'historical_provider_reconstruction',
  );
  expect(report).toEqual(await evaluateWorkflowImprovement(request));
});

it('retains counterexamples for a changed action quantity and refuses weaker human control', async () => {
  const changed = structuredClone(baseline);
  const action = changed.steps.find((step) => step.kind === 'capability');
  if (action?.kind !== 'capability') throw new Error('Fixture has no action');
  action.parameters.quantity = { source: 'literal', value: 999 };
  const report = await evaluateWorkflowImprovement({
    context,
    baseline,
    candidate: changed,
    compile,
    hash: playbookHash,
  });
  expect(report.passed).toBe(false);
  expect(report.counterexamples).toContain('ordinary');
  expect(
    report.scenarios.find((item) => item.id === 'ordinary')?.candidate
      .effects[0]?.parameters.quantity,
  ).toBe(999);
});
