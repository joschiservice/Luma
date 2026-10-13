import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import {
  builtInMembership,
  makeTenantContext,
  PermissionSet,
} from '@luma/identity';
import { expect, it } from 'vitest';

import {
  createSupplierTermsService,
  type SupplierTermsStore,
} from '../application/supplier-terms.js';
import type {
  SupplierProductTerms,
  SupplierTermsInput,
  SupplierTermsVersion,
} from '../domain/supplier-terms.js';
import { effectiveSupplierTerms } from '../domain/supplier-terms.js';
import { supplierTermsInputSchema } from './supplier-terms-validation.js';

const supplierId = randomUUID(),
  skuId = randomUUID(),
  tenantId = randomUUID();
const context = makeTenantContext(
  { userId: 'buyer', sessionId: randomUUID() },
  {
    id: tenantId,
    name: 'Shop',
    slug: 'shop',
    dataRegion: 'EU',
    status: 'active',
  },
  builtInMembership(
    { id: randomUUID(), organizationId: tenantId, userId: 'buyer' },
    'owner',
  ),
  randomUUID(),
);

function fixture() {
  const versions: SupplierTermsVersion[] = [];
  const commands = new Map<
    string,
    { digest: string; result: SupplierProductTerms }
  >();
  let audits = 0,
    released = true;
  let fresh = context;
  const list = (filter: {
    supplierId?: string | undefined;
    skuId?: string | undefined;
  }) => {
    const found = versions.filter(
      (v) =>
        (!filter.supplierId || v.supplierId === filter.supplierId) &&
        (!filter.skuId || v.skuId === filter.skuId),
    );

    return found.length
      ? [
          {
            supplierId,
            supplierName: 'Supplier',
            skuId,
            sku: 'SKU',
            revision: found.at(-1)!.revision,
            history: found,
            ...effectiveSupplierTerms(found, '2026-10-13'),
          },
        ]
      : [];
  };
  const store: SupplierTermsStore = {
    transaction: async (tenant, _write, fn) =>
      fn({
        list: async (filter) => (tenant === tenantId ? list(filter) : []),
        exists: async (s, k) =>
          tenant === tenantId && s === supplierId && k === skuId,
        insert: async (v) => {
          versions.push(v);
        },
        command: async (id) => commands.get(id) ?? null,
        saveCommand: async (id, digest, result) => {
          commands.set(id, { digest, result });
        },
        audit: async () => {
          audits++;
        },
      }),
  };
  const service = createSupplierTermsService({
    store,
    refreshContext: async () => fresh,
    released: async () => released,
    parse: (input) => supplierTermsInputSchema.parse(input),
    digest: JSON.stringify,
    id: randomUUID,
    now: () => new Date('2026-10-13T00:00:00Z'),
  });
  const input = (
    values: SupplierTermsInput['values'],
    expectedRevision = versions.length,
  ) => ({
    id: randomUUID(),
    supplierId,
    skuId,
    expectedRevision,
    values,
    reason: 'Reviewed supplier quotation',
  });
  const observed = (
    values: SupplierTermsInput['values'],
    observedAt = '2026-10-12T00:00:00Z',
    complete = true,
  ) =>
    service.observe(context, input(values), {
      source: 'provider',
      connectionId: randomUUID(),
      sourceRecordId: 'assignment-1',
      sourceUpdatedAt: null,
      observedAt,
      complete,
    });

  return {
    service,
    input,
    observed,
    versions,
    commands,
    audits: () => audits,
    fresh: (v: TenantContext) => {
      fresh = v;
    },
    release: (v: boolean) => {
      released = v;
    },
  };
}

it('preserves changed prices and human overrides independently of the next provider read', async () => {
  const f = fixture();
  await f.observed({
    unitPrice: { amount: '5.50', currency: 'EUR', validFrom: null },
    packSize: 12,
  });
  const request = f.input({
    unitPrice: { amount: '4.90', currency: 'EUR', validFrom: '2026-10-13' },
  });
  const override = await f.service.save(context, request);
  expect(override.observed?.values.unitPrice?.amount).toBe('5.50');
  expect(override.override?.actorId).toBe('buyer');
  expect(override.override?.reason).toBe(request.reason);
  await f.observed(
    { unitPrice: { amount: '5.75', currency: 'EUR', validFrom: null } },
    '2026-10-13T00:00:00Z',
  );
  const item = (await f.service.list(context)).items[0]!;
  expect(item.effective.unitPrice?.amount).toBe('4.90');
  expect(item.effective.packSize).toBe(12);
  expect(
    item.history.map((version) => version.values.unitPrice?.amount),
  ).toEqual(['5.50', '4.90', '5.75']);
  expect(item.effective.leadTimeDays).toBeNull();
});

it('keeps partial and stale reports from deleting missing terms', async () => {
  const f = fixture();
  await f.observed({ packSize: 8, leadTimeDays: 4 });
  await f.observed({ packSize: 10 }, '2026-10-13T00:00:00Z', false);
  await f.observed({ leadTimeDays: 99 }, '2026-10-11T00:00:00Z');
  const item = (await f.service.list(context)).items[0]!;
  expect(item.effective).toMatchObject({
    packSize: 10,
    leadTimeDays: 4,
    lineMinimumQuantity: null,
  });
  expect(item.observed?.complete).toBe(false);
  expect(item.history).toHaveLength(2);
});

it('serializes revisions and replays exact requests without another audit', async () => {
  const f = fixture(),
    request = f.input({ packSize: 6 });
  const first = await f.service.save(context, request);
  expect(await f.service.save(context, request)).toEqual(first);
  expect(f.audits()).toBe(1);
  await expect(
    f.service.save(context, { ...request, values: { packSize: 7 } }),
  ).rejects.toMatchObject({ statusCode: 409 });
  await expect(
    f.service.save(context, f.input({ leadTimeDays: 3 }, 0)),
  ).rejects.toMatchObject({ statusCode: 409 });
});

it('refreshes membership, enforces both permissions, tenant identity and the release flag', async () => {
  const f = fixture();
  f.fresh({ ...context, permissions: new PermissionSet(['procurement.read']) });
  await expect(
    f.service.save(context, f.input({ packSize: 6 })),
  ).rejects.toMatchObject({ statusCode: 403 });
  f.fresh({ ...context, permissions: new PermissionSet([]) });
  await expect(f.service.list(context)).rejects.toMatchObject({
    statusCode: 403,
  });
  f.fresh({ ...context, tenantId: randomUUID() });
  await expect(f.service.list(context)).rejects.toThrow();
  f.fresh(context);
  f.release(false);
  expect(await f.service.list(context)).toMatchObject({
    enabled: false,
    items: [],
    canManage: false,
  });
  await expect(
    f.service.save(context, f.input({ packSize: 6 })),
  ).rejects.toMatchObject({ statusCode: 403 });
  f.release(true);
  await expect(
    f.service.save(context, {
      ...f.input({ packSize: 6 }),
      skuId: randomUUID(),
    }),
  ).rejects.toMatchObject({ statusCode: 404 });
});

it('keeps a future quotation in history without applying its price before validity', async () => {
  const f = fixture();
  await f.observed({
    unitPrice: { amount: '5.00', currency: 'EUR', validFrom: null },
  });
  await f.service.save(
    context,
    f.input({
      unitPrice: { amount: '4.00', currency: 'EUR', validFrom: '2026-11-01' },
    }),
  );
  const item = (await f.service.list(context)).items[0]!;
  expect(item.effective.unitPrice?.amount).toBe('5.00');
  expect(item.override?.values.unitPrice?.amount).toBe('4.00');
});
