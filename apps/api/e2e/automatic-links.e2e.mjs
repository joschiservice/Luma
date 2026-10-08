import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { automaticLinksFixture } from './automatic-links-fixture.mjs';

it('previews unique SKU matches and applies audited rules with tenant and role boundaries', async (t) => {
  const f = await automaticLinksFixture(t);
  const path = `${f.base}/sync/automatic-links`;
  const pair = {
    kind: 'sku',
    targetConnectionId: f.store,
    sourceConnectionId: f.erp,
  };
  expect(await f.request(f.member, path)).toEqual([]);
  await f.request(f.member, `${path}/preview`, 'POST', pair, 403);
  await f.request(f.outsider, path, 'GET', undefined, 404);
  const preview = await f.request(f.owner, `${path}/preview`, 'POST', pair);
  expect(preview).toMatchObject({
    ready: true,
    counts: { eligible: 1, stale: 1 },
  });
  expect(
    preview.candidates.find((candidate) => candidate.key === 'auto-1'),
  ).toMatchObject({ disposition: 'eligible' });
  const input = { ...pair, id: randomUUID(), revision: 0, enabled: true };
  await f.request(f.member, path, 'PUT', input, 403);
  const rule = await f.request(f.owner, path, 'PUT', input);
  expect(rule).toMatchObject({ revision: 1, state: 'waiting', linked: 0 });
  await f.request(f.owner, path, 'PUT', input, 409);
  await f.request(
    f.owner,
    `${path}/preview`,
    'POST',
    { ...pair, sourceConnectionId: randomUUID() },
    404,
  );
  await f.request(
    f.owner,
    `${path}/preview`,
    'POST',
    { ...pair, sourceConnectionId: f.store },
    422,
  );
  await f.request(
    f.owner,
    `${path}/preview`,
    'POST',
    { ...pair, kind: 'location' },
    400,
  );
  await f.request(
    f.owner,
    `${path}/preview`,
    'POST',
    {
      ...pair,
      kind: 'order',
      targetConnectionId: f.erp,
      sourceConnectionId: f.store,
    },
    422,
  );
  await f.automaticLinks.apply(f.context, rule.id);
  expect(await f.request(f.member, path)).toMatchObject([
    { state: 'active', linked: 1 },
  ]);
  const after = await f.request(f.owner, `${path}/preview`, 'POST', pair);
  expect(after.counts.eligible).toBe(0);
  const disabled = await f.request(f.owner, path, 'PUT', {
    ...input,
    revision: 1,
    enabled: false,
  });
  expect(disabled).toMatchObject({ state: 'disabled', revision: 2, linked: 1 });
  expect(
    (
      await f.db.owner.query(
        'SELECT revision,enabled FROM commerce_auto_link_rule_revisions WHERE tenant_id=$1 ORDER BY revision',
        [f.org.id],
      )
    ).rows,
  ).toEqual([
    { revision: 1, enabled: true },
    { revision: 2, enabled: false },
  ]);
});
