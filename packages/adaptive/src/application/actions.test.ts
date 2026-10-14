import {
  builtInMembership,
  IdentityError,
  makeTenantContext,
  PermissionSet,
} from '@luma/identity';
import { expect, it } from 'vitest';

import type { ViewActionResult } from '../domain/actions.js';
import type { AdaptiveViewQuery } from '../domain/views.js';
import type { ViewActionCapability } from './actions.js';
import { createViewActions } from './actions.js';

let identity = 0;
const randomUUID = () =>
  `00000000-0000-4000-8000-${String(++identity).padStart(12, '0')}`;

function fixture() {
  const tenantId = randomUUID(),
    actorId = randomUUID();
  const context = makeTenantContext(
    { userId: actorId, sessionId: randomUUID() },
    {
      id: tenantId,
      name: 'Shop',
      slug: 'shop',
      dataRegion: 'EU',
      status: 'active',
    },
    builtInMembership(
      { id: randomUUID(), organizationId: tenantId, userId: actorId },
      'owner',
    ),
    randomUUID(),
  );
  const actionId = randomUUID(),
    viewId = randomUUID(),
    recordIds = Array.from({ length: 20 }, () => randomUUID());
  let dispatched = 0,
    revision = 1,
    release = true;
  const rows = recordIds.map((id) => ({ id, reference: `PO-${id}` }));
  const capability: ViewActionCapability = {
    id: 'supplier.follow-up',
    kind: 'capability',
    domains: ['procurement'],
    permissions: ['procurement.manage'],
    inputs: { reference: 'string' },
    validateInputs: (input) => {
      if (typeof input.reference === 'string' && input.reference.length > 80)
        throw new IdentityError(
          422,
          'VALIDATION_ERROR',
          'Reference is too long.',
        );
    },
    available: async () => null,
    review: async (_c, id) => ({
      scope: id,
      changes: [{ label: 'Follow up', before: null, after: 'Draft' }],
      approval: 'Inbox approval',
      verification: 'Independent send verification',
      evidence: String(revision),
    }),
    propose: async (_c, id) => {
      dispatched++;
      if (id === recordIds[3]) throw new Error('lost response');

      return {
        state: 'proposed',
        reason: null,
        proposalId: randomUUID(),
        destination: 'inbox',
      };
    },
  };
  const query: AdaptiveViewQuery = {
    version: 2,
    domain: 'procurement',
    state: {
      segment: null,
      where: { match: 'all', conditions: [] },
      sort: null,
      group: null,
      layout: 'table',
      density: 'comfortable',
      columns: [{ id: 'reference' }],
      properties: [],
      preview: false,
    },
    metrics: [],
    charts: [],
    actions: [
      {
        id: actionId,
        label: { en: 'Follow up', de: 'Nachfragen' },
        target: { kind: 'capability', id: 'supplier.follow-up' },
        inputs: { reference: { source: 'row', field: 'reference' } },
      },
    ],
  };
  const receipts = new Map<
    string,
    { digest: string; results: ViewActionResult[] }
  >();
  const service = createViewActions({
    refreshContext: async (c) => c,
    released: async () => release,
    view: async () => ({ query }),
    rows: async (_c, _v, ids) => rows.filter((r) => ids.includes(r.id)),
    catalog: async () => [capability],
    rowTypes: async () => ({ id: 'string', reference: 'string' }) as const,
    digest: JSON.stringify,
    commandId: (command, id) => `${command}:${id}`,
    receipts: {
      get: async (_c, id, digest) => {
        const r = receipts.get(id);
        if (r && r.digest !== digest)
          throw new IdentityError(409, 'CONFLICT', 'Command reused');

        return r?.results ?? null;
      },
      claim: async (_c, id, digest, initial) => {
        const old = receipts.get(id);
        if (old) return old.results;
        receipts.set(id, { digest, results: initial });

        return null;
      },
      save: async (_c, id, digest, results) => {
        receipts.set(id, { digest, results });
      },
    },
  });

  return {
    context,
    service,
    viewId,
    actionId,
    recordIds,
    capability,
    query,
    receipts,
    dispatched: () => dispatched,
    revise: () => revision++,
    disable: () => (release = false),
  };
}

