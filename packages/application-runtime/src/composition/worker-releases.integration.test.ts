import { randomBytes, randomUUID } from 'node:crypto';

import type { IdentityService } from '@luma/identity';
import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';
import {
  createObservability,
  createTenantDatabase,
} from '@luma/platform/composition';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { createMigratedDatabase } from '../test-support/database.js';
import { createApplicationServices } from './application.js';
import { createMailboxSyncWorker } from './mailbox-sync.js';
import { createSupplierFollowUpWorker } from './supplier-follow-up.js';

// Capture the real services assembled by each production constructor so their public owner
// behavior can be compared. No owner or release evaluator is replaced.
const applications = vi.hoisted(
  () => [] as ReturnType<typeof createApplicationServices>[],
);
vi.mock('./application.js', async (original) => {
  const actual = await original<typeof import('./application.js')>();

  return {
    ...actual,
    createApplicationServices: (
      options: Parameters<typeof actual.createApplicationServices>[0],
    ) => {
      const services = actual.createApplicationServices(options);
      applications.push(services);

      return services;
    },
  };
});

const databaseUrl = process.env.TEST_DATABASE_URL;
afterAll(async () => {
  for (const application of applications) await application.safety.close();
});

describe.skipIf(!databaseUrl)('production worker release parity', () => {
  it('uses the same current supplier email and incoming-stock releases as API composition', async () => {
    const db = await createMigratedDatabase(databaseUrl!);
    let enabled = true;
    const observability = createObservability(
      {
        environment: 'staging',
        release: 'test',
        sampleRate: 1,
        tenantHashKey: 'a'.repeat(32),
      },
      {
        posthog: {
          capture: vi.fn(),
          isFeatureEnabled: vi.fn(async () => enabled),
          shutdown: vi.fn(async () => {}),
        },
      },
    );
    const identity: IdentityService = {
      resolveWorkflowContext: vi.fn(),
      refreshContext: vi.fn(async (context) => context),
      authenticate: vi.fn(),
      listSecurityEvents: vi.fn(),
      supportInspections: vi.fn(),
      decideSupportInspection: vi.fn(),
      revokeSupportInspection: vi.fn(),
      setLanguage: vi.fn(),
      listOrganizations: vi.fn(),
      createOrganization: vi.fn(),
      listMembers: vi.fn(),
      suspendedMembers: vi.fn(),
      changeMember: vi.fn(),
      provisionMember: vi.fn(),
      hasSupportView: vi.fn(() => false),
      supportView: vi.fn(),
      redeemSupportView: vi.fn(),
      endSupportView: vi.fn(),
      sweepSupportViews: vi.fn(),
      resolveTenant: vi.fn(),
    };
    const tenantId = randomUUID(),
      userId = randomUUID();
    const context = makeTenantContext(
      { userId, sessionId: randomUUID() },
      {
        id: tenantId,
        name: 'Shop',
        slug: tenantId,
        dataRegion: 'AU',
        status: 'active',
      },
      builtInMembership(
        { id: randomUUID(), organizationId: tenantId, userId },
        'owner',
      ),
      randomUUID(),
    );
    await db.owner.query(
      "INSERT INTO organizations(id,name,slug,status,data_region,created_at) VALUES($1,'Shop',$2,'active','AU',now())",
      [tenantId, tenantId],
    );
    const common = {
      database: createTenantDatabase(db.owner),
      identity,
      observability,
      connections: {
        activeKeyId: 'test',
        keys: new Map([['test', randomBytes(32)]]),
      },
      env: {},
    };
    const api = createApplicationServices({
      ...common,
      execution: { kind: 'enabled', effects: { resolve: async () => null } },
    });
    const mailbox = createMailboxSyncWorker(common);
    const supplier = createSupplierFollowUpWorker({
      ...common,
      pool: db.owner,
    });
    try {
      expect(applications).toHaveLength(3);
      const supplierId = randomUUID(),
        orderId = randomUUID();
      await api.procurement.createSupplier(context, {
        id: supplierId,
        name: 'Supplier',
        externalReferences: [],
      });
      await api.procurement.createOrder(context, {
        id: orderId,
        supplierId,
        reference: 'PO-PARITY',
        lines: [
          {
            id: randomUUID(),
            sku: 'SKU',
            description: 'Item',
            quantity: 1,
            unit: 'each',
          },
        ],
        externalReferences: [],
        origin: {},
      });
      for (const release of [true, false]) {
        enabled = release;
        for (const application of applications) {
          const status = await application.http.supplierEmail.status(
            context,
            orderId,
          );
          expect(status).toMatchObject({
            submissionAvailable: release,
            followUpAvailable: release,
          });
          expect(
            await application.http.incoming.read(context, {
              skuIds: [randomUUID()],
            }),
          ).toMatchObject({ enabled: release });
        }
      }
    } finally {
      mailbox.shutdown();
      supplier.shutdown();
      await mailbox.close();
      await supplier.close();
      await observability.shutdown();
      await db.drop();
    }
  }, 60_000);
});
