import type { CaseSummary } from '@luma/api-contract';
import {
  elapsed,
  issueKind,
  issueStatus,
} from '@luma/ui/components/issues/case-presentation';
import { expect, it } from 'vitest';

const base = {
  state: 'executing',
  resolution: null,
  diagnosisStatus: 'ready',
  attention: {
    required: false,
    reason: null,
    explanation: '',
    requestedAt: null,
  },
} satisfies Pick<
  CaseSummary,
  'state' | 'attention' | 'resolution' | 'diagnosisStatus'
>;

it('puts decisions for a person ahead of Luma’s progress', () => {
  expect(
    issueStatus({
      ...base,
      attention: { ...base.attention, required: true, reason: 'approval' },
    }),
  ).toEqual({ state: 'approval', label: 'Needs approval' });
  expect(issueStatus(base)).toEqual({
    state: 'running',
    label: 'Sending change',
  });
});

it('only reports verified when the outcome was observed', () => {
  expect(
    issueStatus({ ...base, state: 'resolved', resolution: 'verified' }),
  ).toEqual({ state: 'verified', label: 'Verified' });
  expect(
    issueStatus({
      ...base,
      state: 'resolved',
      resolution: 'human_disposition',
    }),
  ).toEqual({ state: 'idle', label: 'Closed' });
});

it('names the required step without implying the reader can approve or execute it', () => {
  expect(
    issueStatus({
      ...base,
      attention: {
        ...base.attention,
        required: true,
        reason: 'manual_intervention',
      },
    }),
  ).toEqual({ state: 'attention', label: 'Manual step required' });
  expect(
    issueStatus({
      ...base,
      attention: { ...base.attention, required: true, reason: 'uncertainty' },
    }),
  ).toEqual({ state: 'attention', label: 'Review evidence' });
});

it('describes issue kinds and elapsed time compactly', () => {
  expect(issueKind({ class: 'stuck_fulfillment' })).toEqual({
    label: 'Fulfillment delay',
    domain: 'fulfillment',
  });
  expect(
    elapsed('2026-01-01T00:00:00Z', Date.parse('2026-01-01T02:30:00Z')),
  ).toBe('2h');
});
