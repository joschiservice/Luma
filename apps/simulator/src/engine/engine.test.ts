import { randomUUID } from 'node:crypto';

import {
  type Cin7Context,
  guid,
  simulatedAccountId,
} from '@luma/simulator-cin7';
import {
  localTime,
  merchantProfile,
  type MerchantProfileName,
} from '@luma/simulator-commerce';
import { chaosPreset, type ChaosPresetName } from '@luma/simulator-core';
import { gmail, type MessageRecord } from '@luma/simulator-gmail';
import {
  kinds as erpKinds,
  type NoteRecord,
  type OrderRecord,
  type PurchaseOrderRecord,
  readItemStock,
  readOrder as readErpOrder,
} from '@luma/simulator-jtl';
import { readOrder, readStock } from '@luma/simulator-shopify';
import { describe, expect, it } from 'vitest';

import { buildWorld } from '../runtime/provision.js';
import type { RunRecord } from '../runtime/runs.js';
import { advanceWorld } from './advance.js';
import { cin7 } from './cin7.js';
import { injectIncident, recoverIncident } from './incidents.js';
import { forgetModel } from './model.js';
import { importOrder, placeOrder } from './orders.js';
import {
  erp,
  erpContext,
  type Incident,
  mailContext,
  shopContext,
  type World,
} from './world.js';

const start = Date.parse('2026-10-05T06:00:00Z');
const hour = 3_600_000;

function testRun(
  profile: MerchantProfileName,
  chaos: ChaosPresetName = 'calm',
  seed = 44,
): RunRecord {
  const id = `engine-${randomUUID().slice(0, 8)}`;
  forgetModel(id);

  return {
    id,
    seed,
    profileName: profile,
    profile: merchantProfile(profile),
    chaos: chaosPreset(chaos),
    status: 'provisioning',
    progress: null,
    error: null,
    now: start,
    running: false,
    speed: 1,
    wallAt: start,
    health: {},
    state: { pickCarry: {}, nextStockSync: start, startedAt: start },
    createdAt: start,
  };
}

async function summary(
  stores: Awaited<ReturnType<typeof buildWorld>>['stores'],
) {
  const count = (instance: string, kind: string) =>
    stores.get(instance)?.count({ kind }) ?? 0;

  return {
    orders: await count('world', 'order'),
    erpOrders: await count('jtl', 'sales-order'),
    deliveryNotes: await count('jtl', 'delivery-note'),
    fulfillments: await count('shopify', 'Fulfillment'),
    returns: await count('shopify', 'Return'),
  };
}

