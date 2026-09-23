import { describe, expect, it } from 'vitest';

import { activityOutcome } from './activity-outcome.js';

describe('activity outcome evidence', () => {
  it('keeps approval, attempt and provider acceptance separate from verification', () => {
    expect(activityOutcome({ outcome: 'approved' })).toBe('approved');
    expect(
      activityOutcome({ action: 'execution.prepared', state: 'prepared' }),
    ).toBe('attempted');
    expect(activityOutcome({ dispatch: 'dispatched' })).toBe(
      'provider_accepted',
    );
    expect(activityOutcome({ state: 'succeeded' })).toBe('recorded');
  });
  it('preserves failed and uncertain verification even after provider acceptance', () => {
    expect(
      activityOutcome({ dispatch: 'dispatched', verification: 'failed' }),
    ).toBe('failed');
    expect(
      activityOutcome({ dispatch: 'dispatched', verification: 'inconclusive' }),
    ).toBe('uncertain');
    expect(
      activityOutcome({ dispatch: 'dispatched', verification: 'passed' }),
    ).toBe('verified');
  });
  it('retains canonical uncertainty after a negative reconciliation', () => {
    expect(
      activityOutcome({
        action: 'execution.reconciled',
        state: 'unknown',
        verification: 'failed',
        dispatch: 'dispatched',
      }),
    ).toBe('uncertain');
    expect(activityOutcome({ state: 'prepared', verification: 'failed' })).toBe(
      'uncertain',
    );
  });
  it('does not turn manual disposal or unknown resolution kinds into verified outcomes', () => {
    expect(activityOutcome({ resolution: 'human_disposition' })).toBe(
      'manually_disposed',
    );
    expect(activityOutcome({ resolution: 'verification' })).toBe('verified');
    expect(activityOutcome({ resolution: 'unknown' })).toBe('recorded');
  });
});
