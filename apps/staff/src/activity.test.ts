import { describe, expect, it } from 'vitest';

import { createStaffActivityTracker } from './activity';

describe('staff browser activity', () => {
  it('does not report passive polls or synthetic events as user activity', () => {
    const tracker = createStaffActivityTracker();
    expect(tracker.consume()).toBe(false);
    tracker.record({ isTrusted: false });
    expect(tracker.consume()).toBe(false);
  });

  it('consumes real input once and retains new input until the reporting throttle allows it', () => {
    let time = 1_000;
    const tracker = createStaffActivityTracker(() => time);
    tracker.record({ isTrusted: true });
    expect(tracker.consume()).toBe(true);
    expect(tracker.consume()).toBe(false);
    time += 1_000;
    tracker.record({ isTrusted: true });
    expect(tracker.consume()).toBe(false);
    time += 29_000;
    expect(tracker.consume()).toBe(true);
    expect(tracker.consume()).toBe(false);
  });

  it('discards old input rather than extending idle access when a tab wakes later', () => {
    let time = 1_000;
    const tracker = createStaffActivityTracker(() => time);
    tracker.record({ isTrusted: true });
    time += 60_001;
    expect(tracker.consume()).toBe(false);
  });

  it('forgets pending activity and the throttle when the staff identity changes', () => {
    const tracker = createStaffActivityTracker();
    tracker.record({ isTrusted: true });
    tracker.reset();
    expect(tracker.consume()).toBe(false);
    tracker.record({ isTrusted: true });
    expect(tracker.consume()).toBe(true);
  });
});
