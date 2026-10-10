import { describe, expect, it } from 'vitest';

import { describeUserAgent, sessionActivityDue } from './sessions.js';

describe('session activity', () => {
  const now = new Date('2026-10-09T12:00:00Z');

  it('records missing or stale activity and skips recent activity', () => {
    expect(sessionActivityDue(null, now)).toBe(true);
    expect(sessionActivityDue(new Date('2026-10-09T11:55:00Z'), now)).toBe(
      true,
    );
    expect(sessionActivityDue(new Date('2026-10-09T11:56:00Z'), now)).toBe(
      false,
    );
    expect(sessionActivityDue(new Date('2026-10-09T12:10:00Z'), now)).toBe(
      false,
    );
  });
});

describe('describeUserAgent', () => {
  it.each([
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      { browser: 'Chrome 141', os: 'macOS' },
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
      { browser: 'Edge 140', os: 'Windows' },
    ],
    [
      'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0',
      { browser: 'Firefox 143', os: 'Linux' },
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
      { browser: 'Safari 18', os: 'iOS' },
    ],
    [
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
      { browser: 'Chrome 141', os: 'Android' },
    ],
    ['curl/8.7.1', { browser: null, os: null }],
    [null, { browser: null, os: null }],
  ])('describes %s', (header, expected) => {
    expect(describeUserAgent(header)).toEqual(expected);
  });
});
