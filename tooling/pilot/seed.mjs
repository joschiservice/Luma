import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  buildRuntimeApp,
  createApplicationServices,
  createDetectionServices,
} from '@luma/application-runtime';
import { createSimulationTransport } from '@luma/connections/composition';
import { createIdentity } from '@luma/identity/composition';
import { createTenantDatabase } from '@luma/platform/composition';
import { shippingMethodPlaybook } from '@luma/resolution';
import { Pool } from 'pg';

import {
  createInstallationVerifier,
  createInstalledConnections,
} from '../apps/providers.mjs';
import { detectionRequest, jtl, newManifest, readJson } from './fixtures.mjs';

/** Builds identity-service settings from the pilot's environment. */
export const identitySettings = (env) => ({
  databaseUrl: env.IDENTITY_DATABASE_URL,
  secret: env.BETTER_AUTH_SECRET,
  cookiePrefix: env.BETTER_AUTH_COOKIE_PREFIX,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.BETTER_AUTH_URL],
});

/**
 * Seeds an isolated synthetic scenario and writes its manifest and fixtures to the pilot
 * directory.
 */
export async function seedPilot(
  saved,
  env,
  directory,
  scenario = 'approval-required',
  reset = false,
  simulator,
) {
  const path = join(directory, 'pilot.json');
  if (!reset) {
    try {
      return await readJson(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const manifest = newManifest(scenario);
  if (simulator)
    manifest.simulator = {
      ...simulator,
      bindings: [],
      // Signs simulated Shopify webhooks; local synthetic value, never a real app secret.
      webhookSecret: randomBytes(24).toString('hex'),
    };
  const settings = identitySettings(env);
  const app = await buildRuntimeApp(settings);
  const identity = createIdentity(settings);
  const pool = new Pool({ connectionString: env.WORKFLOW_DATABASE_URL });
  const detection = createDetectionServices(env.WORKFLOW_DATABASE_URL);
  const connections = createInstalledConnections(createTenantDatabase(pool), {
    refreshContext: identity.service.refreshContext,
    activeKeyId: env.CONNECTIONS_ACTIVE_KEY_ID,
    keys: new Map(
      Object.entries(JSON.parse(env.CONNECTIONS_KEYS)).map(([id, key]) => [
        id,
        Buffer.from(key, 'base64'),
      ]),
    ),
    // Install pending configuration only. Synthetic observations never mark a real connection healthy.
    verify: async (...args) => {
      if (!manifest.simulator) throw new Error('Synthetic connection');

      return createInstallationVerifier({
        jtlEndpoints: [],
        simulation: createSimulationTransport(manifest.simulator),
      })(...args);
    },
  });
  let cookie;

  async function request(url, payload) {
    const response = await app.inject({
      method: payload ? 'POST' : 'GET',
      url,
      headers: { origin: settings.baseURL, ...(cookie ? { cookie } : {}) },
      ...(payload ? { payload } : {}),
    });
    if (response.statusCode >= 300)
      throw new Error(`Pilot request failed: ${url} (${response.statusCode})`);

    return response;
  }

  async function login(email) {
    const payload = { email, password: saved.seedPassword };
    let response = await app.inject({
      method: 'POST',
      url: '/auth/sign-in/email',
      headers: { origin: settings.baseURL },
      payload,
    });
    if (response.statusCode === 401)
      response = await request('/auth/sign-up/email', {
        ...payload,
        name: 'Synthetic pilot operator',
      });
    if (response.statusCode !== 200) throw new Error('Pilot sign-in failed');
    const cookies = response.headers['set-cookie'];
    cookie = (Array.isArray(cookies) ? cookies : [cookies])
      .filter(Boolean)
      .map((value) => value.split(';')[0])
      .join('; ');

    return response.json().user.id;
  }

  try {
    manifest.operatorId = await login('pilot-operator@example.test');
    await request('/auth/sign-out', {});
    manifest.requesterId = await login('pilot-requester@example.test');
    const organization = (
      await request('/v1/organizations', {
        name: `Synthetic pilot · ${scenario}`,
        slug: `pilot-${manifest.runId}`,
        dataRegion: 'EU',
      })
    ).json();
    manifest.organizationId = organization.id;
    // Synthetic pilot scenarios deliberately exercise governed provider writes.
    const writeMode = await app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${organization.id}/settings/write-mode`,
      headers: { origin: settings.baseURL, cookie },
      payload: {
        commandId: randomUUID(),
        revision: 0,
        writeMode: 'writes_enabled',
      },
    });
    if (writeMode.statusCode !== 200)
      throw new Error('Pilot write-mode setup failed');
    const context = await identity.service.resolveTenant(
      { cookie },
      organization.id,
      'pilot-seed',
    );
    await identity.service.changeMember(context, {
      action: 'add',
      userId: manifest.operatorId,
      roleId: 'admin',
    });
    // An example custom role so the pilot shows how workspaces tailor access.
    const roles = identity.roles();
    if (
      !(await roles.list(context)).roles.some((role) => role.name === 'Buyer')
    )
      await roles.create(context, randomUUID(), {
        name: 'Buyer',
        description: 'Works with suppliers and purchase orders.',
        permissions: [
          'orders.read',
          'inventory.read',
          'products.read',
          'procurement.read',
          'procurement.manage',
          'decisions.self_assign',
          'assistant.use',
          'activity.read',
        ],
      });
    manifest.connections = {};
    // Simulator runs describe their own instances; the plain pilot uses one ERP and one shop.
    const instances = simulator?.instances ?? [
      { name: 'jtl', kind: 'jtl', label: 'JTL' },
      {
        name: 'shopify',
        kind: 'shopify',
        label: 'Shopify',
        shop: 'luma-synthetic-pilot.myshopify.com',
      },
    ];
    manifest.primaryShop = instances.find(
      (item) => item.kind === 'shopify',
    ).name;
    for (const instance of instances) {
      const target =
        instance.kind === 'jtl'
          ? {
              kind: 'jtl-onprem',
              baseUrl: 'https://jtl.synthetic.invalid/api/eazybusiness/',
              appId: 'LumaSyntheticPilot',
              appVersion: '1',
            }
          : instance.kind === 'cin7'
            ? { kind: 'cin7-core', accountId: instance.accountId }
            : { kind: 'shopify', shop: instance.shop };
      const appId = instance.kind;
      const apps = await connections.apps.list(context);
      const appState = apps.installations.find((app) => app.appId === appId);
      if (appState?.status !== 'installed')
        await connections.apps.install(
          context,
          appId,
          appState?.version ?? null,
          apps.catalog.find((app) => app.id === appId)?.scopes ?? [],
        );
      const connection = await connections.install(context, {
        label: `SIMULATED ${instance.label.toUpperCase()} · no live health`,
        target,
        permissions: [
          'orders.read',
          'inventory.read',
          'fulfillment.read',
          ...(simulator
            ? [
                'products.read',
                ...(instance.kind === 'shopify'
                  ? [
                      'inventory.available.reconcile',
                      'returns.read',
                      'customers.read',
                      'fulfillment.hold.release',
                      'fulfillment.open',
                      'fulfillment.move',
                    ]
                  : instance.kind === 'cin7'
                    ? [
                        'returns.read',
                        'customers.read',
                        'suppliers.read',
                        'purchase-orders.read',
                      ]
                    : [
                        'customers.read',
                        'orders.shipping-method.read',
                        'orders.shipping-method.write',
                        'suppliers.read',
                        'purchase-orders.read',
                        'purchase-orders.submit',
                      ]),
              ]
            : []),
        ],
        credentials: {
          token: 'synthetic-not-a-provider-secret',
          ...(instance.kind === 'jtl' ? { challengeCode: 'synthetic' } : {}),
        },
      });
      manifest.connections[instance.name] = connection.id;
      if (simulator) {
        manifest.simulator.bindings.push({
          tenantId: manifest.organizationId,
          connectionId: connection.id,
          target,
          runId: simulator.runId,
          instance: instance.name,
          provider: instance.kind,
        });
        await connections.check(context, connection.id, connection.version);
      }
    }
    if (scenario !== 'healthy') {
      for (const kind of [
        'sync_failure',
        'stuck_fulfillment',
        'inventory_mismatch',
        'workflow_failure',
      ]) {
        const result = await detection.exceptions.ingest(
          context,
          detectionRequest(manifest, kind),
        );
        if (!result.incident)
          throw new Error(`Pilot fixture did not detect ${kind}`);
        manifest.incidents[kind] = result.incident.id;
        if (kind !== 'workflow_failure' || scenario !== 'diagnosis-pending')
          await detection.diagnoses.run(context, result.incident.id);
      }
      if (scenario === 'uncertain') {
        await detection.exceptions.ingest(
          context,
          detectionRequest(manifest, 'workflow_failure', 'uncertain'),
        );
        await detection.diagnoses.run(
          context,
          manifest.incidents.workflow_failure,
        );
      }
    }
    const { playbooks, library } = createApplicationServices({
      database: createTenantDatabase(pool),
      identity: identity.service,
      execution: { kind: 'disabled' },
    });
    await playbooks.publish(context, shippingMethodPlaybook);
    // Restarting the pilot must preserve a revocation made through the library.
    const history = await library.detail(
      context,
      shippingMethodPlaybook.definition.id,
    );
    // The shipping-method example corrects a JTL order; Cin7 connections are read-only.
    if (
      manifest.connections.jtl &&
      !history.activations.some((item) => item.id === manifest.proposalId)
    )
      await playbooks.activate(context, {
        id: manifest.proposalId,
        definitionId: shippingMethodPlaybook.definition.id,
        version: shippingMethodPlaybook.version,
        grants: {
          principalIds: [manifest.requesterId],
          connectionIds: [manifest.connections.jtl],
          targetIds: [manifest.subjects.workflow_failure],
        },
        policyVersion: 'v0.1',
      });

    await request('/auth/sign-out', {});
    await writeFile(
      join(directory, `provider-${manifest.runId}.json`),
      `${JSON.stringify(
        {
          synthetic: true,
          order: { ...jtl.orders[0], shippingMethodId: '7' },
          effects: [],
          observations: [],
        },
        null,
        2,
      )}\n`,
      { mode: 0o600, flag: 'wx' },
    );
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(
      `Synthetic pilot: ${scenario}. Login: pilot-operator@example.test. Password: ${simulator ? '.luma/simulator-login.json' : '.luma/demo.json'}.`,
    );

    return manifest;
  } finally {
    await Promise.all([
      app.close(),
      identity.close(),
      detection.close(),
      pool.end(),
    ]);
  }
}
