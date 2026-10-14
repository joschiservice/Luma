import { describe, expect, it } from 'vitest';

import { activityQuerySchema } from './activity.js';

const window = { from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' };
const person = '22222222-2222-4222-8222-222222222222';

describe('activity actor parameter', () => {
  it('parses comma-separated actors', () => {
    expect(
      activityQuerySchema.parse({
        ...window,
        actor: `me,luma,workflow,${person.toUpperCase()}`,
      }).actor,
    ).toEqual(['me', 'luma', 'workflow', person]);
  });

  it('refuses other values and more than 20 actors', () => {
    expect(
      activityQuerySchema.safeParse({ ...window, actor: 'everyone' }).success,
    ).toBe(false);
    expect(
      activityQuerySchema.safeParse({
        ...window,
        actor: Array.from({ length: 21 }, () => 'luma').join(','),
      }).success,
    ).toBe(false);
  });
});
