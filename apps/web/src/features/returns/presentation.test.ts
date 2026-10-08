import { describe, expect, it } from 'vitest';

import { returnListQuery } from './data';
import {
  accessMessage,
  nextStep,
  refundOutcome,
  refundSummary,
  returnSteps,
} from './presentation';
import { detail, returnItem, sources } from './returns-fixtures';

describe('refund wording', () => {
  it('never presents pending, failed or recorded refunds as money returned', () => {
    const refund = returnItem().refund;
    expect(
      refundSummary({ refund: { ...refund, state: 'pending', pending: '48' } }),
    ).toBe('€48.00 processing');
    expect(
      refundSummary({
        refund: { ...refund, state: 'failed', failedAttempts: 2 },
      }),
    ).toBe('2 payments failed');
    expect(refundSummary({ refund: { ...refund, state: 'recorded' } })).toBe(
      'Recorded without payment',
    );
    expect(
      refundSummary({
        refund: {
          ...refund,
          state: 'partial',
          refunded: '24',
          pending: '24',
        },
      }),
    ).toBe('€24.00 refunded · €24.00 processing');
    expect(refundSummary({ refund })).toBe('Not refunded');
  });

  it('summarizes a refund by its payment attempts', () => {
    const payment = detail.refunds[0]!.transactions[0]!;
    expect(refundOutcome([payment])).toBe('failed');
    expect(refundOutcome([payment, { ...payment, status: 'success' }])).toBe(
      'success',
    );
    expect(
      refundOutcome([
        { ...payment, status: 'success' },
        { ...payment, status: 'pending' },
      ]),
    ).toBe('pending');
    expect(refundOutcome([])).toBe('unknown');
  });
});

describe('next steps', () => {
  it('names the owner of the next step in the source’s terms', () => {
    expect(nextStep(returnItem({ stage: 'requested' }), 'shopify')).toBe(
      'Review the request, then approve or decline it in Shopify.',
    );
    expect(nextStep(returnItem(), 'shopify')).toBe(
      'Waiting for 1 unit to arrive back. 1 of 2 received.',
    );
    expect(
      nextStep(
        returnItem({ stage: 'awaiting_refund', refundedUnits: '1' }),
        null,
      ),
    ).toBe('Refund the remaining 1 unit in the connected system.');
    expect(
      nextStep(
        returnItem({
          stage: 'refund_pending',
          refund: { ...returnItem().refund, pending: '48' },
        }),
        'shopify',
      ),
    ).toMatch(/^€48.00 is processing.*hasn’t received it yet\.$/);
  });

  it('explains missing access by connection kind', () => {
    expect(accessMessage(sources[0]!)).toBeNull();
    expect(accessMessage(sources[1]!)).toMatch(
      /JTL-Wawi doesn’t share returns with Luma/,
    );
    expect(accessMessage({ ...sources[0]!, access: 'not_requested' })).toMatch(
      /Reconnect it to share returns/,
    );
    expect(accessMessage({ ...sources[0]!, access: 'not_granted' })).toMatch(
      /hasn’t granted access/,
    );
  });
});

describe('return progress', () => {
  it('marks each step from source facts without assuming unreported ones', () => {
    const steps = returnSteps(detail);
    expect(steps.map((step) => [step.key, step.state])).toEqual([
      ['requested', 'done'],
      ['approved', 'done'],
      ['received', 'done'],
      ['refunded', 'current'],
      ['closed', 'upcoming'],
    ]);
    expect(steps[3]!.detail).toBe('€48.00 processing');
    const unreported = returnSteps({
      ...detail,
      item: returnItem({ received: null }),
    });
    expect(unreported[2]).toMatchObject({
      state: 'unreported',
      detail: 'The source doesn’t report returned items',
    });
  });

  it('stops a declined return after the decision', () => {
    const steps = returnSteps({
      ...detail,
      item: returnItem({ status: 'declined', stage: 'declined' }),
      timeline: {
        ...detail.timeline,
        approvedAt: null,
        declineReason: 'final_sale',
        closedAt: '2026-09-25T00:00:00.000Z',
      },
    });
    expect(steps.map((step) => step.state)).toEqual([
      'done',
      'failed',
      'skipped',
      'skipped',
      'skipped',
    ]);
    expect(steps[1]).toMatchObject({
      label: 'Declined',
      detail: 'Declined because the item was a final sale',
    });
  });
});

it('opens on pending work, oldest first, and maps sorting to the API', () => {
  expect(returnListQuery({})).toMatchObject({
    view: 'action',
    sort: 'requested',
    direction: 'asc',
  });
  expect(returnListQuery({ view: 'done' })).toMatchObject({
    direction: 'desc',
  });
  expect(returnListQuery({ sort: 'activity', q: ' #1001 ' })).toMatchObject({
    sort: 'activity',
    direction: 'desc',
    q: '#1001',
  });
});
