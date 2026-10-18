import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { MailRateLimited } from '../application/mail.js';
import { drainWorkspaceClosureMail } from './workspace-closure.js';

const notice = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'closure_reminder',
  state: 'queued',
  attempts: 1,
  email: 'owner@example.test',
  locale: 'de',
  workspace: 'Northwind Goods',
  deletion_at: new Date('2027-01-16T00:00:00Z'),
  valid: true,
};

/** A pool that reserves the given notices in order and records every outcome. */
function pool(notices: object[]) {
  const queue = [...notices];
  const outcomes: unknown[][] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('reserve_workspace_closure_mail'))
      return { rows: queue.length ? [queue.shift()] : [] };
    if (sql.includes('record_workspace_closure_mail')) outcomes.push(values!);

    return { rows: [] };
  });

  return { pool: { query } as unknown as Pool, outcomes };
}

describe('workspace closure notices', () => {
  it('sends valid notices in the owner’s language and cancels stale ones unsent', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { pool: db, outcomes } = pool([
      notice,
      { ...notice, id: '22222222-2222-4222-8222-222222222222', valid: false },
    ]);
    expect(await drainWorkspaceClosureMail(db, { send })).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({
      id: notice.id,
      to: 'owner@example.test',
      category: 'workspace_closure_reminder',
      subject: 'Northwind Goods wird in einer Woche gelöscht',
    });
    expect(outcomes).toEqual([
      [notice.id, 1, 'sent', 0],
      ['22222222-2222-4222-8222-222222222222', 1, 'cancelled', 0],
    ]);
  });

  it('returns a rate-limited attempt and stops the pass', async () => {
    const send = vi.fn().mockRejectedValue(new MailRateLimited(30));
    const { pool: db, outcomes } = pool([notice, notice]);
    expect(await drainWorkspaceClosureMail(db, { send })).toBe(false);
    expect(outcomes).toEqual([[notice.id, 1, 'deferred', 30]]);
  });
});
