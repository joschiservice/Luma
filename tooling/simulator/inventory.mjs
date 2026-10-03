import { createHash } from 'node:crypto';

import { defaultConfiguration } from '@luma/exceptions';
import { requireRole, requireTenant } from '@luma/identity';
import { createInventoryMonitor } from '@luma/resolution';

const ref = (externalId, scopeKey = '') => ({ externalId, scopeKey });

/** Provisions the simulator's explicit SKU/location mapping and connects real inventory detection and verification. */
export async function createInventoryScenario({
  commerce,
  capabilities,
  operator,
  manifest,
}) {
  const actor = await operator();
  // The run names the SKU pair a merchant would have linked: ERP item 2 and its shop listing.
  const scenario = manifest.simulator.inventory;
  const prefix = `simulator:${manifest.simulator.runId}:inventory`;
  const skuId = await commerce.inventory.identify(
    actor,
    'sku',
    `${prefix}:sku`,
  );
  const locationId = await commerce.inventory.identify(
    actor,
    'location',
    `${prefix}:pool`,
  );
  const side = (instance, provider, sku, location) => ({
    source: {
      tenantId: manifest.organizationId,
      connectionId: manifest.connections[instance],
      provider,
      resource: 'sku',
      ...ref(sku, location),
    },
    sku: ref(sku),
    location: ref(location),
  });
  const mapping = {
    tenantId: manifest.organizationId,
    version: 'simulator-inventory-v1',
    publishedAt: manifest.epoch,
    skuId,
    locationId,
    left: side('jtl', 'jtl', scenario.erpItem, 'all-warehouses'),
    right: side(
      scenario.shop,
      'shopify',
      scenario.inventoryItem,
      scenario.location,
    ),
    authority: 'left',
    sellingSource: 'right',
  };
  const monitor = createInventoryMonitor({
    capabilities,
    mapping,
    configuration: defaultConfiguration,
    hash: (value) => createHash('sha256').update(value).digest('hex'),
    async project(context, observation) {
      const expected = [mapping.left, mapping.right].find(
        (side) => side.source.connectionId === observation.source.connectionId,
      );
      const { data, source } = observation;
      if (
        !expected ||
        data.sku.externalId !== expected.sku.externalId ||
        data.sku.scopeKey !== expected.sku.scopeKey ||
        data.location.externalId !== expected.location.externalId ||
        data.location.scopeKey !== expected.location.scopeKey
      )
        return false;
      const ingestKey = `simulator:${observation.id}`;
      await commerce.sources.record(context, ingestKey, {
        capability: 'inventory.read',
        observation,
      });
      for (const [resource, external, canonicalId] of [
        ['sku', data.sku, mapping.skuId],
        ['location', data.location, mapping.locationId],
      ]) {
        const identity = { ...source, ...external, resource };
        const bound = await commerce.sources.resolve(context, identity);
        if (bound && bound !== canonicalId) return false;
        if (!bound)
          await commerce.sources.bind(
            context,
            identity,
            canonicalId,
            observation.id,
            'Explicit simulator stock-pool mapping',
          );
      }
      const result = await commerce.ingestion.ingest(context, ingestKey, {
        capability: 'inventory.read',
        observation,
      });
      if (result.status === 'pending') return false;
      const current = (
        await commerce.inventory.current(context, result.entityId)
      ).find(
        (item) => item.snapshot.connectionId === source.connectionId,
      )?.snapshot;

      // A source without revision timestamps can confirm unchanged projected facts, but cannot replace different facts by receipt order.
      return (
        !!current &&
        !current.deleted &&
        ['unit', 'onHand', 'reserved', 'available', 'availabilityBasis'].every(
          (field) => current.data[field] === data[field],
        )
      );
    },
  });
  let lastCheck = null;
  let queue = Promise.resolve();

  async function status(context, exceptions) {
    requireTenant(context, manifest.organizationId);
    const incidents = (await exceptions.list(context)).filter(monitor.matches);
    const active = incidents.find((incident) => incident.state !== 'resolved');
    const latest =
      active ??
      incidents.sort((a, b) =>
        b.firstDetectedAt.localeCompare(a.firstDetectedAt),
      )[0] ??
      null;

    return {
      connected: true,
      organizationId: manifest.organizationId,
      lastCheck,
      incident: latest
        ? {
            id: latest.id,
            state: latest.state,
            occurrenceCount: latest.occurrenceCount,
            previousExceptionId: latest.previousExceptionId,
          }
        : null,
    };
  }

  function check(context, detection) {
    requireTenant(context, manifest.organizationId);
    requireRole(context, ['owner', 'admin']);
    // Every manual request gets a fresh pass after earlier background work finishes.
    const work = queue.then(async () => {
      try {
        const result = await monitor.check(context, detection.exceptions);
        if (result.incident && result.decision.decision === 'detect')
          await detection.diagnoses.run(context, result.incident.id);
        if (result.decision.decision === 'clear') {
          const current = await status(context, detection.exceptions);
          if (current.incident && current.incident.state !== 'resolved')
            await detection.exceptions.verify(context, current.incident.id);
        }
        lastCheck = {
          at: new Date().toISOString(),
          outcome: result.decision.decision,
          reason: result.decision.reason,
        };
      } catch (error) {
        lastCheck = {
          at: new Date().toISOString(),
          outcome: 'unavailable',
          reason: error.message,
        };
      }

      return status(context, detection.exceptions);
    });
    queue = work.catch(() => {
      // A failed status read must not prevent subsequent checks.
    });

    return work;
  }

  return { monitor, status, check };
}
