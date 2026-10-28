import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { MailOutcomeUncertain, MailRateLimited } from '../application/mail.js';
import { dispatchMail } from './mail-dispatch.js';

const message = {
  id: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
  to: 'mara@example.test',
  locale: 'en' as const,
  email: {
    kind: 'workspace_closure_reminder' as const,
    workspace: 'Northwind Goods',
    deletionAt: new Date('2027-01-16T00:00:00Z'),
  },
};

function pool() {
  const query = vi.fn().mockResolvedValue({ rows: [] });

  return { query, pool: { query } as unknown as Pool };
}

describe('dispatchMail', () => {
  it('records the provider receipt of an accepted message', async () => {
    const db = pool();
    const send = vi.fn().mockResolvedValue({ providerId: 'ses-1' });

    await expect(
      dispatchMail(db.pool, { send }, { ...message, attempt: 1 }),
    ).resolves.toEqual({ status: 'sent' });
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO mail_receipts'),
      ['ses-1', message.id],
    );
  });

  it('retries an uncertain first attempt once and then stops sending', async () => {
    const send = vi.fn().mockRejectedValue(new MailOutcomeUncertain());

    await expect(
      dispatchMail(pool().pool, { send }, { ...message, attempt: 1 }),
    ).resolves.toEqual({ status: 'failed' });
    await expect(
      dispatchMail(pool().pool, { send }, { ...message, attempt: 2 }),
    ).resolves.toEqual({ status: 'sent' });
  });

  it('keeps retrying refusals and defers rate limits', async () => {
    await expect(
      dispatchMail(
        pool().pool,
        { send: vi.fn().mockRejectedValue(new Error('refused')) },
        { ...message, attempt: 3 },
      ),
    ).resolves.toEqual({ status: 'failed' });
    await expect(
      dispatchMail(
        pool().pool,
        { send: vi.fn().mockRejectedValue(new MailRateLimited(30)) },
        { ...message, attempt: 2 },
      ),
    ).resolves.toEqual({ status: 'deferred', seconds: 30 });
  });
});
