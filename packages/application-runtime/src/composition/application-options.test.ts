import { describe, expect, it } from 'vitest';

import { applicationOptionsFor } from './application-options.js';

const decision = { id: 'app-decisions' };
const workflow = { id: 'app-workflow' };
const evidence = { appId: 'app-evidence' };
const host = {
  connections: { list: async () => [] },
  registry: {
    providers: () => [],
    evidenceSources: () => [evidence],
    workflowSources: () => [workflow],
    actionPermission: () => null,
  },
  providerCatalog: { get: () => undefined },
  connectionEnvironment: async () => ({
    environment: 'unknown',
    provenance: null,
  }),
  decisionSources: () => [decision],
} as unknown as Parameters<typeof applicationOptionsFor>[0];

describe('applicationOptionsFor', () => {
  it('gives every runtime the installed apps and provider runtimes', () => {
    const options = applicationOptionsFor(host);

    expect(options.decisionSources).toEqual([decision]);
    expect(options.evidenceSources).toEqual([evidence]);
    expect(options.workflowSources).toEqual([workflow]);
    expect(options.nativeStockReader).toBeDefined();
    expect(options.purchasing?.installations).toBe(host.connections);
    expect(options.returns?.installations).toBe(host.connections);
    expect(options.messaging).toMatchObject({
      installations: host.connections,
    });
    expect(options.messaging?.reader).toBeDefined();
    expect(options.messaging?.sender).toBeDefined();
  });

  it('keeps purchase orders, returns and mailboxes local without provider runtimes', () => {
    const options = applicationOptionsFor(host, { providerRuntimes: false });

    expect(options.purchasing).toBeUndefined();
    expect(options.returns).toBeUndefined();
    expect(options.messaging).toBeUndefined();
    expect(options.nativeStockReader).toBeDefined();
  });

  it('reports model features unavailable without a model gateway', () => {
    const options = applicationOptionsFor(host);

    expect(options.modelGateway).toBeUndefined();
    for (const availability of [
      options.authoring,
      options.supplierExtraction,
      options.assistant,
      options.documentExtraction,
    ]) {
      expect(availability?.available).toBe(false);
      expect(availability?.reason).toContain('aren’t configured');
    }
  });
});
