import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { defaultConfiguration } from '../../apps/api/dist/modules/exceptions/index.js';
import { parseInput } from '../../apps/api/dist/modules/exceptions/composition.js';

export const scenarios = [
  'healthy',
  'decisions-needed',
  'diagnosis-pending',
  'uncertain',
  'approval-required',
  'rejected',
  'executing',
  'verifying',
  'resolved',
  'failed',
  'recovery',
];
export const readJson = async (path) =>
  JSON.parse(await readFile(path, 'utf8'));
export const corpus = await readJson(
  new URL('../../docs/fixtures/exceptions-v0.json', import.meta.url),
);
export const jtl = await readJson(
  new URL(
    '../../apps/api/src/modules/connectors/infrastructure/jtl/fixtures/commerce.json',
    import.meta.url,
  ),
);
export const shopify = await readJson(
  new URL(
    '../../apps/api/src/modules/connectors/infrastructure/shopify/fixtures/commerce.json',
    import.meta.url,
  ),
);

// Move all source timestamps together so relative threshold boundaries stay intact.
function shift(value, epoch) {
  if (typeof value === 'string' && /^2026-\d\d-\d\dT/.test(value))
    return new Date(
      Date.parse(value) + Date.parse(epoch) - Date.parse(corpus.now),
    ).toISOString();
  if (Array.isArray(value)) return value.map((item) => shift(item, epoch));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, shift(item, epoch)]),
    );
  return value;
}

export function detectionRequest(manifest, kind, variant = 'default') {
  const key = `pilot:${manifest.runId}:${kind}:${variant}`;
  const base = shift(corpus.bases[kind], manifest.epoch);
  const subjectId = manifest.subjects[kind];
  const connections =
    kind === 'inventory_mismatch'
      ? [manifest.connections.jtl, manifest.connections.shopify]
      : kind === 'workflow_failure'
        ? [null]
        : [manifest.connections.jtl];
  const refs = connections.map((_, i) => {
    const hex = createHash('sha256').update(`${key}:${i}`).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  });
  const facts = {
    ...base,
    tenantId: manifest.organizationId,
    evidenceTenantId: manifest.organizationId,
    subjectId,
    evidenceRefs: refs,
    ...(kind === 'inventory_mismatch'
      ? {
          connectionIds: connections,
          canonicalLocationId: manifest.locationId,
          leftAvailable: String(jtl.items[0].stockAvailable),
          rightAvailable: String(
            shopify.levels[1].quantities.find(
              (value) => value.name === 'available',
            ).quantity,
          ),
        }
      : kind === 'workflow_failure'
        ? { runId: subjectId, stepKey: 'correct-order-shipping-method' }
        : { connectionId: manifest.connections.jtl }),
    ...(variant === 'uncertain'
      ? { durable: false, status: 'interrupted' }
      : {}),
  };
  return {
    key,
    input: parseInput(kind, facts),
    configuration: structuredClone(defaultConfiguration),
    evidence: refs.map((key, i) => ({
      key,
      tenantId: manifest.organizationId,
      connectionId: connections[i],
      observedAt: manifest.epoch,
      sourceUpdatedAt: null,
      adapterVersion: 'synthetic-pilot-v1',
      schemaVersion: 1,
      source:
        kind === 'workflow_failure'
          ? null
          : {
              provider: i === 1 ? 'shopify' : 'jtl',
              resource: kind === 'inventory_mismatch' ? 'inventory' : 'order',
              externalId:
                i === 1
                  ? shopify.inventoryItem.id
                  : String(
                      kind === 'inventory_mismatch'
                        ? jtl.items[0].id
                        : jtl.orders[0].id,
                    ),
              scopeKey: '',
            },
      facts: { synthetic: true, scenario: kind, ...facts },
    })),
  };
}

export function newManifest(scenario) {
  if (!scenarios.includes(scenario))
    throw new Error(`Choose a scenario: ${scenarios.join(', ')}`);
  return {
    schemaVersion: 1,
    synthetic: true,
    scenario,
    runId: randomUUID(),
    epoch: new Date().toISOString(),
    subjects: Object.fromEntries(
      Object.keys(corpus.bases).map((kind) => [kind, randomUUID()]),
    ),
    proposalId: randomUUID(),
    locationId: randomUUID(),
    incidents: {},
  };
}
