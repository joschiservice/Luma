import { describe, expect, it } from 'vitest';
import { learningCommandSchema, startResolutionRunSchema } from './learning.js';
const id = 'a2336206-b73a-48f3-8dc0-912ebae80f50';
const command = (fact: unknown) => ({
  id,
  occurredAt: '2026-09-20T08:00:00.000Z',
  fact,
});
describe('resolution learning contracts', () => {
  it('requires a prior version or code reference for the corresponding reuse classification', () => {
    const input = {
      id,
      diagnosisRevision: 1,
      resolution: {
        id: 'repair-stock',
        version: '2',
        reasonCode: 'correct_mapping',
        use: 'improved',
      },
    };
    expect(startResolutionRunSchema.safeParse(input).success).toBe(false);
    expect(
      startResolutionRunSchema.safeParse({
        ...input,
        resolution: { ...input.resolution, previousVersion: '1' },
      }).success,
    ).toBe(true);
    expect(
      startResolutionRunSchema.safeParse({
        ...input,
        resolution: { ...input.resolution, previousVersion: '2' },
      }).success,
    ).toBe(false);
    expect(
      startResolutionRunSchema.safeParse({
        ...input,
        resolution: { ...input.resolution, use: 'partner_specific' },
      }).success,
    ).toBe(false);
    expect(
      startResolutionRunSchema.safeParse({
        ...input,
        resolution: {
          ...input.resolution,
          use: 'partner_specific',
          partnerCodeRef: 'git:abc123',
        },
      }).success,
    ).toBe(true);
  });
  it('requires investigator evidence for confirmed and rejected causes', () => {
    const fact = {
      kind: 'cause',
      code: 'mapping_error',
      status: 'suspected',
      basis: 'model_hypothesis',
      supportingEvidenceRefs: [],
      contradictingEvidenceRefs: [],
    };
    expect(learningCommandSchema.safeParse(command(fact)).success).toBe(true);
    for (const status of ['confirmed', 'rejected']) {
      expect(
        learningCommandSchema.safeParse(
          command({
            ...fact,
            status,
            supportingEvidenceRefs: ['evidence'],
            contradictingEvidenceRefs: ['evidence'],
          }),
        ).success,
      ).toBe(false);
      expect(
        learningCommandSchema.safeParse(
          command({ ...fact, status, basis: 'operator_investigation' }),
        ).success,
      ).toBe(false);
    }
    expect(
      learningCommandSchema.safeParse(
        command({
          ...fact,
          status: 'confirmed',
          basis: 'operator_investigation',
          supportingEvidenceRefs: ['evidence'],
        }),
      ).success,
    ).toBe(true);
  });
  it('rejects injected actor identities and customer payloads', () => {
    const value = command({
      kind: 'observation',
      stepId: 'read',
      code: 'found',
      evidenceRefs: ['evidence'],
    });
    expect(
      learningCommandSchema.safeParse({ ...value, actorId: 'another-operator' })
        .success,
    ).toBe(false);
    expect(
      learningCommandSchema.safeParse(
        command({
          ...(value.fact as object),
          rawPayload: { customerEmail: 'private@example.test' },
        }),
      ).success,
    ).toBe(false);
  });
});
