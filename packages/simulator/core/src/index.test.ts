import { describe, expect, it } from 'vitest';

import {
  advance,
  createClock,
  createTransport,
  matchFault,
  schedule,
} from './index.js';

describe('deterministic clock and fault lifecycle', () => {
  it('orders equal-time events and processes events scheduled by a transition', () => {
    const clock = createClock();
    const seen: unknown[] = [];
    schedule(clock, 10, 'a');
    schedule(clock, 10, 'b');
    advance(clock, 20, (command) => {
      seen.push(command);
      if (command === 'a') schedule(clock, 5, 'c');
    });
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(clock.events).toEqual([]);
  });
  it('matches instance, operation, resource, phase, occurrence, counts and expiry', () => {
    const clock = createClock();
    clock.faults.push({
      id: 'one',
      instance: 'jtl',
      operation: 'write',
      resource: '1',
      phase: 'after-commit',
      kind: 'response-loss',
      occurrence: 2,
      remaining: 1,
      matches: 0,
      status: 'armed',
    });
    const target = {
      instance: 'jtl',
      operation: 'write',
      resource: '1',
      phase: 'after-commit' as const,
    };
    expect(
      matchFault(clock, { ...target, instance: 'shopify' }),
    ).toBeUndefined();
    expect(matchFault(clock, target)).toBeUndefined();
    expect(matchFault(clock, target)?.status).toBe('triggered');
    expect(matchFault(clock, target)).toBeUndefined();
    clock.faults.push({
      ...clock.faults[0]!,
      id: 'expired',
      status: 'armed',
      expiresAt: clock.now + 1,
    });
    advance(clock, 1, () => {});
    expect(clock.faults[1]!.status).toBe('expired');
  });
  it('honors cancellation while a provider request is pending', async () => {
    const controller = new AbortController();
    const transport = createTransport(() => new Promise(() => {}));
    const request = transport('https://example.test', {
      signal: controller.signal,
    });
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });
});
