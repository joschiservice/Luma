import {
  nextCalendarDay,
  workspaceDateValue,
  workspaceInstant,
} from '@luma/ui/lib/timezone';
import { describe, expect, it } from 'vitest';

describe('workspace reporting timezone', () => {
  it('keeps the selected calendar day when UTC is the previous day', () => {
    expect(workspaceInstant('2026-09-25', 'Asia/Tokyo')).toBe(
      '2026-09-24T15:00:00.000Z',
    );
    expect(
      workspaceDateValue(new Date('2026-09-24T23:00:00Z'), 'Asia/Tokyo'),
    ).toBe('2026-09-25');
  });
  it('uses real local-day boundaries across daylight saving transitions', () => {
    const start = workspaceInstant('2026-03-29', 'Europe/Berlin');
    const end = workspaceInstant(
      nextCalendarDay('2026-03-29'),
      'Europe/Berlin',
    );
    expect(Date.parse(end) - Date.parse(start)).toBe(23 * 3600000);
    expect(() => workspaceInstant('2026-03-29T02:30', 'Europe/Berlin')).toThrow(
      'does not exist',
    );
  });
});

it('preserves sub-second observations', () => {
  expect(workspaceInstant('2026-09-25T12:30:00.123', 'UTC')).toBe(
    '2026-09-25T12:30:00.123Z',
  );
  expect(workspaceInstant('2026-09-25T12:30:00.123', 'Asia/Tokyo')).toBe(
    '2026-09-25T03:30:00.123Z',
  );
});
it('starts calendar days at the first valid instant when midnight is skipped', () => {
  expect(workspaceInstant('2026-09-06', 'America/Santiago')).toBe(
    '2026-09-06T04:00:00.000Z',
  );
  expect(() =>
    workspaceInstant('2026-09-06T00:30', 'America/Santiago'),
  ).toThrow();
});
