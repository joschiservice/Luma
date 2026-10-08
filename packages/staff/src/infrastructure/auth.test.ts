import { describe, expect, it, vi } from 'vitest';

import { createAuditedStaffAuthHandler } from './auth.js';

function fixture() {
  const auth = {
    handler: vi.fn(
      async () =>
        new Response('{}', {
          headers: { 'set-cookie': 'staff.session=signed; HttpOnly' },
        }),
    ),
    api: {
      getSession: vi.fn(async () => ({
        user: { id: 'staff-user' },
        session: { id: 'staff-session' },
      })),
    },
  };
  const pool = {
    query: vi
      .fn<(sql: string, values: unknown[]) => Promise<{ rows: never[] }>>()
      .mockResolvedValue({ rows: [] }),
  };

  return { auth, pool, handler: createAuditedStaffAuthHandler(auth, pool) };
}

describe('staff authentication audit delivery', () => {
  it('records attribution without cookie or credential values', async () => {
    const { handler, pool } = fixture();
    const response = await handler(
      new Request('http://localhost/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'x-luma-staff-request-id': 'request-id' },
        body: JSON.stringify({ password: 'sensitive-password' }),
      }),
    );
    expect(response.status).toBe(200);
    expect(pool.query.mock.calls[0]?.[1]).toEqual([
      'staff-user',
      'staff-session',
      'staff.signed-in',
      'request-id',
      '{"method":"local"}',
    ]);
    expect(JSON.stringify(pool.query.mock.calls)).not.toContain(
      'sensitive-password',
    );
    expect(JSON.stringify(pool.query.mock.calls)).not.toContain(
      'staff.session=signed',
    );
  });
  it('withholds the cookie response when audit insertion fails', async () => {
    const { handler, pool } = fixture();
    pool.query.mockRejectedValueOnce(new Error('Audit unavailable'));
    await expect(
      handler(
        new Request('http://localhost/api/auth/sign-in/email', {
          method: 'POST',
        }),
      ),
    ).rejects.toThrow('Audit unavailable');
  });
});