describe('merchant world', () => {
  it('creates the fixed test orders in both systems with the same IDs', async () => {
    const { world } = await buildWorld(testRun('test'));
    for (const id of ['1', '10']) {
      expect(await readOrder(shopContext(world, 'shopify'), id)).toMatchObject({
        name: `#SIM-${id}`,
        lines: [expect.objectContaining({ quantity: 2 })],
      });
      expect(await readErpOrder(erpContext(world), id)).toMatchObject({
        externalNumber: `SIM-${id}`,
        shippingMethodId: '7',
      });
    }
    expect(await readItemStock(erpContext(world), '1')).toMatchObject({
      total: 100,
      reserved: 4,
    });
  });

  it('simulates days of orders, shipments and returns, the same way for the same seed', async () => {
    const first = await buildWorld(testRun('small'));
    expect(
      [...first.sinks.metrics.values()].filter(
        (metric) => metric.name === 'engine.errors',
      ),
    ).toEqual([]);
    const counts = await summary(first.stores);
    expect(counts.orders).toBeGreaterThan(400);
    expect(counts.erpOrders).toBeGreaterThan(counts.orders * 0.9);
    expect(counts.deliveryNotes).toBeGreaterThan(counts.orders * 0.5);
    expect(counts.fulfillments).toBeGreaterThan(counts.orders * 0.5);
    expect(counts.returns).toBeGreaterThan(0);
    expect(await summary((await buildWorld(testRun('small'))).stores)).toEqual(
      counts,
    );
    expect(
      await summary((await buildWorld(testRun('small', 'calm', 45))).stores),
    ).not.toEqual(counts);
  }, 120_000);

  it('keeps shop availability equal to the ERP while the stock sync works', async () => {
    const { world } = await buildWorld(testRun('small'));
    world.live = true;
    await advanceWorld(world, world.now + hour);
    let compared = 0;
    for (const variant of world.model.catalog.variants.slice(0, 40)) {
      const erp = await readItemStock(erpContext(world), variant.id);
      const shop = await readStock(
        shopContext(world, 'shopify'),
        variant.id,
        '1',
      );
      if (!erp || !shop) continue;
      // Orders placed since the last push are committed in the shop but not yet reserved in the ERP.
      expect(
        Math.abs(shop.available - Math.max(0, erp.available)),
      ).toBeLessThanOrEqual(5);
      compared++;
    }
    expect(compared).toBeGreaterThan(30);
  }, 120_000);

  it('injects and recovers stock drift, outages and order incidents as ground truth', async () => {
    const { world } = await buildWorld(testRun('test'));
    world.live = true;
    const drift = await injectIncident(world, {
      id: randomUUID(),
      kind: 'inventory-drift',
      target: 'LUMA-SCENARIO-001',
    });
    expect(drift).toMatchObject({
      status: 'active',
      origin: 'injected',
      instance: 'shopify',
    });
    const erp = await readItemStock(erpContext(world), '2');
    expect(
      (await readStock(shopContext(world, 'shopify'), '2', '1'))?.available,
    ).not.toBe(erp?.available);
    expect(
      await injectIncident(world, { id: drift.id, kind: 'inventory-drift' }),
    ).toEqual(drift);
    await recoverIncident(world, drift.id);
    expect(
      (await readStock(shopContext(world, 'shopify'), '2', '1'))?.available,
    ).toBe(erp?.available);

    const outage = await injectIncident(world, {
      id: randomUUID(),
      kind: 'provider-outage',
      instance: 'jtl',
    });
    expect(world.run.health.jtl).toMatchObject({
      status: 'unavailable',
      incident: outage.id,
    });
    await advanceWorld(world, world.now + 31 * 60_000);
    expect(world.run.health.jtl).toBeUndefined();
    const closed = await world
      .store('world')
      .get<Incident>('incident', outage.id);
    expect(closed?.data.status).toBe('recovered');

    const stall = await injectIncident(world, {
      id: randomUUID(),
      kind: 'warehouse-stall',
    });
    expect(stall.status).toBe('planned');
    await advanceWorld(world, world.now + 10 * 60_000);
    const started = await world
      .store('world')
      .get<Incident>('incident', stall.id);
    expect(started?.data).toMatchObject({ status: 'active' });
    expect(started?.data.resources.map((resource) => resource.kind)).toContain(
      'salesOrder',
    );
  }, 60_000);

  it('produces emerged incidents at the chaos profile’s rates', async () => {
    const run = testRun('small', 'realistic');
    for (const kind of Object.keys(run.chaos.incidents))
      run.chaos.incidents[kind] = 50;
    const { world } = await buildWorld(run);
    world.live = true;
    await advanceWorld(world, world.now + 6 * hour);
    const incidents = await world
      .store('world')
      .page<Incident>({ kind: 'incident', limit: 500 });
    expect(
      new Set(incidents.items.map((item) => item.data.kind)).size,
    ).toBeGreaterThan(3);
    expect(
      incidents.items.every((item) => item.data.origin === 'emerged'),
    ).toBe(true);
  }, 120_000);

  it('places manual orders with explicit lines through the integration', async () => {
    const { world } = await buildWorld(testRun('test'));
    world.live = true;
    const order = await placeOrder(world, 'shopify', {
      identity: 'manual-1',
      lines: [{ variant: '1', quantity: 3 }],
      shipping: 'express',
    });
    await advanceWorld(world, world.now + 60_000);
    const imported = await readErpOrder(
      erpContext(world),
      (await world
        .store('world')
        .get<{ erpOrder: string }>('order', `shopify:${order.order}`))!.data
        .erpOrder,
    );
    expect(imported).toMatchObject({
      shippingMethodId: '8',
      lines: [expect.objectContaining({ quantity: 3 })],
    });
  });
});

interface MailPart {
  filename: string;
  mimeType: string;
  headers: { name: string; value: string }[];
  body: { data: string };
  parts: MailPart[];
}

/** The Gmail message fields these tests read. */
interface Mail {
  threadId: string;
  labelIds: string[];
  payload: MailPart;
}

/** Reads the mailbox through the simulated Gmail API, as Luma's adapter does. */
async function mailbox(world: World, query: string): Promise<Mail[]> {
  const call = async (path: string) =>
    (
      await gmail.handle(mailContext(world), {
        url: `https://gmail.googleapis.com/gmail/v1/users/me/${path}`,
        method: 'GET',
        headers: { authorization: 'Bearer test' },
        body: null,
      })
    ).body;
  const list = (await call(`messages?q=${encodeURIComponent(query)}`)) as {
    messages?: { id: string }[];
  };

  return Promise.all(
    (list.messages ?? []).map(
      async ({ id }) => (await call(`messages/${id}`)) as Mail,
    ),
  );
}

