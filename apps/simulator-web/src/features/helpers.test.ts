import type { IncidentView } from '@luma/simulator-contract';
import { describe, expect, it } from 'vitest';

import { incidentStatusText } from '../lib/labels';
import { detectionText } from './incidents/incidents-view';
import { mergeJournal } from './journal/journal-view';
import { windowLength } from './overview/overview-view';
import { parseCommand } from './providers/merchant-actions';
import { driftText } from './providers/sku-lookup';
import { detectionRate } from './scorecard/scorecard-view';

const entry = (sequence: number) => ({
  sequence,
  time: sequence * 1_000,
  kind: 'order',
  detail: null,
});

describe('journal', () => {
  it('merges pages newest first without repeats', () => {
    expect(
      mergeJournal([entry(5), entry(4)], [entry(4), entry(2)]).map(
        (e) => e.sequence,
      ),
    ).toEqual([5, 4, 2]);
  });
});

describe('incidents', () => {
  const incident: IncidentView = {
    id: 'i',
    kind: 'shipment-sync-failure',
    label: 'Shipment not synced',
    status: 'active',
    origin: 'injected',
    startedAt: 1_000,
    endedAt: null,
    instance: null,
    summary: '',
    resources: [],
    expected: { exceptionClass: 'stuck_fulfillment', surface: 'case' },
    detection: {
      state: 'detected',
      caseId: 'c',
      caseUrl: null,
      detectedAt: 301_000,
      resolved: false,
      verified: false,
    },
  };

  it('states detection with its delay', () => {
    expect(detectionText(incident)).toBe('Detected in 5 min');
    expect(detectionText({ ...incident, detection: null })).toBe(
      'Not evaluated',
    );
  });

  it('says what a planned incident waits for', () => {
    expect(incidentStatusText({ ...incident, status: 'planned' })).toBe(
      'Planned · waits for the order to ship',
    );
    expect(incidentStatusText(incident)).toBe('Active');
  });

  it('computes the detection rate over decided incidents', () => {
    expect(detectionRate({ detected: 3, missed: 1 })).toBe(0.75);
    expect(detectionRate({ detected: 0, missed: 0 })).toBeNull();
  });
});

describe('providers', () => {
  it('describes stock drift', () => {
    expect(driftText(0)).toBe('In sync');
    expect(driftText(4)).toBe('Shop shows 4 more');
    expect(driftText(-2)).toBe('Shop shows 2 fewer');
    expect(driftText(null)).toBe('Not comparable');
  });

  it('accepts only JSON objects as commands', () => {
    expect(parseCommand('{"kind":"stock"}')).toEqual({
      command: { kind: 'stock' },
    });
    expect(parseCommand('[1]')).toHaveProperty('error');
    expect(parseCommand('{')).toHaveProperty('error');
  });
});

describe('overview window', () => {
  it('measures today from local midnight, rounded down to the minute', () => {
    const now = new Date(2026, 9, 3, 0, 0, 30).getTime();
    expect(windowLength('today', now)).toBe(60_000);
    expect(windowLength('today', new Date(2026, 9, 3, 2, 0, 1).getTime())).toBe(
      2 * 3_600_000,
    );
    expect(windowLength('7d', now)).toBe(7 * 86_400_000);
  });
});
