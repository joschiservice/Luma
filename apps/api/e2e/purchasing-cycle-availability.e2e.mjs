import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { purchasingCycleFixture } from './purchasing-cycle-fixture.mjs';

for (const channel of ['jtl', 'email'])
  it(`observes availability through receipt and a deferred recommendation stockout through ${channel}`, async (t) => {
    const f = await purchasingCycleFixture(t, channel, {
      imported: true,
      positiveStock: true,
      ignoreAlternative: true,
    });
    const date = new Date(Date.now() + 3 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    let externalOrder;
    if (channel === 'jtl') {
      const requested = await f.api(
        `/procurement/purchase-orders/${f.orderId}/submissions`,
        { id: randomUUID(), requestedDeliveryDate: date },
      );
      const submitted = await f.api(
        `/procurement/submissions/${requested.id}/decision`,
        { decisionId: requested.decisionId, outcome: 'approved' },
        { cookie: f.approver() },
      );
      expect(submitted.state).toBe('submitted');
      externalOrder = submitted.externalOrder.externalId;
    } else {
      await f.api('/messaging/mailboxes');
      const draft = await f.api(
        `/procurement/purchase-orders/${f.orderId}/email/submission`,
        {
          id: randomUUID(),
          connectionId: f.f.manifest.connections.gmail,
          requestedDeliveryDate: date,
          company: {
            name: 'Cycle Commerce GmbH',
            address: 'Hauptstraße 1\n10115 Berlin',
            registration: 'Reviewed company identity',
          },
        },
      );
      const requested = await f.api(`/messaging/outbound/${draft.id}/request`, {
        id: randomUUID(),
      });
      const sent = await f.api(
        `/messaging/outbound/${draft.id}/decision`,
        { decisionId: requested.decisionId, outcome: 'approved' },
        { cookie: f.approver() },
      );
      expect(sent.state).toBe('sent');
    }
    await f.f.pilot.observe({ check: false });
    if (channel === 'jtl') {
      // An actual warehouse adjustment provides a fresh, positive stock observation before receipt.
      await f.command('jtl', {
        kind: 'stock',
        itemId: '1',
        warehouse: '1',
        quantity: 24,
      });
      await f.f.pilot.observe({ check: false });
    }
    const before = await f.api('/procurement/purchasing/outcomes');
    expect(before.items.find((item) => item.orderId === f.orderId).state).toBe(
      'unknown',
    );
    let receipt;
    if (channel === 'jtl') {
      await f.command('jtl', {
        kind: 'purchase-order-receive',
        orderId: externalOrder,
        lines: [
          {
            lineItemId: String(Number(externalOrder) * 1000 + 1),
            quantity: 20,
          },
        ],
      });
      await f.api(`/procurement/purchase-orders/${f.orderId}/refresh`, {});
      receipt = (await f.record()).commitments.find(
        (commitment) => commitment.kind === 'received',
      );
      expect(receipt.source.kind).toBe('purchasing_system');
    } else {
      receipt = await f.api(
        `/procurement/purchase-orders/${f.orderId}/receipts`,
        {
          id: randomUUID(),
          lineId: f.lineId,
          kind: 'received',
          quantity: 20,
          damagedQuantity: 0,
          expectedCommitmentId: null,
          expectedDamagedCommitmentId: null,
          receivedAt: new Date().toISOString(),
          condition: 'good',
          reason: 'Signed receipt for twenty sellable units',
          evidence: ['delivery-note:good-20'],
        },
      );
      const preview = await f.api(
        '/apps/shopify/inventory-correction-receipt-preview',
        {
          requestId: randomUUID(),
          purchaseOrderId: f.orderId,
          lineId: f.lineId,
        },
      );
      expect(preview.before.source.available - preview.before.available).toBe(
        20,
      );
      await f.api(
        '/apps/shopify/inventory-correction-approve',
        { id: preview.id, outcome: 'approved' },
        { cookie: f.approver() },
      );
      expect(
        (
          await f.api('/apps/shopify/inventory-correction-execute', {
            id: preview.id,
          })
        ).state,
      ).toBe('verified');
    }
    await f.f.pilot.observe({ check: false });
    const throughReceipt = await f.api('/procurement/purchasing/outcomes');
    const outcome = throughReceipt.items.find(
      (item) => item.orderId === f.orderId,
    );
    expect(
      outcome,
      JSON.stringify({
        outcome,
        receipt,
        stocks: (
          await f.f.db.owner.query(
            "SELECT connection_id,observed_at,document->'data'->>'available' AS available FROM inventory_snapshots WHERE tenant_id=$1 AND sku_id=$2 AND kind='position' AND observed_at >= $3::timestamptz ORDER BY observed_at",
            [f.org, f.skuId, outcome.decidedAt],
          )
        ).rows,
      }),
    ).toMatchObject({
      state: 'available_through_receipt',
      complete: true,
    });
    if (channel === 'jtl') expect(outcome.evidenceRefs).toContain(receipt.id);
    else expect(outcome.evidenceRefs.length).toBeGreaterThanOrEqual(2);
    expect(throughReceipt.summary.verifiedAvailable).toBe(1);
    // The declined alternative remains a separate human decision; zero stock is provider evidence.
    await f.command(
      channel === 'jtl' ? 'jtl' : 'shopify',
      channel === 'jtl'
        ? { kind: 'stock', itemId: '1', warehouse: '1', quantity: 0 }
        : { kind: 'available', variant: '1', location: '1', quantity: 0 },
    );
    await f.f.pilot.observe({ check: false });
    const after = await f.api('/procurement/purchasing/outcomes');
    const ignored = after.items.find(
      (item) =>
        item.decision === 'ignored' && item.supplierId === f.alternative.id,
    );
    expect(ignored).toMatchObject({
      state: 'stockout_observed',
      complete: true,
    });
    expect(ignored.evidenceRefs.length).toBeGreaterThan(0);
    expect(ignored.stockoutAt).toBeTruthy();
  }, 120_000);
