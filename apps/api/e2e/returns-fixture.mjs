import { randomUUID } from 'node:crypto';

import { createCommerceServices } from '@luma/application-runtime';
import { builtInMembership, makeTenantContext } from '@luma/identity';

const eur = (amount) => ({ amount, currency: 'EUR' });

const each = (amount) => ({ amount, unit: 'each' });

/**
 * Imports Shopify orders, returns and refunds through the history-import path, as the sync
 * runner does. The store shares returns; the JTL connection does not.
 *
 * - #1001-R1 is requested and not reviewed yet.
 * - #1002-R1 is received; its first refund payment failed and a second one is pending.
 * - #1002 also has a goodwill refund without a return.
 * - #1003-R1 is closed and fully refunded.
 */
export async function returnsFixture(t, f) {
  const context = makeTenantContext(
    { userId: f.owner.id, sessionId: 'fixture' },
    {
      ...f.org,
      status: 'active',
      dataRegion: globalThis.process.env.LUMA_REGION ?? 'AU',
    },
    builtInMembership(
      { id: randomUUID(), organizationId: f.org.id, userId: f.owner.id },
      'owner',
    ),
    randomUUID(),
  );
  const store = randomUUID();
  const erp = randomUUID();
  for (const [id, provider, label, reads] of [
    [store, 'shopify', 'Tokyo store', ['orders.read', 'returns.read']],
    [erp, 'jtl', 'JTL-Wawi', ['orders.read']],
  ]) {
    await f.db.owner.query(
      "INSERT INTO workspace_apps(tenant_id,app_id,status,version) VALUES($1,$2,'installed',1) ON CONFLICT DO NOTHING",
      [f.org.id, provider],
    );
    await f.db.owner.query(
      'INSERT INTO connector_installations(tenant_id,id,version,document,secret) VALUES($1,$2,1,$3,$4)',
      [
        f.org.id,
        id,
        {
          id,
          tenantId: f.org.id,
          version: 1,
          status: 'active',
          appId: provider,
          appInstallationVersion: 1,
          provider,
          target: { kind: provider },
          label,
          permissions: reads,
          granted: reads,
        },
        'fixture',
      ],
    );
  }
  const commerce = createCommerceServices(f.db.ownerUrl);
  t.onTestFinished(() => commerce.close());

  /** Imports one observation as a sync page would, returning the canonical ID. */
  async function importRecord(capability, resource, externalId, data, time) {
    const id = randomUUID();
    const outcome = await commerce.ingestion.import(context, `sync:${id}`, {
      capability,
      observation: {
        id,
        source: {
          tenantId: f.org.id,
          connectionId: store,
          provider: 'shopify',
          resource,
          externalId,
          scopeKey: '',
        },
        kind: 'snapshot',
        observedAt: time ?? new Date().toISOString(),
        sourceUpdatedAt: resource === 'return' ? null : (time ?? null),
        sourceRevision: null,
        adapterVersion: 'shopify/2',
        schemaVersion: 1,
        data,
      },
    });
    if (outcome.status === 'pending')
      throw new Error(`Import is pending: ${JSON.stringify(outcome.missing)}`);

    return outcome.entityId;
  }

  const orderRef = (n) => ({
    externalId: `gid://shopify/Order/${n}`,
    scopeKey: '',
  });
  const lineRef = (n) => ({
    externalId: `gid://shopify/LineItem/${n}`,
    scopeKey: `gid://shopify/Order/${n}`,
  });

  const orders = {};
  for (const n of [1001, 1002, 1003])
    orders[n] = await importRecord(
      'orders.read',
      'order',
      `gid://shopify/Order/${n}`,
      {
        displayNumber: `#${n}`,
        placedAt: '2026-09-10T08:00:00Z',
        total: eur('48.00'),
        status: 'completed',
        paymentStatus: n === 1003 ? 'refunded' : 'paid',
        lines: [
          {
            id: lineRef(n),
            sku: null,
            quantity: each('2'),
            cancelledQuantity: null,
            skuCode: 'TOTE-RED',
            title: 'Canvas tote',
          },
        ],
      },
      '2026-09-12T08:00:00Z',
    );

  /** Imports a return snapshot of an order's only line. */
  const returnRecord = (n, patch, line = {}, time) =>
    importRecord(
      'returns.read',
      'return',
      `gid://shopify/Return/${n}`,
      {
        type: 'return',
        order: orderRef(n),
        name: `#${n}-R1`,
        status: 'open',
        requestedAt: '2026-09-20T09:00:00Z',
        approvedAt: '2026-09-20T12:00:00Z',
        closedAt: null,
        declineReason: null,
        receivedAt: null,
        ...patch,
        lines: [
          {
            orderLine: lineRef(n),
            quantity: each('2'),
            reason: n === 1002 ? 'Defective' : 'Size too small',
            receivedQuantity: '0',
            restockedQuantity: '0',
            refundedQuantity: '0',
            value: eur('48.00'),
            ...line,
          },
        ],
      },
      time,
    );

  /** Imports a refund with the given payment attempts. */
  const refund = (id, n, returned, transactions, time) =>
    importRecord(
      'returns.read',
      'refund',
      `gid://shopify/Refund/${id}`,
      {
        type: 'refund',
        order: orderRef(n),
        return: returned
          ? { externalId: `gid://shopify/Return/${n}`, scopeKey: '' }
          : null,
        createdAt: time,
        total:
          transactions.find((p) => p.status === 'success')?.amount ??
          eur(
            transactions.some((p) => p.status === 'success') ? '48.00' : '0.00',
          ),
        lines: returned
          ? [
              {
                orderLine: lineRef(n),
                quantity: each('2'),
                restock: 'return',
                restocked: true,
              },
            ]
          : [],
        transactions: transactions.map((payment) => ({
          amount: eur('48.00'),
          processedAt: payment.status === 'pending' ? null : time,
          gateway: 'shopify_payments',
          ...payment,
        })),
      },
      time,
    );

  const requested = await returnRecord(1001, {
    status: 'requested',
    approvedAt: null,
    requestedAt: '2026-09-25T09:00:00Z',
  });
  const received = await returnRecord(
    1002,
    { receivedAt: '2026-09-23T10:00:00Z' },
    { receivedQuantity: '2', restockedQuantity: '2', refundedQuantity: '2' },
  );
  const failedRefund = await refund(
    '2001',
    1002,
    true,
    [{ status: 'failed' }],
    '2026-09-24T09:00:00Z',
  );
  const pendingRefund = await refund(
    '2002',
    1002,
    true,
    [{ status: 'pending' }],
    '2026-09-25T09:00:00Z',
  );
  const goodwill = await refund(
    '2003',
    1002,
    false,
    [{ status: 'success', amount: eur('5.00') }],
    '2026-09-26T09:00:00Z',
  );
  const closed = await returnRecord(
    1003,
    {
      status: 'closed',
      requestedAt: '2026-09-15T09:00:00Z',
      receivedAt: '2026-09-17T10:00:00Z',
      closedAt: '2026-09-19T10:00:00Z',
    },
    { receivedQuantity: '2', restockedQuantity: '1', refundedQuantity: '2' },
  );
  await refund(
    '3001',
    1003,
    true,
    [{ status: 'success' }],
    '2026-09-18T09:00:00Z',
  );

  return {
    context,
    commerce,
    store,
    erp,
    orders,
    returns: { requested, received, closed },
    refunds: { failedRefund, pendingRefund, goodwill },
    returnRecord,
    refund,
  };
}
