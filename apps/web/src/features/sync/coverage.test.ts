import { describe, expect, it } from 'vitest';

import { type CoverageItem, coverageItems, coverageSummary } from './coverage';
import { attention, current, importing } from './sync-fixtures';

const now = Date.parse('2026-10-06T05:00:00.000Z');

function item(patch: Partial<CoverageItem> = {}): CoverageItem {
  return {
    id: crypto.randomUUID(),
    label: 'Tokyo store',
    state: 'verified',
    text: 'all orders',
    problem: null,
    importing: false,
    olderOnly: false,
    progress: null,
    historyFrom: null,
    lastSuccessAt: '2026-10-06T04:59:30.000Z',
    ...patch,
  };
}

describe('coverageSummary', () => {
  it('calls a list incomplete while any source is still importing', () => {
    expect(
      coverageSummary(
        [
          item({ state: 'running', importing: true, progress: 8.4 }),
          item({ state: 'running', importing: true, progress: 0 }),
          item(),
        ],
        now,
      ),
    ).toEqual({
      state: 'running',
      text: 'Importing from 2 of 3 sources (0–8%) · list is incomplete · synced 30 seconds ago',
    });
  });

  it('separates sources whose recent history is already imported', () => {
    expect(
      coverageSummary(
        [
          item({ state: 'running', importing: true, olderOnly: true }),
          item({ state: 'running', importing: true, progress: 40 }),
        ],
        now,
      ).text,
    ).toBe(
      'Importing from 1 of 2 sources (40%) · older history importing from 1 of 2 sources · list is incomplete · synced 30 seconds ago',
    );
  });

  it('leads with a source that needs attention and keeps the worst state', () => {
    expect(
      coverageSummary(
        [
          item({ label: 'JTL-Wawi', state: 'error', problem: 'Failing' }),
          item({ state: 'running', importing: true, progress: null }),
        ],
        now,
      ),
    ).toEqual({
      state: 'error',
      text: 'JTL-Wawi: Failing · importing from 1 of 2 sources · list is incomplete · synced 30 seconds ago',
    });
  });

  it('names history limits once every import has finished', () => {
    expect(
      coverageSummary(
        [
          item({ historyFrom: '2026-07-31T00:00:00.000Z' }),
          item({
            historyFrom: '2026-07-31T00:00:00.000Z',
            lastSuccessAt: '2026-10-06T04:00:00.000Z',
          }),
        ],
        now,
      ),
    ).toEqual({
      state: 'verified',
      text: 'All 2 sources imported · history since 31 Jul 2026 · synced 1 hour ago',
    });
    expect(
      coverageSummary(
        [item({ historyFrom: '2026-07-31T00:00:00.000Z' }), item()],
        now,
      ).text,
    ).toBe(
      'All 2 sources imported · history limited on 1 source · synced 30 seconds ago',
    );
  });
});

describe('coverageItems', () => {
  it('describes each connection that syncs the record type', () => {
    for (const overview of [importing, current, attention]) {
      const items = coverageItems(overview, 'orders');
      expect(items.length).toBeGreaterThan(0);
      for (const entry of items) expect(entry.text).toMatch(/orders/);
    }
    expect(
      coverageItems(importing, 'orders').some((entry) => entry.importing),
    ).toBe(true);
  });
});
