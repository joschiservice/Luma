import { expect } from 'vitest';

/**
 * Resolves what a record cites through the evidence API and asserts that every reference
 * resolves to a stored read, a write receipt or a Luma record: none is reported as not retained
 * or unresolved, and none is cut off. `resolve` posts the body to
 * `/v1/organizations/:organizationId/evidence/resolve` as the journey's reader. Returns the items.
 */
export async function expectResolvedEvidence(resolve, subject, refs) {
  const result = await resolve({ subject, ...(refs ? { refs } : {}) });
  expect(result.subject).toEqual(subject);
  expect(result.truncated).toBe(false);
  for (const item of result.items)
    expect(
      ['read', 'write_receipt', 'luma_record'],
      `${item.ref} resolved to ${JSON.stringify(item.resolution)}`,
    ).toContain(item.resolution.kind);
  for (const item of result.items)
    if (item.resolution.kind === 'read')
      expect(item.resolution).toMatchObject({
        provider: expect.any(String),
        connection: { id: expect.any(String) },
        observedAt: expect.any(String),
      });

  return result.items;
}
