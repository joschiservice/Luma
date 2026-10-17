import { describe, expect, it } from 'vitest';

import { returnRecoveryStep } from './return-recovery.js';

const now = new Date('2026-10-12T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const write = (state: string, patch: Record<string, unknown> = {}) => ({
  state,
  decisionId: 'decision',
  expiresAt: '2026-10-13T12:00:00Z',
  updatedAt: now.toISOString(),
  ...patch,
});

describe('return recovery step', () => {
  it('sends an approved, unsent write only within its approval window', () => {
    expect(returnRecoveryStep(write('approved'), now)).toBe('send');
    expect(
      returnRecoveryStep(write('approved', { expiresAt: ago(1) }), now),
    ).toBe('expire');
  });

  it('applies a recorded approval and expires an unanswered request', () => {
    expect(returnRecoveryStep(write('approval_required'), now)).toBe(
      'decision',
    );
    expect(
      returnRecoveryStep(write('approval_required', { decisionId: null }), now),
    ).toBeNull();
    expect(
      returnRecoveryStep(
        write('approval_required', { expiresAt: ago(1) }),
        now,
      ),
    ).toBe('expire');
  });

  it('leaves a recent send to the request dispatching it', () => {
    expect(
      returnRecoveryStep(write('sending', { sent: true }), now),
    ).toBeNull();
    expect(
      returnRecoveryStep(
        write('sending', { sent: true, updatedAt: ago(2 * 60_000) }),
        now,
      ),
    ).toBe('reconcile');
  });

  it('reconciles a sent write after its expiry instead of expiring it', () => {
    expect(
      returnRecoveryStep(
        write('uncertain', {
          sent: true,
          expiresAt: ago(1),
          updatedAt: ago(60_000),
        }),
        now,
      ),
    ).toBe('reconcile');
    expect(
      returnRecoveryStep(
        write('approved', { sent: true, expiresAt: ago(1) }),
        now,
      ),
    ).toBe('reconcile');
  });

  it('reads uncertain writes once a minute and pending money every five minutes', () => {
    expect(
      returnRecoveryStep(write('uncertain', { updatedAt: ago(59_000) }), now),
    ).toBeNull();
    expect(
      returnRecoveryStep(write('pending', { updatedAt: ago(60_000) }), now),
    ).toBeNull();
    expect(
      returnRecoveryStep(write('pending', { updatedAt: ago(5 * 60_000) }), now),
    ).toBe('reconcile');
  });

  it('does nothing for ended writes', () => {
    for (const state of [
      'verified',
      'created',
      'failed',
      'rejected',
      'expired',
      'not_executed',
    ])
      expect(returnRecoveryStep(write(state), now)).toBeNull();
  });
});