/** The newest message matching a search; fails when there is none. */
async function firstMail(world: World, query: string) {
  const [message] = await mailbox(world, query);
  if (!message) throw new Error(`No message matches ${query}`);

  return message;
}

const headerOf = (message: Mail, name: string) =>
  message.payload.headers.find((item) => item.name === name)?.value;

describe('operations mailbox', () => {
  it('emails purchase orders and threads the supplier’s split-delivery answer', async () => {
    const { world } = await buildWorld(testRun('test'));
    world.live = true;
    const supplier = world.model.variant('1').supplierId;
    await erp(world, {
      kind: 'supplier-profile',
      supplierId: supplier,
      profile: 'partial',
    });
    const placed = await erp(world, {
      kind: 'purchase-order',
      supplierId: supplier,
      deliveryDate: '2026-10-12',
      lines: [{ itemId: '1', quantity: 100 }],
    });
    await advanceWorld(world, world.now + 2 * 60_000);
    const order = (await erpContext(world).store.get<PurchaseOrderRecord>(
      erpKinds.purchaseOrder,
      placed.id,
    ))!.data;
    const sent = await firstMail(world, 'in:sent');
    expect(headerOf(sent, 'Subject')).toBe(`Bestellung ${order.orderNumber}`);
    const answer = await firstMail(
      world,
      'from:@supplier.example label:Lieferanten',
    );
    expect(answer.threadId).toBe(sent.threadId);
    expect(headerOf(answer, 'In-Reply-To')).toBe(
      `<po.${order.orderNumber.toLowerCase()}@luma-goods.example>`,
    );
    const text = Buffer.from(
      answer.payload.parts[0]!.body.data,
      'base64url',
    ).toString();
    expect(text).toContain(`${order.orderNumber}`);
    expect(text).toMatch(/60 (units|Stück)/);
    expect(text).toMatch(/(remaining|restlichen) 40/);
    expect(answer.payload.parts[1]).toMatchObject({
      filename: `Lieferplan-${order.orderNumber}.csv`,
      mimeType: 'text/csv',
    });

    // The same seed writes the same mail.
    const again = await buildWorld(testRun('test'));
    again.world.live = true;
    await erp(again.world, {
      kind: 'supplier-profile',
      supplierId: supplier,
      profile: 'partial',
    });
    await erp(again.world, {
      kind: 'purchase-order',
      supplierId: supplier,
      deliveryDate: '2026-10-12',
      lines: [{ itemId: '1', quantity: 100 }],
    });
    await advanceWorld(again.world, again.world.now + 2 * 60_000);
    const repeated = await firstMail(again.world, 'from:@supplier.example');
    expect(
      Buffer.from(repeated.payload.parts[0]!.body.data, 'base64url').toString(),
    ).toBe(text);
  }, 60_000);

  it('injects a split-delivery email for an open order and books it on recovery', async () => {
    const { world } = await buildWorld(testRun('test'));
    world.live = true;
    const id = randomUUID();
    const incident = await injectIncident(world, {
      id,
      kind: 'supplier-split-delivery-mail',
      instance: 'gmail',
    });
    expect(incident).toMatchObject({ status: 'active', instance: 'gmail' });
    expect(incident.resources.map((resource) => resource.kind)).toEqual([
      'PurchaseOrder',
      'Message',
    ]);
    expect(
      await injectIncident(world, { id, kind: 'supplier-split-delivery-mail' }),
    ).toEqual(incident);
    const purchaseOrder = (incident.detail as Record<string, unknown>)
      .purchaseOrder as string;
    const message = await mailContext(world).store.get<MessageRecord>(
      'message',
      incident.resources[1]!.id,
    );
    expect(message?.data.attachments[0]?.filename).toMatch(
      /^Lieferplan-BE-\d{5}\.csv$/,
    );
    // The supplier's own answers stay suppressed, so the ERP still shows no confirmation.
    await advanceWorld(world, world.now + 5 * 60_000);
    const store = erpContext(world).store;
    expect(
      (
        await store.get<PurchaseOrderRecord>(
          erpKinds.purchaseOrder,
          purchaseOrder,
        )
      )?.data.isConfirmed,
    ).toBe(false);
    await recoverIncident(world, id);
    const booked = (await store.get<PurchaseOrderRecord>(
      erpKinds.purchaseOrder,
      purchaseOrder,
    ))!.data;
    expect(booked.isConfirmed).toBe(true);
    expect(booked.lineItems[0]?.confirmedQuantity).toBe(60);
  }, 60_000);

  it('injects a customer email quoting the order name', async () => {
    const { world } = await buildWorld(testRun('test'));
    world.live = true;
    await placeOrder(world, 'shopify', { identity: 'mail-1' });
    const incident = await injectIncident(world, {
      id: randomUUID(),
      kind: 'customer-delay-mail',
    });
    const order = incident.resources[0]!;
    const message = await firstMail(world, 'from:@customer.example');
    expect(headerOf(message, 'Subject')).toContain(order.label);
    expect(message.labelIds).toEqual(['INBOX', 'UNREAD', 'Label_2']);
  }, 60_000);
});

