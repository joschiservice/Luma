import { describe, expect, it, vi } from 'vitest';

import { processVersion } from '../domain/process.fixture.js';
import { type ProcessActivities, runProcess } from './process-runtime.js';

const version = processVersion;
const run = {
  id: 'run',
  tenantId: 'tenant',
  definitionId: version.definition.id,
  version: version.version,
  versionDigest: version.digest,
  subject: { kind: 'order', id: 'order' },
  actor: { kind: 'user' as const, id: 'user' },
  context: {
    inputs: { quantity: 2 },
    evidence: {
      kind: 'inventory',
      facts: { ready: true },
      observations: [
        {
          id: 'evidence',
          observedAt: '2026-09-27T00:00:00Z',
          source: 'inventory',
        },
      ],
    },
    provenance: { reference: 'source', capturedAt: '2026-09-27T00:00:00Z' },
  },
  contextDigest: 'digest',
  createdAt: '2026-09-27T00:00:00Z',
};

function fixture(
  verification: 'verified' | 'failed' | 'inconclusive' = 'verified',
) {
  const outputs: { stepId: string; state: string }[] = [];
  const activities: ProcessActivities = {
    read: vi.fn(async () => ({
      values: { ready: true },
      evidenceRefs: ['read-1'],
      observedAt: '2026-09-27T00:00:00Z',
    })),
    decision: vi.fn(async () => ({
      state: 'approved' as const,
      decisionId: 'decision',
    })),
    action: vi.fn(async () => ({
      state: 'accepted' as const,
      proposalId: 'proposal',
      receiptId: 'receipt',
    })),
    verify: vi.fn(async () => ({
      state: verification,
      evidenceRefs: ['verification-1'],
      values: { reserved: verification === 'verified' },
    })),
    record: vi.fn(async (_run, output) => {
      outputs.push(output);
    }),
  };
  const clock = {
    now: () => '2026-09-27T00:00:00Z',
    wait: vi.fn(async () => undefined),
    decisionChanged: vi.fn(async () => true),
  };

  return { outputs, activities, clock };
}

describe('process interpreter', () => {
  it('runs ordered steps and records evidence for each effect', async () => {
    const f = fixture();
    const result = await runProcess(run, version, f.activities, f.clock);
    expect(result.state).toBe('verified');
    expect(f.outputs.map((item) => item.stepId)).toEqual([
      ...version.steps.slice(0, -1).map((step) => step.id),
      'settle',
      'finish',
    ]);
    expect(f.outputs.find((item) => item.stepId === 'reserve')).toMatchObject({
      state: 'completed',
      evidenceRefs: ['receipt'],
    });
    expect(f.clock.wait).toHaveBeenCalledWith(5000);
  });
  it.each(['failed', 'inconclusive'] as const)(
    'keeps %s verification distinct from completion',
    async (verification) => {
      const f = fixture(verification);
      const result = await runProcess(run, version, f.activities, f.clock);
      expect(result.state).toBe(
        verification === 'failed'
          ? 'failed_verification'
          : 'inconclusive_verification',
      );
      expect(f.outputs.some((item) => item.stepId === 'finish')).toBe(false);
    },
  );
  it('rejects an altered run binding before any activity', async () => {
    const f = fixture();
    await expect(
      runProcess(
        { ...run, versionDigest: 'other' },
        version,
        f.activities,
        f.clock,
      ),
    ).rejects.toThrow('not bound');
    expect(f.activities.read).not.toHaveBeenCalled();
  });
});
