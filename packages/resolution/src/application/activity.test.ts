import type { TenantContext } from '@luma/identity';
import { describe, expect, it, vi } from 'vitest';

import type {
  ActivityEvent,
  ActivityPage,
  ActivityQuery,
} from '../domain/activity.js';
import {
  type ActivityExportRecord,
  createActivityService,
  resolveActivityActors,
} from './activity.js';
import { testContext } from './tenant-context.fixture.js';

const reader = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const window = {
  from: '2026-10-01T00:00:00Z',
  to: '2026-10-02T00:00:00Z',
};

describe('activity actor filter', () => {
  it('resolves me to the reader and drops repeated values', () => {
    expect(resolveActivityActors(['me', reader, 'luma'], reader)).toEqual([
      reader,
      'luma',
    ]);
    expect(resolveActivityActors(undefined, reader)).toBeUndefined();
  });

  it('reads with me resolved for the refreshed reader', async () => {
    const list = vi.fn<
      (context: TenantContext, query: ActivityQuery) => Promise<ActivityPage>
    >(
      async () =>
        ({
          visibility: 'member',
          items: [],
          nextCursor: null,
          coverage: '',
        }) satisfies ActivityPage,
    );
    const context = testContext({ role: 'member', userId: reader });
    const read = createActivityService(
      { list, counts: vi.fn() },
      async (value) => value,
    );
    await read.list(context, { ...window, limit: 30, actor: ['me', other] });
    expect(list.mock.calls[0]?.[1].actor).toEqual([reader, other]);
  });

  it('never reaches the store without activity access', async () => {
    const list = vi.fn();
    const context = testContext({ permissions: [], userId: reader });
    const read = createActivityService(
      { list, counts: vi.fn() },
      async (value) => value,
    );
    await expect(
      read.list(context, { ...window, limit: 30, actor: ['me'] }),
    ).rejects.toThrow();
    expect(list).not.toHaveBeenCalled();
  });
});

const event = (
  id: string,
  patch: Partial<ActivityEvent> = {},
): ActivityEvent => ({
  id,
  recordedAt: '2026-10-01T10:00:00Z',
  occurredAt: null,
  actor: {
    kind: 'member',
    id: reader,
    name: 'Ada Lovelace',
    email: 'ada@example.test',
    workflow: null,
  },
  action: 'case.approve',
  type: 'decision',
  outcome: 'approved',
  exceptionId: null,
  proposalId: null,
  attemptId: null,
  connectionId: null,
  system: null,
  resource: null,
  playbookId: null,
  mode: 'unrecorded',
  summary: null,
  executionState: null,
  verificationPhase: null,
  failureCode: null,
  connections: [],
  dispatch: null,
  verification: null,
  evidenceRefs: [],
  ...patch,
});

describe('activity export', () => {
  const labels = {
    headings: { outcome: 'Outcome', actor: 'Recorded by' },
    values: { 'outcome:approved': 'Approved' },
    truncated: 'More events match.',
  };
  const setup = (page: Partial<ActivityPage> = {}) => {
    const list = vi.fn<
      (context: TenantContext, query: ActivityQuery) => Promise<ActivityPage>
    >(
      async () =>
        ({
          visibility: 'member',
          items: [event('e1'), event('e2', { summary: '=HYPERLINK("x")' })],
          nextCursor: null,
          coverage: '',
          ...page,
        }) satisfies ActivityPage,
    );
    const records: ActivityExportRecord[] = [];
    const service = createActivityService(
      { list, counts: vi.fn() },
      async (value) => value,
      {
        record: async (_context, entry) => void records.push(entry),
        id: () => 'export-1',
        now: () => new Date('2026-10-02T08:00:00Z'),
      },
    );

    return { list, records, service };
  };

  it('writes every event with readable names, guards formulas and records the export', async () => {
    const { list, records, service } = setup();
    const result = await service.export(
      testContext({ userId: reader }),
      { ...window, outcome: ['approved'], actor: ['me'] },
      labels,
    );
    // Every immutable event, not the business groups, up to the export limit.
    expect(list.mock.calls[0]?.[1]).toMatchObject({
      view: 'events',
      limit: 5000,
      actor: [reader],
    });
    const lines = result.csv.trimEnd().split('\r\n');
    expect(lines[0]).toContain('Outcome');
    expect(lines[0]).toContain('Recorded by');
    expect(lines[1]).toContain('Approved');
    expect(lines[1]).toContain('Ada Lovelace');
    expect(lines[2]).toContain(`"'=HYPERLINK(""x"")"`);
    expect(result).toMatchObject({
      filename: 'activity-2026-10-02.csv',
      rows: 2,
      truncated: false,
    });
    expect(records).toEqual([
      expect.objectContaining({ rows: 2, truncated: false, filters: 2 }),
    ]);
  });

  it('says when more events match than one export holds', async () => {
    const { service } = setup({ nextCursor: 'more' });
    const result = await service.export(testContext(), window, labels);
    expect(result.truncated).toBe(true);
    expect(result.csv.trimEnd().split('\r\n').at(-1)).toBe(
      'More events match.',
    );
  });

  it('needs list export permission besides activity access', async () => {
    const { list, records, service } = setup();
    await expect(
      service.export(
        testContext({ permissions: ['activity.read'] }),
        window,
        labels,
      ),
    ).rejects.toThrow();
    expect(list).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  });
});
