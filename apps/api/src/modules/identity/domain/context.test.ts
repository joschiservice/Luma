import { expect, it } from 'vitest';
import { makeTenantContext, requireRole, requireTenant } from './context.js';
it('freezes audit identity and rejects unauthorized tenant or role use', () => {
  const context = makeTenantContext(
    { userId: 'u', sessionId: 's' },
    {
      id: 't',
      name: 'Tenant',
      slug: 'tenant',
      dataRegion: 'EU',
      status: 'active',
    },
    { id: 'm', organizationId: 't', userId: 'u', role: 'member' },
    'request',
  );
  expect(Object.isFrozen(context)).toBe(true);
  expect(Object.isFrozen(context.actor)).toBe(true);
  expect(() => requireTenant(context, 'foreign')).toThrow('Resource not found');
  expect(() => requireRole(context, ['owner', 'admin'])).toThrow(
    'Insufficient',
  );
  expect(() => requireRole(context, ['member'])).not.toThrow();
});