it('reports each of 20 commands independently and retained uncertainty prevents duplicate retries', async () => {
  const f = fixture(),
    request = { commandId: randomUUID(), recordIds: f.recordIds };
  const review = await f.service.preview(
    f.context,
    f.viewId,
    f.actionId,
    request,
  );
  expect(review.items).toHaveLength(20);
  expect(review.items[0]?.changes[0]?.after).toBe('Draft');
  const first = await f.service.run(f.context, f.viewId, f.actionId, {
    ...request,
    reviewDigest: review.reviewDigest,
  });
  expect(first.items).toHaveLength(20);
  expect(first.items[3]?.state).toBe('uncertain');
  expect(first.items.filter((i) => i.state === 'proposed')).toHaveLength(19);
  f.revise();
  const retry = await f.service.run(f.context, f.viewId, f.actionId, {
    ...request,
    reviewDigest: review.reviewDigest,
  });
  expect(retry).toEqual(first);
  expect(f.dispatched()).toBe(20);
  await expect(
    f.service.run(f.context, f.viewId, f.actionId, {
      ...request,
      recordIds: [f.recordIds[0]!],
      reviewDigest: review.reviewDigest,
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
});
it('refuses stale proposals and IDs outside the saved query before dispatch', async () => {
  const f = fixture(),
    request = { commandId: randomUUID(), recordIds: [f.recordIds[0]!] };
  const review = await f.service.preview(
    f.context,
    f.viewId,
    f.actionId,
    request,
  );
  f.revise();
  await expect(
    f.service.run(f.context, f.viewId, f.actionId, {
      ...request,
      reviewDigest: review.reviewDigest,
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
  await expect(
    f.service.preview(f.context, f.viewId, f.actionId, {
      ...request,
      recordIds: [randomUUID()],
    }),
  ).rejects.toMatchObject({ statusCode: 404 });
  expect(f.dispatched()).toBe(0);
});
it('validates mapped input types and refuses arbitrary capabilities', async () => {
  const f = fixture();
  f.query.actions[0]!.inputs.reference = { source: 'literal', value: 123 };
  await expect(f.service.validate(f.context, f.query)).rejects.toMatchObject({
    statusCode: 422,
  });
  f.query.actions[0]!.target.id = 'invented.send';
  await expect(f.service.validate(f.context, f.query)).rejects.toMatchObject({
    statusCode: 422,
  });
  expect(
    (await f.service.catalog(f.context, f.viewId)).items[0]?.available,
  ).toBe(false);
});
it('release withdrawal blocks both preview and execution without weakening owner permissions', async () => {
  const f = fixture();
  f.disable();
  await expect(
    f.service.preview(f.context, f.viewId, f.actionId, {
      commandId: randomUUID(),
      recordIds: [f.recordIds[0]!],
    }),
  ).rejects.toMatchObject({ statusCode: 503 });
  expect(f.dispatched()).toBe(0);
});

it('rejects incompatible row mappings and invalid literals before saving and duplicates only visible bindings', async () => {
  const f = fixture();
  f.query.state.columns.push({ id: 'total' });
  f.query.actions[0]!.inputs.reference = { source: 'row', field: 'total' };
  await expect(f.service.validate(f.context, f.query)).rejects.toMatchObject({
    statusCode: 422,
  });
  f.query.actions[0]!.inputs.reference = { source: 'row', field: 'supplier' };
  await expect(f.service.validate(f.context, f.query)).rejects.toMatchObject({
    statusCode: 422,
    message: 'Choose a supported visible row field for each action input.',
  });
  f.query.actions[0]!.inputs.reference = {
    source: 'literal',
    value: 'x'.repeat(81),
  };
  await expect(f.service.validate(f.context, f.query)).rejects.toMatchObject({
    statusCode: 422,
  });
  f.query.actions[0]!.inputs.reference = { source: 'row', field: 'reference' };
  const reader = {
    ...f.context,
    permissions: new PermissionSet(['procurement.read']),
  };
  expect((await f.service.copyBindings(reader, f.query)).actions).toEqual([]);
  expect((await f.service.catalog(reader, f.viewId)).items).toEqual([]);
  await expect(
    f.service.preview(reader, f.viewId, f.actionId, {
      commandId: randomUUID(),
      recordIds: [f.recordIds[0]!],
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
});
