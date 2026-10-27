// @ts-check
import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { automaticLinksFixture } from './automatic-links-fixture.mjs';
import { expectStatus, injectClient } from './typed-client.mjs';

it('previews unique SKU matches and applies audited rules with tenant and role boundaries', async (t) => {
  const f = await automaticLinksFixture(t);
  const origin = f.config.baseURL;
  const owner = injectClient(f.app, { origin, cookie: f.owner.cookie }).sync;
  const member = injectClient(f.app, { origin, cookie: f.member.cookie }).sync;
  const outsider = injectClient(f.app, {
    origin,
    cookie: f.outsider.cookie,
  }).sync;
  const params = { organizationId: f.org.id };
  /** @type {import('@luma/api-contract').AutoLinkPair} */
  const pair = {
    kind: 'sku',
    targetConnectionId: f.store,
    sourceConnectionId: f.erp,
  };
  expect(await member.autoLinkRules({ params })).toEqual([]);
  await expectStatus(member.previewAutoLinks({ params, body: pair }), 403);
  await expectStatus(outsider.autoLinkRules({ params }), 404);
  const preview = await owner.previewAutoLinks({ params, body: pair });
  expect(preview).toMatchObject({
    ready: true,
    counts: { eligible: 1, stale: 1 },
  });
  expect(
    preview.candidates.find((candidate) => candidate.key === 'auto-1'),
  ).toMatchObject({ disposition: 'eligible' });
  const input = { ...pair, id: randomUUID(), revision: 0, enabled: true };
  await expectStatus(member.saveAutoLinkRule({ params, body: input }), 403);
  const rule = await owner.saveAutoLinkRule({ params, body: input });
  expect(rule).toMatchObject({ revision: 1, state: 'waiting', linked: 0 });
  await expectStatus(owner.saveAutoLinkRule({ params, body: input }), 409);
  await expectStatus(
    owner.previewAutoLinks({
      params,
      body: { ...pair, sourceConnectionId: randomUUID() },
    }),
    404,
  );
  await expectStatus(
    owner.previewAutoLinks({
      params,
      body: { ...pair, sourceConnectionId: f.store },
    }),
    422,
  );
  await expectStatus(
    owner.previewAutoLinks({
      params,
      // @ts-expect-error The contract rejects record types without automatic links.
      body: { ...pair, kind: 'location' },
    }),
    400,
  );
  await expectStatus(
    owner.previewAutoLinks({
      params,
      body: {
        ...pair,
        kind: 'order',
        targetConnectionId: f.erp,
        sourceConnectionId: f.store,
      },
    }),
    422,
  );
  await f.automaticLinks.apply(f.context, rule.id);
  expect(await member.autoLinkRules({ params })).toMatchObject([
    { state: 'active', linked: 1 },
  ]);
  const after = await owner.previewAutoLinks({ params, body: pair });
  expect(after.counts.eligible).toBe(0);
  const disabled = await owner.saveAutoLinkRule({
    params,
    body: { ...input, revision: 1, enabled: false },
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
