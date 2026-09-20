import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { progressOptions } from './progress-data';
import { caseDetailSchema } from '@luma/api-contract';

const id = '11111111-1111-4111-8111-111111111111';
const at = '2026-09-20T04:00:00Z';
const detail = caseDetailSchema.parse({
  schemaVersion: 1,
  id,
  revision: 1,
  class: 'inventory_mismatch',
  state: 'verifying',
  severity: 'high',
  summary: 'Inventory mismatch',
  subject: { kind: 'inventory', id, scope: [] },
  sources: [],
  detectedAt: at,
  lastActivityAt: at,
  attention: {
    required: false,
    reason: null,
    explanation: '',
    requestedAt: null,
  },
  freshness: 'fresh',
  diagnosisStatus: 'pending',
  resolution: null,
  diagnosis: null,
});
const progress = {
  schemaVersion: 1,
  caseRevision: 1,
  diagnosisRevision: 0,
  state: 'verifying',
  execution: null,
  resolution: null,
  workflow: { availability: 'unavailable', progress: null },
};
const event = {
  id,
  type: 'execution.prepared',
  occurredAt: at,
  actorId: null,
  proposalId: null,
  outcome: null,
  evidenceRefs: [],
};
const requests: string[] = [];
function mockReads(overrides: Record<string, unknown> = {}) {
  requests.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      requests.push(url);
      expect(init.credentials).toBe('same-origin');
      expect(init.cache).toBe('no-store');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const path = new URL(url, 'http://localhost');
      const resource = path.pathname.split('/').at(-1)!;
      const body =
        overrides[resource] ??
        {
          [id]: detail,
          review: {
            schemaVersion: 1,
            caseRevision: 1,
            diagnosisRevision: 0,
            permittedDecisions: [],
            proposal: null,
          },
          progress,
          timeline: {
            items: [event],
            nextCursor: path.searchParams.has('cursor') ? null : 'page-two',
          },
          evidence: { schemaVersion: 1, items: [], nextCursor: null },
        }[resource];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());
it('refetches history from page one, deduplicates overlapping events and isolates tenants', async () => {
  mockReads();
  const client = new QueryClient();
  const options = progressOptions('tenant-a', id, 2);
  const first = await client.fetchQuery(options);
  expect(first.timeline).toEqual([event]);
  expect(first.hasMore).toBe(false);
  expect(requests.filter((url) => url.includes('/timeline'))).toHaveLength(2);
  requests.length = 0;
  await client.fetchQuery(options);
  expect(requests.find((url) => url.includes('/timeline'))).not.toContain(
    'cursor=',
  );
  expect(progressOptions('tenant-b', id).queryKey).not.toEqual(
    progressOptions('tenant-a', id).queryKey,
  );
  expect(progressOptions('tenant-a', 'other').queryKey).not.toEqual(
    progressOptions('tenant-a', id).queryKey,
  );
  client.clear();
});
it('rejects snapshots that straddle a case transition', async () => {
  mockReads({ progress: { ...progress, caseRevision: 2, state: 'resolved' } });
  const client = new QueryClient();
  await expect(
    client.fetchQuery(progressOptions('tenant-a', id)),
  ).rejects.toThrow('Case changed during refresh');
  expect(
    client.getQueryData(progressOptions('tenant-a', id).queryKey),
  ).toBeUndefined();
  client.clear();
});
it('rejects malformed progress instead of retaining a success result', async () => {
  mockReads({ progress: { ...progress, state: 'success' } });
  const client = new QueryClient();
  await expect(
    client.fetchQuery(progressOptions('tenant-a', id)),
  ).rejects.toThrow();
  client.clear();
});
