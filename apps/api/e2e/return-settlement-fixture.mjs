import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { setupSimulator } from './simulator-fixture.mjs';

/** Creates a reviewed Shopify/Wawi return with two received units and one approved resale unit. */
export async function settlementFixture(
  t,
  {
    origin = 'http://127.0.0.1:3000',
    resolution = 'refund',
    prepare = 'proposed',
    resellable = 1,
    fulfillment = 'manual',
    environment,
  } = {},
) {
  const f = environment ?? (await setupSimulator(t, { origin }));
  const org = f.manifest.organizationId,
    connectionId = f.manifest.connections.shopify;
  const root = `/v1/organizations/${org}`;

  async function login(email) {
    const response = await f.pilot.app.inject({
      method: 'POST',
      url: '/auth/sign-in/email',
      headers: { origin },
      payload: { email, password: f.password },
    });
    assert.equal(response.statusCode, 200, response.body);

    return []
      .concat(response.headers['set-cookie'])
      .map((v) => v.split(';')[0])
      .join('; ');
  }

  const requester = await login('pilot-operator@example.test'),
    approver = await login('pilot-requester@example.test');

  async function request(path, body, cookie = requester, status = 200) {
    const response = await f.pilot.app.inject({
      method: body ? 'POST' : 'GET',
      url: `${root}${path}`,
      headers: { cookie, origin },
      ...(body ? { payload: body } : {}),
    });
    assert.equal(response.statusCode, status, response.body);

    return response.json();
  }

  const command = (command) =>
    f.call('runs/operations/control', {
      action: 'command',
      instance: 'shopify',
      command,
    });
  const variants = (
    await f.call(
      'runs/operations/records/shopify?kind=ProductVariant&limit=100',
    )
  ).items;
  const selected =
    variants.find(
      (v) =>
        `gid://shopify/InventoryItem/${v.id}` ===
        f.manifest.simulator.inventory.inventoryItem,
    ) ?? variants[0];
  const old = new Set(
    (
      await f.call('runs/operations/records/shopify?kind=Order&limit=100')
    ).items.map((o) => o.id),
  );
  await f.call('runs/operations/control', {
    action: 'order',
    shop: 'shopify',
    lines: [{ sku: selected.data.sku, quantity: 2 }],
  });
  const providerOrderId = (
    await f.call('runs/operations/records/shopify?kind=Order&limit=100')
  ).items.find((o) => !old.has(o.id)).id;
  if (fulfillment === 'pipeline') {
    await f.call('runs/operations/control', {
      action: 'advance',
      milliseconds: 10_000,
    });
    const shopOrder = (
      await f.call('runs/operations/records/shopify?kind=Order&limit=100')
    ).items.find((o) => o.id === providerOrderId);
    const erp = (
      await f.call('runs/operations/records/jtl?kind=sales-order&limit=100')
    ).items.find(
      (o) => o.data.externalNumber === shopOrder.data.name.replace(/^#/, ''),
    );
    assert.ok(
      erp,
      'The real order integration must import the Shopify order into Wawi',
    );
    await f.call('runs/operations/control', {
      action: 'command',
      instance: 'jtl',
      command: {
        kind: 'ship',
        id: erp.id,
        warehouse: erp.data.warehouse,
        trackingNumber: 'completion-original',
        trackingUrl: 'https://example.test/tracking',
      },
    });
    await command({
      kind: 'fulfill',
      order: providerOrderId,
      carrier: 'DHL',
      trackingNumber: 'completion-original',
      trackingUrl: 'https://example.test/tracking',
    });
  } else
    await command({
      kind: 'fulfill',
      order: providerOrderId,
      carrier: 'DHL',
      trackingNumber: 'settlement-test',
      trackingUrl: 'https://example.test/tracking',
    });
  await f.pilot.observe({ check: false });
  await f.pilot.link();
  const skuSources = (
    await f.db.owner.query(
      "SELECT connection_id,canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND resource='sku' AND ((connection_id=$2 AND external_id=$3) OR (connection_id=$4 AND external_id=$5))",
      [
        org,
        connectionId,
        `gid://shopify/InventoryItem/${selected.id}`,
        f.manifest.connections.jtl,
        f.manifest.simulator.inventory.erpItem,
      ],
    )
  ).rows;
  const shopSku = skuSources.find(
    (s) => s.connection_id === connectionId,
  ).canonical_id;
  const wawiSku = skuSources.find(
    (s) => s.connection_id === f.manifest.connections.jtl,
  ).canonical_id;
  if (shopSku !== wawiSku) {
    const linked = await request(
      '/identities/links',
      {
        operation: 'link',
        kind: 'sku',
        entityId: wawiSku,
        otherId: shopSku,
        reason:
          'Reviewed synthetic Shopify inventory item and Wawi item for the settlement journey',
      },
      requester,
      202,
    );
    await f.pilot.observe({ check: false });
    assert.equal(
      (await request(`/identities/links/${linked.id}`)).state,
      'completed',
    );
  }
  const mapped = await f.db.owner.query(
    "SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource='order' AND external_id=$3",
    [org, connectionId, `gid://shopify/Order/${providerOrderId}`],
  );
  const orderId = mapped.rows[0].canonical_id;
  const available = await request(`/orders/${orderId}/return-cases`),
    line = available.sources.find((s) => s.connectionId === connectionId)
      .lines[0];
  let detail = await request(`/orders/${orderId}/return-cases`, {
    id: randomUUID(),
    connectionId,
    sourceReturnId: null,
    lines: [
      {
        orderLineId: line.orderLineId,
        quantity: 2,
        reason: 'damaged',
        note: null,
      },
    ],
  });
  const path = `/return-cases/${detail.case.id}`,
    lines = detail.lines;
  const evidence = {
    note:
      resellable === 2
        ? 'Warehouse counted and inspected two resale units'
        : 'Warehouse counted two units; one damaged',
    link: null,
  };
  if (prepare === 'opened')
    return {
      ...f,
      org,
      connectionId,
      root,
      requester,
      approver,
      request,
      command,
      providerOrderId,
      detail,
      path,
      lines,
      evidence,
    };
  detail = await request(`${path}/receipt`, {
    commandId: randomUUID(),
    expectedRevision: detail.case.revision,
    lines: lines.map((l) => ({ orderLineId: l.orderLineId, received: 2 })),
    evidence,
  });
  detail = await request(`${path}/inspection`, {
    commandId: randomUUID(),
    expectedRevision: detail.case.revision,
    lines: lines.map((l) => ({
      orderLineId: l.orderLineId,
      resellable,
      damaged: 2 - resellable,
    })),
    evidence,
  });
  if (resellable < 2)
    await request(
      `${path}/proposal`,
      {
        commandId: randomUUID(),
        expectedRevision: detail.case.revision,
        kind: 'refund',
        lines: lines.map((l) => ({ orderLineId: l.orderLineId, restock: 2 })),
        evidence,
      },
      requester,
      409,
    );
  detail = await request(`${path}/proposal`, {
    commandId: randomUUID(),
    expectedRevision: detail.case.revision,
    kind: resolution,
    lines: lines.map((l) => ({
      orderLineId: l.orderLineId,
      restock: resellable,
    })),
    evidence,
  });

  return {
    ...f,
    org,
    connectionId,
    root,
    requester,
    approver,
    request,
    command,
    providerOrderId,
    detail,
    path,
    lines,
    evidence,
  };
}

/**
 * Every provider read that a return case's verifications, audit entries, stored quotes and
 * proofs, exchange checks and deadline waits cite, with the stored orders evidence each ID
 * resolves to. References to the case, its revisions and canonical records such as the store
 * return it works name Luma's own records and are left out.
 */
export async function citedReturnReads(f, caseId) {
  const org = f.manifest.organizationId;
  const refs = await f.db.owner.query(
    `WITH proposals AS (
       SELECT (document->>'actionId')::uuid AS id FROM orders_return_creations WHERE tenant_id=$1 AND case_id=$2
       UNION SELECT (document->>'actionId')::uuid FROM orders_return_actions WHERE tenant_id=$1 AND case_id=$2
       UNION SELECT (document->>'actionId')::uuid FROM orders_return_exchange_steps WHERE tenant_id=$1 AND case_id=$2
     ), waits AS (
       SELECT id::text AS id,document FROM orders_return_waits WHERE tenant_id=$1 AND case_id=$2
     ), cited AS (
       SELECT jsonb_array_elements_text(document->'attempt'->'verification'->'observationRefs') AS id
         FROM executed_actions WHERE tenant_id=$1 AND proposal_id IN (SELECT id FROM proposals)
       UNION SELECT jsonb_array_elements_text(document->'result'->'observationRefs')
         FROM execution_verifications WHERE tenant_id=$1 AND proposal_id IN (SELECT id FROM proposals)
       UNION SELECT jsonb_array_elements_text(document->'evidenceRefs') FROM audit_entries
         WHERE tenant_id=$1 AND document->>'eventType' LIKE 'return%'
           AND (document->>'correlationId'=$2::text OR document->>'correlationId' IN (SELECT id FROM waits))
       UNION SELECT jsonb_array_elements_text(document->'evidenceRefs') FROM waits
       UNION SELECT jsonb_array_elements_text(document->'quote'->'evidenceRefs') FROM orders_return_actions WHERE tenant_id=$1 AND case_id=$2
       UNION SELECT jsonb_array_elements_text(document->'proof'->'evidenceRefs') FROM orders_return_actions WHERE tenant_id=$1 AND case_id=$2
       UNION SELECT jsonb_array_elements_text(document->'quote'->'evidenceRefs') FROM orders_return_exchange_steps WHERE tenant_id=$1 AND case_id=$2
       UNION SELECT jsonb_array_elements_text(document->'proof'->'evidenceRefs') FROM orders_return_exchange_steps WHERE tenant_id=$1 AND case_id=$2
       UNION SELECT jsonb_array_elements_text(document->'availability'->'evidenceRefs') FROM orders_return_exchanges WHERE tenant_id=$1 AND case_id=$2
       UNION SELECT jsonb_array_elements_text(document->'completion'->'evidenceRefs') FROM orders_return_exchanges WHERE tenant_id=$1 AND case_id=$2
     )
     SELECT id FROM cited WHERE id<>$2::text AND id NOT LIKE 'case:%'
       AND NOT EXISTS (SELECT 1 FROM orders_entities e WHERE e.tenant_id=$1 AND e.id::text=cited.id)
     ORDER BY id`,
    [org, caseId],
  );
  const cited = refs.rows.map((row) => row.id);
  const stored = await f.db.owner.query(
    'SELECT id,case_id,purpose,subject_id,document FROM orders_return_read_evidence WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',
    [org, cited],
  );

  return { cited, stored: stored.rows };
}