describe('regional merchants', () => {
  it('runs an ANZ merchant on Cin7 with wholesale, local shifts and carriers', async () => {
    const run = testRun('anz-lifestyle');
    const { world, stores } = await buildWorld(run);
    expect(world.model.erp).toMatchObject({ name: 'cin7', kind: 'cin7' });
    const records = async <T>(kind: string) =>
      (await stores.get('cin7')!.page<T>({ kind, limit: 100_000 })).items.map(
        (record) => record.data,
      );
    const orders = await records<OrderRecord>(erpKinds.order);
    const wholesale = orders.filter((order) => !order.externalNumber);
    expect(wholesale.length).toBeGreaterThan(5);
    for (const order of wholesale)
      expect(order).toMatchObject({ currency: 'AUD', taxRate: 10 });
    expect(
      orders.find((order) => order.externalNumber?.startsWith('NZ')),
    ).toMatchObject({ currency: 'NZD', taxRate: 15 });

    const notes = await records<NoteRecord>(erpKinds.note);
    const byWarehouse = (id: string) =>
      notes.filter((note) => note.warehouse === id);
    expect(byWarehouse('2').length).toBeGreaterThan(0);
    for (const note of byWarehouse('2')) {
      expect(note.packages[0]?.trackingUrl).toMatch(/nzpost|nzcouriers/);
      const { hour } = localTime(Date.parse(note.date), 'Pacific/Auckland');
      expect(hour).toBeGreaterThanOrEqual(8);
      expect(hour).toBeLessThan(16);
    }
    for (const note of byWarehouse('1'))
      expect(note.packages[0]?.trackingUrl).toMatch(
        /auspost|startrack|aramex-au/,
      );

    const read = async (path: string) =>
      (
        await cin7.handle(erpContext(world) as Cin7Context, {
          url: `https://inventory.dearsystems.com/ExternalApi/v2/${path}`,
          method: 'GET',
          headers: {
            'api-auth-accountid': simulatedAccountId,
            'api-auth-applicationkey': 'key',
          },
          body: null,
        })
      ).body as Record<string, unknown>;
    const nz = orders.find((order) => order.externalNumber?.startsWith('NZ'))!;
    expect(await read(`sale?ID=${guid('sale', nz.id)}`)).toMatchObject({
      CustomerCurrency: 'NZD',
      BaseCurrency: 'AUD',
      SourceChannel: 'Shopify',
    });
    expect(
      await read(`sale?ID=${guid('sale', wholesale[0]!.id)}`),
    ).toMatchObject({ SourceChannel: '', CustomerReference: '' });
    expect(await read('me')).toEqual({
      Company: 'Harbour & Pine Pty Ltd',
      Currency: 'AUD',
    });
  }, 180_000);

  it('adds US sales tax at checkout and books it gross in the ERP', async () => {
    const run = testRun('uk-us-dtc');
    run.profile.historyDays = 0;
    const { world } = await buildWorld(run);
    const variant = world.model.catalog.variants.find((item) =>
      item.shops.includes('shopify-us'),
    )!;
    const order = await placeOrder(world, 'shopify-us', {
      identity: 'tax',
      lines: [{ variant: variant.id, quantity: 2 }],
    });
    const net = Number((variant.price * 1.25).toFixed(2));
    const shopOrder = await world
      .store('shopify-us')
      .get<{ total: number }>('Order', order.order);
    // Shopify stores order totals in minor units and rounds tax per line.
    const cents = Math.round(net * 200);
    const total = cents + Math.round(cents * 0.0725);
    expect(shopOrder?.data.total).toBe(total);
    await importOrder(world, 'shopify-us', order.order, '9001');
    const erpOrder = await erpContext(world).store.get<OrderRecord>(
      erpKinds.order,
      '9001',
    );
    // Linked orders compare totals exactly, so the ERP books the shop's gross total.
    expect(erpOrder?.data).toMatchObject({
      currency: 'USD',
      taxRate: 7.25,
      total: total / 100,
    });
  }, 60_000);
});
