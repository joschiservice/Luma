import { chaosPresets } from '@luma/simulator-core';
import { describe, expect, it } from 'vitest';

import {
  chaosProfileSchema,
  controlSchema,
  createRunSchema,
  injectIncidentSchema,
} from './index.js';

describe('control API schemas', () => {
  it('accepts every chaos preset as a complete profile', () => {
    for (const preset of Object.values(chaosPresets))
      expect(chaosProfileSchema.parse(preset)).toEqual(preset);
  });

  it('defaults new runs to the large merchant on JTL with realistic failures', () => {
    expect(createRunSchema.parse({ id: 'pilot-44' })).toEqual({
      id: 'pilot-44',
      seed: 44,
      profile: 'large',
      erp: 'jtl',
      chaos: 'realistic',
      running: true,
    });
    expect(() => createRunSchema.parse({ id: 'Pilot 44' })).toThrow();
    expect(() =>
      createRunSchema.parse({ id: 'pilot-44', erp: 'omni' }),
    ).toThrow();
  });

  it('rejects out-of-range controls and unknown incident kinds', () => {
    expect(() =>
      controlSchema.parse({ action: 'speed', speed: 1_000 }),
    ).toThrow();
    expect(() =>
      controlSchema.parse({ action: 'advance', milliseconds: 2 * 86_400_000 }),
    ).toThrow();
    expect(
      controlSchema.parse({
        action: 'fault',
        rule: { instance: 'jtl', operation: '*', kind: 'reset' },
      }),
    ).toMatchObject({ rule: { occurrence: 1, remaining: 1 } });
    expect(() =>
      injectIncidentSchema.parse({
        id: crypto.randomUUID(),
        kind: 'meteor-strike',
      }),
    ).toThrow();
  });
});
