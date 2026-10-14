import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { until } from './helpers.mjs';
import { setupSimulator } from './simulator-fixture.mjs';

export const mailboxAddress = 'einkauf@luma-goods.example';

/**
 * A simulator workspace whose demo setup added the inbox rules: the demo supplier's order
 * address linked to its Procurement supplier and catch-alls for supplier and customer mail.
 * The pilot operator (admin) works the inbox; the workspace owner is the second admin.
 */
export async function inboxFixture(t, origin = 'http://127.0.0.1:3000') {
  const f = await setupSimulator(t, { origin, demo: { workflows: true } });
  const org = f.manifest.organizationId;
  const base = `/v1/organizations/${org}`;
  const mailboxId = f.manifest.connections.gmail;
  assert.ok(mailboxId, 'The pilot connects the simulated Gmail mailbox');
  const session = (response) =>
    []
      .concat(response.headers['set-cookie'])
      .filter(Boolean)
      .map((value) => value.split(';')[0])
      .join('; ');
  const login = async (email) => {
    const response = await f.pilot.app.inject({
      method: 'POST',
      url: '/auth/sign-in/email',
      headers: { origin },
      payload: { email, password: f.password },
    });
    assert.equal(response.statusCode, 200, response.body);

    return session(response);
  };
  const operator = await login('pilot-operator@example.test');
  const owner = await login('pilot-requester@example.test');
  /** Calls the pilot API; asserts the status and returns the JSON body. */
  const request = async (
    path,
    body,
    { cookie = operator, status = 200, method } = {},
  ) => {
    const response = await f.pilot.app.inject({
      method: method ?? (body ? 'POST' : 'GET'),
      url: path.startsWith('/v1/') ? path : `${base}${path}`,
      headers: { cookie, origin },
      ...(body ? { payload: body } : {}),
    });
    assert.equal(
      response.statusCode,
      status,
      `${method ?? (body ? 'POST' : 'GET')} ${path}: ${response.body}`,
    );

    return response.body ? response.json() : null;
  };
  const messaging = (path, body, options) =>
    request(`/messaging${path}`, body, options);
  /** Signs up a person and adds them to the workspace with a role. */
  const join = async (name, roleId) => {
    const response = await f.pilot.app.inject({
      method: 'POST',
      url: '/auth/sign-up/email',
      headers: { origin },
      payload: {
        name,
        email: `${name.toLowerCase()}@example.test`,
        dataRegion: globalThis.process.env.LUMA_REGION ?? 'AU',
        password: 'inbox-e2e-password-123',
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const person = { id: response.json().user.id, cookie: session(response) };
    if (roleId)
      await request(
        '/members',
        { userId: person.id, roleId },
        { cookie: owner, status: 201 },
      );

    return person;
  };

  await f.pilot.observe({ check: false });
  await f.pilot.link();
  // The merchant confirms the two seeded integration pairs before Inbox reads references.
  // Separate shipping records must otherwise remain ambiguous, even with the same number.
  for (const [shopOrder, shippingOrder] of [
    ['1', '1'],
    ['10', '2'],
  ]) {
    const mapped = async (connectionId, externalId) =>
      (
        await f.db.owner.query(
          "SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource='order' AND external_id=$3",
          [org, connectionId, externalId],
        )
      ).rows[0]?.canonical_id;
    const entityId = await mapped(
      f.manifest.connections.shopify,
      `gid://shopify/Order/${shopOrder}`,
    );
    const otherId = await mapped(
      f.manifest.connections.starshipit,
      shippingOrder,
    );
    assert.ok(
      entityId && otherId,
      'The merchant can identify both exact seeded source orders',
    );
    const link = await request(
      '/identities/links',
      {
        operation: 'link',
        kind: 'order',
        entityId,
        otherId,
        reason:
          'Merchant confirmed these exact seeded Shopify and Starshipit source orders from the integration.',
      },
      { status: 202 },
    );
    await until(
      async () => {
        await f.pilot.observe({ refresh: false, check: false });
        const current = await request(`/identities/links/${link.id}`);
        assert.notEqual(current.state, 'failed', current.message);

        return current.state === 'completed';
      },
      'merchant-confirmed order identity',
      30_000,
    );
  }
  // The demo adds inbox rules once its supplier exists in Procurement.
  await until(
    async () => {
      await f.pilot.demo();
      const { items } = await messaging('/mailboxes');

      return items[0]?.rules.length === 3;
    },
    'demo inbox rules',
    30_000,
  );

  /** Asks for a read now, as **Read now** does, and runs mailbox and document passes. */
  const readMail = async () => {
    await messaging(`/mailboxes/${mailboxId}/sync`, {});
    await f.pilot.messaging.sync({ passes: 5 });
  };
  /** Reads the mailbox until the check passes. */
  const readUntil = (check, description) =>
    until(
      async () => {
        await readMail();

        return check();
      },
      description,
      30_000,
    );
  const threads = async (query = 'view=all') => messaging(`/threads?${query}`);
  const thread = (id, options) =>
    messaging(`/threads/${id}`, undefined, options);
  /** Every message stored in the simulated mailbox. */
  const mailbox = async () => {
    const items = [];
    let after;
    do {
      const page = await f.call(
        `runs/operations/records/gmail?kind=message&limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`,
      );
      items.push(...page.items.map((item) => item.data));
      after = page.next;
    } while (after);

    return items;
  };
  /** Delivers mail into the simulated mailbox as an outside sender. */
  const deliver = (command) =>
    f.call('runs/operations/control', {
      action: 'command',
      instance: 'gmail',
      command: { kind: 'deliver', ...command },
    });
  const scenario = async (name) =>
    (
      await f.call('runs/operations/scenarios', {
        id: randomUUID(),
        scenario: name,
      })
    )[0];

  return {
    ...f,
    origin,
    org,
    base,
    mailboxId,
    operator,
    owner,
    request,
    messaging,
    join,
    readMail,
    readUntil,
    threads,
    thread,
    mailbox,
    deliver,
    scenario,
  };
}

/**
 * Starts the supplier split-delivery scenario for a purchase order Luma also tracks in
 * Procurement under the same reference, and reads the mailbox until the answer arrives.
 */
export async function splitDelivery(f) {
  const incident = await f.scenario('supplier-split-delivery-mail');
  const reference = incident.resources.find(
    (item) => item.kind === 'PurchaseOrder',
  ).label;
  const { items } = await f.messaging('/mailboxes');
  const supplierRule = items[0].rules.find(
    (rule) => rule.party.kind === 'supplier',
  );
  const sku = (
    await f.db.owner.query(
      `SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2
       AND resource='sku' AND external_id='1'`,
      [f.org, f.manifest.connections.jtl],
    )
  ).rows[0].canonical_id;
  const lineId = randomUUID();
  const order = await f.request('/procurement/purchase-orders', {
    id: randomUUID(),
    supplierId: supplierRule.party.supplierId,
    reference,
    lines: [
      {
        id: lineId,
        sku,
        description: 'Canvas tote',
        quantity: 100,
        unit: 'each',
      },
    ],
  });
  let found;
  await f.readUntil(async () => {
    found = (await f.threads()).items.find(
      (item) =>
        item.subject.includes(reference) &&
        item.links.some((link) => link.kind === 'purchase_order'),
    );

    return found?.messageCount === 2;
  }, 'the split-delivery thread');

  return {
    incident,
    reference,
    order,
    lineId,
    supplierRule,
    summary: found,
  };
}
