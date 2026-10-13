import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { until } from './helpers.mjs';
import { setupSimulator } from './simulator-fixture.mjs';

/** Uses the real shipping adapter and public mapping commands, without inferred order or line identities. */
export async function starshipitOperationsFixture(
  t,
  origin = 'http://127.0.0.1:3000',
  options = {},
) {
  const f = await setupSimulator(t, { origin, ...options });
  const tenantId = f.manifest.organizationId;
  const base = `/v1/organizations/${tenantId}`;
  const cookies = new Map();
  for (const actor of ['operator', 'requester', 'warehouse']) {
    const response = await f.pilot.app.inject({
      method: 'POST',
      url: '/auth/sign-in/email',
      headers: { origin },
      payload: { email: `pilot-${actor}@example.test`, password: f.password },
    });
    assert.equal(response.statusCode, 200, response.body);
    cookies.set(
      actor,
      response.cookies.map(({ name, value }) => `${name}=${value}`).join('; '),
    );
  }
  const api = async (
    path,
    { method = 'GET', body, actor = 'operator', status = 200 } = {},
  ) => {
    const response = await f.pilot.app.inject({
      method,
      url: `${base}${path}`,
      headers: { cookie: cookies.get(actor), origin },
      ...(body === undefined ? {} : { payload: body }),
    });
    assert.equal(response.statusCode, status, response.body);

    return response.statusCode === 204 ? null : response.json();
  };
  await f.pilot.observe({ check: false });
  const mapped = async (connection, external) =>
    (
      await f.db.owner.query(
        "SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource='order' AND external_id=$3",
        [tenantId, connection, external],
      )
    ).rows[0].canonical_id;
  const shop = await mapped(
    f.manifest.connections.shopify,
    'gid://shopify/Order/1',
  );
  const shipping = await mapped(f.manifest.connections.starshipit, '1');
  const complete = (request) =>
    until(
      async () => {
        await f.pilot.observe({ refresh: false, check: false });
        const current = await api(`/identities/links/${request.id}`);
        if (current.state === 'failed')
          throw new Error(current.message ?? 'Line confirmation failed');

        return current.state === 'completed' ? current : null;
      },
      'explicit source mapping applied',
      30000,
    );
  const link = async (kind, entityId, otherId) => {
    const request = await api('/identities/links', {
      method: 'POST',
      status: 202,
      body: {
        operation: 'link',
        kind,
        entityId,
        otherId,
        reason:
          'Merchant confirmed these exact source records represent the same order line.',
      },
    });
    await complete(request);
    await f.pilot.observe({ check: false });

    return request;
  };
  const setAuthority = async () => {
    const authority = await api('/source-authority');
    await api('/source-authority', {
      method: 'POST',
      body: {
        commandId: randomUUID(),
        revision: authority.revision,
        group: 'order_lines',
        connectionId: f.manifest.connections.shopify,
      },
    });
  };

  return {
    ...f,
    tenantId,
    base,
    api,
    cookies,
    shop,
    shipping,
    complete,
    link,
    setAuthority,
    detail: () => api(`/orders/${shop}`),
    async setShopQuantity(quantity) {
      const line = (
        await f.db.owner.query(
          "SELECT external_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource='order_line' AND canonical_id=$3",
          [
            tenantId,
            f.manifest.connections.shopify,
            (await api(`/orders/${shop}`)).sources.find(
              (source) =>
                source.connectionId === f.manifest.connections.shopify,
            ).lines[0].id,
          ],
        )
      ).rows[0].external_id;
      await f.call('runs/operations/control', {
        action: 'command',
        instance: 'shopify',
        command: {
          kind: 'order-edit',
          order: '1',
          lines: [{ lineItem: line.split('/').at(-1), quantity }],
        },
      });
      await f.pilot.observe({ check: false });
    },
  };
}
