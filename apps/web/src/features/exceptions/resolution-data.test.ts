import { afterEach, expect, it, vi } from 'vitest';

import { resolutionReview } from '../../../../../packages/ui/src/components/issues/resolution-fixtures';
import { IdentityError } from '../identity/data';
import {
  decisionCommand,
  decisionError,
  recoverDecision,
  refreshResolution,
  sameResolution,
  sendDecision,
} from './resolution-data';

const organizationId = '66666666-6666-4666-8666-666666666666';

const exceptionId = '77777777-7777-4777-8777-777777777777';

const commandId = '88888888-8888-4888-8888-888888888888';

afterEach(() => vi.unstubAllGlobals());

it.each(['approve', 'reject', 'escalate'] as const)(
  'sends versioned %s commands and recovers the original receipt',
  async (kind) => {
    const command = decisionCommand(
      resolutionReview,
      kind,
      ' Checked evidence ',
      commandId,
    );
    expect(command.reason).toBe('Checked evidence');
    expect(command.caseRevision).toBe(4);
    expect(command.diagnosisRevision).toBe(2);
    if (kind !== 'escalate')
      expect(command).toMatchObject({
        proposalId: resolutionReview.proposal!.id,
        proposalVersion: 1,
        decisionId: resolutionReview.proposal!.policy!.id,
      });
    else expect(command).not.toHaveProperty('proposalId');
    const receipt = {
      id: commandId,
      exceptionId,
      kind,
      actorId: 'operator',
      caseRevision: 4,
      approvalId: null,
      reason: command.reason,
      createdAt: '2026-09-20T00:00:00Z',
    };
    const fetch = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify(receipt), {
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetch);
    expect(await sendDecision(organizationId, exceptionId, command)).toEqual(
      receipt,
    );
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual(command);
    expect(fetch.mock.calls[0]![0]).toContain(
      `/organizations/${organizationId}/exceptions/${exceptionId}/decisions`,
    );
    expect(
      await recoverDecision(organizationId, exceptionId, commandId),
    ).toEqual(receipt);
    expect(fetch.mock.calls[1]![0]).toContain(`/decisions/${commandId}`);
  },
);

it('does not invent permission or accept an empty reason', () => {
  expect(() =>
    decisionCommand(
      { ...resolutionReview, permittedDecisions: [] },
      'approve',
      'Yes',
    ),
  ).toThrow();
  expect(() => decisionCommand(resolutionReview, 'reject', '  ')).toThrow();
});

it.each([401, 403, 404, 409])(
  'preserves command rejection status %s',
  async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: 'CONFLICT',
              message: 'Changed',
              requestId: 'test',
            }),
            { status, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );
    await expect(
      sendDecision(
        organizationId,
        exceptionId,
        decisionCommand(resolutionReview, 'approve', 'Checked'),
      ),
    ).rejects.toMatchObject({ status });
    expect(decisionError(new IdentityError(status))).not.toContain('uncertain');
  },
);

it('keeps approval scope stable across refreshed evidence but detects material changes', () => {
  const refreshed = structuredClone(resolutionReview);
  refreshed.caseRevision++;
  refreshed.diagnosisRevision++;
  refreshed.proposal!.id = '99999999-9999-4999-8999-999999999999';
  refreshed.proposal!.preconditions.evidenceRefs = ['new-read'];
  expect(sameResolution(resolutionReview, refreshed)).toBe(true);
  refreshed.proposal!.version++;
  expect(sameResolution(resolutionReview, refreshed)).toBe(false);
  refreshed.proposal!.version--;
  refreshed.proposal!.expectedPostcondition = { shippingMethodId: '9' };
  expect(sameResolution(resolutionReview, refreshed)).toBe(false);
  expect(
    sameResolution(resolutionReview, { ...refreshed, proposal: null }),
  ).toBe(false);
});

it('refreshes through an explicit command and surfaces changed conditions', async () => {
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        code: 'CONFLICT',
        message: 'The order was cancelled.',
        requestId: 'test',
      }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    ),
  );
  vi.stubGlobal('fetch', fetch);
  await expect(refreshResolution(organizationId, exceptionId)).rejects.toThrow(
    'The order was cancelled.',
  );
  expect(fetch.mock.calls[0]![1].method).toBe('POST');
});

it('treats a failed freshness read as retryable without implying an uncertain approval', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
  );
  await expect(
    refreshResolution(organizationId, exceptionId),
  ).rejects.toMatchObject({
    status: 503,
    message:
      'We couldn’t check the latest conditions. Nothing was approved. Try again shortly.',
  });
});
