import { expect, it } from 'vitest';

import { caseDecisionSchema } from './desk.js';

const close = {
  commandId: '11111111-1111-4111-8111-111111111111',
  kind: 'close',
  caseRevision: 1,
  diagnosisRevision: 0,
  reason: 'False positive',
};

it('allows closure without a proposal or evidence, with a trimmed required reason', () => {
  expect(
    caseDecisionSchema.parse({ ...close, reason: '  False positive  ' }),
  ).toEqual({ ...close, evidenceRefs: [] });
  expect(
    caseDecisionSchema.safeParse({ ...close, reason: 'a'.repeat(1000) })
      .success,
  ).toBe(true);
});

it('rejects blank or oversized closure reasons, unbounded evidence and caller authority fields', () => {
  for (const extra of [
    { reason: '   ' },
    { reason: 'a'.repeat(1001) },
    { evidenceRefs: Array(101).fill('evidence') },
    { actorId: 'other' },
    { kind: 'human_disposition' },
    { verified: true },
  ])
    expect(caseDecisionSchema.safeParse({ ...close, ...extra }).success).toBe(
      false,
    );
});
