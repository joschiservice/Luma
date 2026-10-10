import { setTimeout as delay } from 'node:timers/promises';

import { simulatedAccountId } from '@luma/simulator-cin7';

/**
 * Waits until a simulator run finishes provisioning, reporting progress, and returns its
 * detail. Rejects when provisioning fails or exceeds the timeout.
 * @param {(path: string, body?: unknown, method?: string) => Promise<any>} call
 * @param {string} runId
 */
export async function waitForRun(
  call,
  runId,
  { timeoutMs = 600_000, report } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    const run = await call(`runs/${runId}`);
    if (run.status === 'ready') return run;
    if (run.status === 'failed')
      throw new Error(`Simulator run ${runId} failed: ${run.error}`);
    const line = run.progress
      ? `${run.progress.step} ${run.progress.done.toLocaleString('en')}/${run.progress.total.toLocaleString('en')}`
      : 'Provisioning';
    if (report && line !== last) report(line);
    last = line;
    if (Date.now() > deadline)
      throw new Error(`Simulator run ${runId} did not finish provisioning`);
    await delay(500);
  }
}

/**
 * Describes a ready run for pilot provisioning: one connection per provider instance, the SKU
 * pair the inventory monitor compares (ERP item 2 and its first shop listing), and the catalog
 * and shop locations a merchant links for stock detection.
 * @param {any} run detail from `GET /api/runs/:id`
 */
export function simulatorInstances(run) {
  const shops = run.merchant.shops;
  const erp = run.instances.find((instance) => instance.kind !== 'shopify');

  return {
    erp: { name: erp.name, kind: erp.kind },
    instances: [
      erp.kind === 'cin7'
        ? {
            name: erp.name,
            kind: 'cin7',
            label: 'Cin7',
            accountId: simulatedAccountId,
          }
        : { name: erp.name, kind: 'jtl', label: 'JTL' },
      ...shops.map((shop) => ({
        name: shop.instance,
        kind: 'shopify',
        label: shop.name,
        shop: shop.domain,
      })),
    ],
    inventory: {
      shop: shops[0].instance,
      erpItem: '2',
      inventoryItem: 'gid://shopify/InventoryItem/2',
      location: `gid://shopify/Location/${shops[0].location}`,
    },
    stock: {
      profile: run.profile.name,
      seed: run.seed,
      // Each shop location sells one ERP warehouse's stock under Cin7, all warehouses under JTL.
      warehouses: Object.fromEntries(
        shops.map((shop) => [shop.instance, shop.location]),
      ),
      locations: Object.fromEntries(
        shops.map((shop) => [
          shop.instance,
          `gid://shopify/Location/${shop.location}`,
        ]),
      ),
    },
  };
}

/**
 * Subscribes Luma's Shopify change route to every simulated shop of the run, signed with the
 * manifest's webhook secret.
 */
export async function registerWebhooks(call, manifest, apiOrigin) {
  const targets = manifest.simulator.instances
    .filter((instance) => instance.kind === 'shopify')
    .map((instance) => ({
      instance: instance.name,
      url: new URL(
        `/v1/shopify/changes/${manifest.organizationId}/${manifest.connections[instance.name]}`,
        apiOrigin,
      ).toString(),
      secret: manifest.simulator.webhookSecret,
    }));
  await call(`runs/${manifest.simulator.runId}/webhooks`, { targets }, 'PUT');
}
