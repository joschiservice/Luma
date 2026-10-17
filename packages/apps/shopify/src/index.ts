import '@luma/identity/http';

import { randomUUID } from 'node:crypto';

import type { AppDefinition, AppFactoryContext } from '@luma/app-host';
import type { ConnectionProvider } from '@luma/connections';
import {
  boundedReadTransport,
  simulationTransport,
} from '@luma/connections/adapters';
import {
  createInstallationRepository,
  createInstallationService,
} from '@luma/connections/composition';
import {
  type BudgetStore,
  createReadBudget,
  type ReadBudget,
} from '@luma/connector-shopify';
import { IdentityError } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import { registerRecoveryRoutes } from './api/fulfillment-recovery.js';
import { registerInventoryCorrectionRoutes } from './api/inventory-correction.js';
import { registerOrderEditRoutes } from './api/order-edits.js';
import { registerRecordRoutes } from './api/records.js';
import { registerPublishingRoutes } from './api/shipment-publishing.js';
import { registerShopifyRoutes } from './api/shopify.js';
import {
  correctionDecision,
  orderEditDecision,
  publishingDecision,
  recoveryDecision,
} from './application/decisions.js';
import type { ShopifyOAuth } from './application/oauth.js';
import { createRecordService } from './application/records.js';
import { readShopifyConfig } from './config.js';
import {
  installationCredentials,
  installationInput,
  installationTarget,
} from './domain/installation-validation.js';
import { recordPermission } from './domain/records.js';
import { createShopifyRecovery } from './fulfillment-recovery.js';
import { createShopifyConnector } from './infrastructure/adapter.js';
import { readInventoryWriteReceipts } from './infrastructure/inventory-write-store.js';
import { createShopifyOAuth } from './infrastructure/oauth.js';
import { createPrivacyIntake } from './infrastructure/privacy.js';
import { createShopifyRecordReader } from './infrastructure/records.js';
import { shopifyRequestBudget } from './infrastructure/request-budget.js';
import { createInstallationVerifier } from './infrastructure/verifier.js';
import { createShopifyInventoryCorrection } from './inventory-correction.js';
import { createShopifyOrderEdits } from './order-edits.js';
import { createShopifyPublishing } from './shipment-publishing.js';
import { createShopifyWorkflows } from './workflows.js';

export {
  createShopifyConnector,
  createShopifyOAuth,
  createPrivacyIntake,
  createInstallationVerifier,
};

export type { ShopifyOAuth };

export type { ShopifyConfig } from './config.js';

export { mapShopifyWebhook } from './infrastructure/webhooks.js';

/** Creates Shopify capability, validation, and credential-refresh contributions. */
export function createShopifyProvider(
  options: Parameters<typeof createInstallationVerifier>[0] & {
    oauth?: ShopifyOAuth;
    /** Offers customer reads; set only when Shopify approved protected customer data. */
    customerAccess?: { contact: boolean; address: boolean };
    /** Connects tenant-scoped correction receipts to independent commerce reads. */
    database?: TenantDatabase;
    requestBudgetStore?: BudgetStore | undefined;
    env?: Readonly<Record<string, string | undefined>>;
  } = {},
): ConnectionProvider {
  const budgets = new Map<string, ReadBudget>();

  return {
    appId: 'shopify',
    provider: 'shopify',
    targets: ['shopify'],
    recordAccessFailures: true,
    management: options.oauth ? [] : ['check', 'rotate'],
    validate: (value) => installationInput.parse(value),
    credentials: (_target, value) => installationCredentials.parse(value),
    verify: createInstallationVerifier(options),
    ...(options.oauth ? { refreshCredential: options.oauth.credential } : {}),
    manage() {
      if (options.oauth)
        throw new IdentityError(
          422,
          'CONFLICT',
          'Use Connect Shopify to authorize this store',
        );
    },
    async build(context, id, capability, runtime) {
      const current = await runtime.installations.credential(
        context,
        id,
        capability,
      );
      const target = installationTarget.parse(current.connection.target);
      let fetch =
        simulationTransport(
          current.connection,
          runtime.simulation ?? options.simulation,
        ) ?? runtime.fetch;

      if (runtime.readBounds) {
        if (!capability.endsWith('.read'))
          throw new IdentityError(
            422,
            'VALIDATION_ERROR',
            'Read bounds cannot authorize writes',
          );
        fetch = boundedReadTransport(
          fetch ?? globalThis.fetch,
          runtime.readBounds,
        );
      }
      let budget: ReadBudget;
      if (options.requestBudgetStore) {
        budget = shopifyRequestBudget(
          options,
          current.connection,
          runtime.readPurpose,
          context.dataRegion,
        );
      } else {
        const budgetKey = `${context.tenantId}:${id}`;
        const previous = budgets.get(budgetKey);
        budget = previous ?? createReadBudget();
        if (!previous) budgets.set(budgetKey, budget);
      }
      const database = options.database;

      return createShopifyConnector({
        budget,
        ...(runtime.readPurpose ? { purpose: runtime.readPurpose } : {}),
        ...(runtime.readBounds ? { signal: runtime.readBounds.signal } : {}),
        tenantId: context.tenantId,
        connectionId: id,
        shop: target.shop,
        accessToken: async () => {
          if (
            capability.startsWith('returns.exchange.') &&
            !capability.endsWith('.read')
          )
            for (const read of [
              'orders.read',
              'returns.exchange.quote.read',
              'returns.exchange.proof.read',
              'returns.exchange.options.read',
            ] as const)
              await runtime.installations.credential(context, id, read);
          if (capability === 'returns.refund')
            for (const read of [
              'orders.read',
              'returns.settlement.quote.read',
              'returns.settlement.proof.read',
            ] as const)
              await runtime.installations.credential(context, id, read);

          return (
            await runtime.installations.credential(context, id, capability)
          ).credentials.token;
        },
        recordObservations: runtime.recordObservations,
        inventoryShipmentAccess:
          current.connection.permissions.includes('inventory.shipments.read') &&
          current.connection.granted.includes('inventory.shipments.read'),
        ...(database
          ? {
              inventoryWrites: (targets) =>
                readInventoryWriteReceipts(database, context, id, targets),
            }
          : {}),
        ...(options.customerAccess
          ? {
              customerAccess: options.customerAccess,
              orderCustomers:
                current.connection.granted.includes('customers.read'),
            }
          : {}),
        ...(fetch ? { fetch } : {}),
      });
    },
  };
}

