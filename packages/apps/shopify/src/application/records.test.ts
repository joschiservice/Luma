import type {
  InstallationService,
  InstalledConnection,
} from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import { describe, expect, it, vi } from 'vitest';

import { createRecordService } from './records.js';

const connectionId = '11111111-1111-4111-8111-111111111111';
const context = {
  tenantId: '22222222-2222-4222-8222-222222222222',
} as TenantContext;
const input = { connectionId, kind: 'Order', id: 'gid://shopify/Order/1' };

function fixture() {
  const connection: InstalledConnection = {
    id: connectionId,
    tenantId: context.tenantId,
    appId: 'shopify',
    provider: 'shopify',
    appInstallationVersion: 2,
    target: { kind: 'shopify', shop: 'example.myshopify.com' },
    label: 'Shop',
    status: 'active',
    permissions: ['orders.read'],
    granted: ['orders.read'],
    version: 1,
    credentialVersion: 1,
    createdAt: '2026-09-28T00:00:00Z',
    updatedAt: '2026-09-28T00:00:00Z',
  };
  const credential = vi
    .fn<InstallationService['credential']>()
    .mockResolvedValue({ connection, credentials: { token: 'secret' } });
  const requireInstalled = vi.fn(async () => 2);
  const read = vi.fn(async () => ({}) as never);
  const reader = vi.fn<Parameters<typeof createRecordService>[0]['reader']>(
    () => read,
  );
  const service = createRecordService({
    installations: { credential },
    requireInstalled,
    reader,
    protectedCustomerDataApproved: false,
  });

  return { connection, credential, requireInstalled, read, reader, service };
}

describe('Shopify record authorization', () => {
  it('uses the tenant-scoped capability port and rechecks credentials on every request', async () => {
    const f = fixture();
    await f.service(context, input);
    expect(f.credential).toHaveBeenCalledWith(
      context,
      connectionId,
      'orders.read',
    );
    const options = f.reader.mock.calls[0]![0];
    expect(await options.accessToken()).toBe('secret');
    expect(f.requireInstalled).toHaveBeenCalledTimes(2);
    expect(f.credential).toHaveBeenCalledTimes(2);
    f.requireInstalled.mockRejectedValueOnce(new Error('Uninstalled'));
    await expect(options.accessToken()).rejects.toThrow('Uninstalled');
    expect(f.credential).toHaveBeenCalledTimes(2);
  });
  it.each(['appId', 'provider', 'appInstallationVersion'] as const)(
    'rejects stale or mismatched %s before creating a reader',
    async (key) => {
      const f = fixture();
      Object.assign(f.connection, {
        [key]: key === 'appInstallationVersion' ? 1 : 'other',
      });
      await expect(f.service(context, input)).rejects.toThrow(
        'Shopify connection not found',
      );
      expect(f.reader).not.toHaveBeenCalled();
    },
  );
  it('rejects invalid identities before credential access', async () => {
    const f = fixture();
    await expect(
      f.service(context, { ...input, id: 'gid://shopify/Customer/1' }),
    ).rejects.toThrow('valid Shopify record');
    await expect(
      f.service(context, { ...input, tenantId: 'other' }),
    ).rejects.toThrow('valid Shopify record');
    expect(f.credential).not.toHaveBeenCalled();
  });
  it('passes denied or cross-tenant credential failures through without dispatching', async () => {
    const f = fixture();
    f.credential.mockRejectedValue(new Error('Connection unavailable'));
    await expect(f.service(context, input)).rejects.toThrow(
      'Connection unavailable',
    );
    expect(f.reader).not.toHaveBeenCalled();
  });
});