/** Registers Shopify commerce capabilities and installation-gated OAuth routes. */
export function createApp(context: AppFactoryContext): AppDefinition {
  const config = readShopifyConfig(context.env);
  const oauth = config
    ? createShopifyOAuth(context.database, config, {
        requestBudgetStore: context.requestBudgetStore,
        env: context.env,
        cipher: context.cipher,
        refreshContext: context.refreshContext,
        verify: createInstallationVerifier({
          simulation: context.simulation,
          requestBudgetStore: context.requestBudgetStore,
          env: context.env,
        }),
        requireInstalled: (ctx) => context.requireInstalled(ctx, 'shopify'),
        authorize: (ctx) =>
          context.requirePermission(ctx, {
            app: 'shopify',
            permission: 'connections.manage',
          }),
      })
    : undefined;

  const installations = createInstallationService({
    repository: createInstallationRepository(context.database),
    cipher: context.cipher,
    refreshContext: context.refreshContext,
    verify: createInstallationVerifier({
      simulation: context.simulation,
      requestBudgetStore: context.requestBudgetStore,
      env: context.env,
    }),
    ...(oauth ? { refreshCredential: oauth.credential } : {}),
    id: randomUUID,
    now: () => new Date(),
  });
  const records = createRecordService({
    installations,
    reader: ({ connection, ...reader }) => {
      // Simulated connections must reach the simulator, never a live shop.
      const fetch = simulationTransport(connection, context.simulation);

      return createShopifyRecordReader({
        ...reader,
        budget: shopifyRequestBudget(context, connection),
        ...(fetch ? { fetch } : {}),
      });
    },
    requireInstalled: (ctx) => context.requireInstalled(ctx, 'shopify'),
    authorize: async (ctx, kind) =>
      context.requirePermission(await context.refreshContext(ctx), {
        app: 'shopify',
        scopes: [recordPermission(kind)],
      }),
    protectedCustomerDataApproved:
      context.env.SHOPIFY_PROTECTED_CUSTOMER_DATA_APPROVED === 'true',
    protectedCustomerContactApproved:
      context.env.SHOPIFY_CUSTOMER_CONTACT_APPROVED === 'true',
  });

  const publishing = createShopifyPublishing(context, installations);
  const recovery = createShopifyRecovery(context, installations);
  const corrections = createShopifyInventoryCorrection(context, installations);
  const edits = createShopifyOrderEdits(context, installations);
  const workflows = createShopifyWorkflows(context, {
    installations,
    recovery,
    corrections,
    edits,
  });

  return {
    manifest: {
      id: 'shopify',
      name: 'Shopify',
      description:
        'Connect Shopify stores to read orders, products, inventory, and fulfillment.',
      version: '1.0.0',
      category: 'storefront',
      ui: [
        'connections',
        'settings',
        'page',
        'record',
        'inventory',
        'fulfillment',
      ],
      connectionTypes: [{ kind: 'shopify', name: 'Shopify' }],
      permissions: [
        {
          key: 'shopify:shipment_publishing.run',
          label: 'Publish Shopify shipments',
          description:
            'Preview, approve and publish dispatched shipments and tracking to Shopify.',
          consequential: true,
        },
        {
          key: 'shopify:returns.manage',
          label: 'Manage Shopify returns',
          description:
            'Request approval for Shopify returns, refunds and exchanges.',
          consequential: true,
        },
        {
          key: 'shopify:fulfillment_recovery.run',
          label: 'Recover Shopify fulfillments',
          description:
            'Preview, request approval for, and run recovery of stuck Shopify fulfillments.',
          consequential: true,
        },
        {
          key: 'shopify:inventory_corrections.apply',
          label: 'Correct Shopify inventory',
          description:
            'Preview, request approval for, and apply stock corrections at Shopify locations.',
          consequential: true,
        },
        {
          key: 'shopify:order_edits.apply',
          label: 'Change Shopify order quantities',
          description:
            'Preview, request approval for, and send quantity changes to unfulfilled Shopify order lines.',
          consequential: true,
        },
      ],
      scopes: [
        'orders.read',
        'fulfillment.read',
        'inventory.read',
        'products.read',
        'customers.read',
        'returns.read',
        'actions.propose',
        'actions.execute',
      ],
      slotAccess: {
        connections: 'connections.manage',
        settings: 'connections.manage',
        page: 'orders.read',
        record: 'orders.read',
        inventory: 'shopify:inventory_corrections.apply',
        fulfillment: 'fulfillment.read',
      },
      decisionAccess: {
        shipment_publication: {
          view: 'shopify:shipment_publishing.run',
          respond: 'shopify:shipment_publishing.run',
        },
        fulfillment_recovery: {
          view: 'shopify:fulfillment_recovery.run',
          respond: 'shopify:fulfillment_recovery.run',
        },
        inventory_correction: {
          view: 'shopify:inventory_corrections.apply',
          respond: 'shopify:inventory_corrections.apply',
        },
        order_edit: {
          view: 'shopify:order_edits.apply',
          respond: 'shopify:order_edits.apply',
        },
      },
      actionAccess: { 'orders.quantity.edit': 'shopify:order_edits.apply' },
    },
    connector: createShopifyProvider({
      database: context.database,
      requestBudgetStore: context.requestBudgetStore,
      env: context.env,
      ...(oauth ? { oauth } : {}),
      ...(context.simulation ? { simulation: context.simulation } : {}),
      ...(context.env.SHOPIFY_PROTECTED_CUSTOMER_DATA_APPROVED === 'true'
        ? {
            customerAccess: {
              contact: context.env.SHOPIFY_CUSTOMER_CONTACT_APPROVED === 'true',
              address: context.env.SHOPIFY_CUSTOMER_ADDRESS_APPROVED === 'true',
            },
          }
        : {}),
    }),
    async decisions(tenant) {
      const [recoveries, stock, quantities, shipments] = await Promise.all([
        recovery.pending(tenant),
        corrections.pending(tenant),
        edits.pending(tenant),
        publishing.pending(tenant),
      ]);

      const items = [
        ...shipments.map((view) => publishingDecision(view, tenant.actor.id)),
        ...recoveries.map((view) => recoveryDecision(view, tenant.actor.id)),
        ...stock.map((view) => correctionDecision(view, tenant.actor.id)),
        ...quantities.map((view) => orderEditDecision(view, tenant.actor.id)),
      ];

      // Owners list newest first, so the current proposal for a target wins its item.
      return items.filter(
        (item, index) =>
          items.findIndex((other) => other.id === item.id) === index,
      );
    },
    workflows,
    stockProtection: corrections.protection,
    async uninstalled({ tenantId, transaction }) {
      await transaction.query(
        `UPDATE shopify_stock_protection_incidents SET document=jsonb_set(jsonb_set(jsonb_set(document,'{view,state}','"unknown"'::jsonb),'{view,stopNew}','true'::jsonb),'{view,positions}',(SELECT COALESCE(jsonb_agg(CASE WHEN p->>'status' IN ('pending','held','tightened','unknown','releasing') THEN p || '{"status":"unknown","reason":"read_or_admission_unavailable"}'::jsonb ELSE p END),'[]'::jsonb) FROM jsonb_array_elements(document->'view'->'positions') p)) WHERE tenant_id=$1 AND document->'view'->>'state'<>'released'`,
        [tenantId],
      );
      if (config)
        await transaction.query(
          'DELETE FROM shopify_oauth_states WHERE tenant_id=$1',
          [tenantId],
        );
    },
    async ready() {
      if (
        context.requestBudgetStore &&
        !(await context.requestBudgetStore.ready())
      )
        return false;
      if (!config) return true;

      return context.database.transaction(
        '00000000-0000-4000-8000-000000000000',
        async (tx) => {
          const privacy = await tx.query<{ present: boolean }>(
            "SELECT to_regclass('public.shopify_privacy_requests') IS NOT NULL AS present",
          );
          if (!privacy.rows[0]?.present) return false;
          await tx.query('SELECT digest FROM shopify_oauth_states LIMIT 0');
          await tx.query(
            'SELECT connection_id FROM shopify_installation_bindings LIMIT 0',
          );

          return true;
        },
      );
    },
    registerHttp(server, identity) {
      registerShopifyRoutes(
        server,
        oauth,
        identity,
        config
          ? createPrivacyIntake(context.database, config, context.cipher)
          : undefined,
      );
      registerRecordRoutes(server, records);
      registerInventoryCorrectionRoutes(server, corrections);
      registerRecoveryRoutes(server, recovery);
      registerPublishingRoutes(server, publishing);
      server.post(
        '/v1/organizations/:organizationId/apps/shopify/shipment-publishing-sources',
        {
          config: {
            access: { permission: 'shopify:shipment_publishing.run' },
            readOnly: true,
          },
        },
        async (request, reply) => {
          reply.header('cache-control', 'no-store');
          if (!request.tenantContext)
            throw new IdentityError(
              401,
              'UNAUTHENTICATED',
              'Sign in to continue.',
            );
          const tenant = await context.refreshContext(request.tenantContext);
          await context.requirePermission(tenant, {
            app: 'shopify',
            permission: 'shopify:shipment_publishing.run',
            scopes: ['orders.read', 'fulfillment.read'],
          });
          const target = z
            .object({
              connectionId: z.string().uuid(),
              orderId: z.string().regex(/^gid:\/\/shopify\/Order\/[0-9]+$/),
            })
            .strict()
            .parse(request.body);
          await installations.credential(
            tenant,
            target.connectionId,
            'fulfillment.read',
          );

          return {
            enabled:
              (await context.featureEnabled?.(
                tenant.tenantId,
                'shopify-shipment-publishing',
              )) ?? false,
            sources:
              (await context.shipmentDispatchOptions?.(tenant, target)) ?? [],
          };
        },
      );
      registerOrderEditRoutes(server, edits);
      server.post(
        '/v1/organizations/:organizationId/apps/shopify/record-connections',
        { config: { access: { access: 'member' }, readOnly: true } },
        async (request, reply) => {
          reply.header('cache-control', 'no-store');
          if (!request.tenantContext)
            throw new IdentityError(
              401,
              'UNAUTHENTICATED',
              'Sign in to continue',
            );
          const version = await context.requireInstalled(
            request.tenantContext,
            'shopify',
          );

          return (await installations.list(request.tenantContext))
            .filter(
              (item) =>
                item.appId === 'shopify' &&
                item.provider === 'shopify' &&
                item.target.kind === 'shopify' &&
                item.appInstallationVersion === version &&
                item.status === 'active',
            )
            .map((item) => ({ id: item.id, label: item.label }));
        },
      );
      server.post(
        '/v1/organizations/:organizationId/apps/shopify/access',
        { config: { access: { permission: 'connections.manage' } } },
        async (request, reply) => {
          reply.header('cache-control', 'no-store');
          if (!request.tenantContext)
            throw new IdentityError(
              401,
              'UNAUTHENTICATED',
              'Sign in to continue',
            );
          await context.requireInstalled(request.tenantContext, 'shopify');
          if (!oauth)
            throw new IdentityError(
              503,
              'SERVICE_UNAVAILABLE',
              'Shopify authorization is not configured',
            );
          const input = z
            .object({ connectionId: z.string().uuid().optional() })
            .strict()
            .parse(request.body);

          return oauth.access(request.tenantContext, input.connectionId);
        },
      );
      server.post(
        '/v1/organizations/:organizationId/apps/shopify/authorize',
        { config: { access: { permission: 'connections.manage' } } },
        async (request) => {
          if (!request.tenantContext)
            throw new IdentityError(
              401,
              'UNAUTHENTICATED',
              'Sign in to continue',
            );
          await context.requireInstalled(request.tenantContext, 'shopify');
          if (!oauth)
            throw new IdentityError(
              503,
              'SERVICE_UNAVAILABLE',
              'Shopify authorization is not configured',
            );

          return oauth.start(request.tenantContext, request.body);
        },
      );
    },
  };
}

export { createShopifyRecordReader } from './infrastructure/records.js';

export { createShopifyUnsettledStockReader } from './infrastructure/stock-effects.js';

/** Order edit persistence, exported so runtime tests can prove its claims, fence and isolation on PostgreSQL. */
export { createOrderEditStore } from './infrastructure/order-edit-store.js';

export { createCorrectionStore } from './infrastructure/inventory-correction-store.js';
