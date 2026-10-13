import { createHmac, randomUUID } from 'node:crypto';
import { Agent, createServer, request } from 'node:http';
import { type AddressInfo, createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { merchantProfiles } from '@luma/simulator-commerce';
import type { RunDetail } from '@luma/simulator-contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { disposableDatabase } from './test-support/database.js';

const adminUrl = process.env.TEST_DATABASE_URL;
const token = 'simulator-host-test-token';
const shopify =
  'https://luma-synthetic-pilot.myshopify.com/admin/api/2026-07/graphql.json';

describe.skipIf(!adminUrl)('simulator host', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let app: Awaited<ReturnType<typeof createApp>>;

  async function call<T = unknown>(
    path: string,
    payload?: unknown,
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE',
  ) {
    const response = await app.inject({
      method: method ?? (payload === undefined ? 'GET' : 'POST'),
      url: `/api/${path}`,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    if (response.statusCode >= 300)
      throw new Error(`${response.statusCode} ${response.body}`);

    return (response.body ? response.json() : null) as T;
  }

  async function ready(id: string) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const run = await call<RunDetail>(`runs/${id}`);
      if (run.status === 'ready') return run;
      if (run.status === 'failed') throw new Error(run.error ?? 'failed');
      await delay(100);
    }
    throw new Error('Run did not become ready');
  }

  const provider = (
    id: string,
    query: string,
    variables: Record<string, unknown> = {},
  ) =>
    call<{ status: number; body: unknown; bodyText?: string; lost?: boolean }>(
      `runs/${id}/providers/shopify/request`,
      {
        url: shopify,
        method: 'POST',
        headers: {
          'x-shopify-access-token': 'synthetic',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      },
    );

  beforeAll(async () => {
    database = await disposableDatabase(adminUrl!);
    app = await createApp({
      databaseUrl: database.url,
      token,
      autonomous: false,
    });
  });
  afterAll(async () => {
    await app?.close();
    await database?.drop();
  });

  it('closes unused TCP preconnections when the simulator shuts down', async () => {
    const server = await createApp({
      databaseUrl: database.url,
      token,
      autonomous: false,
    });
    const address = new URL(
      await server.listen({ host: '127.0.0.1', port: 0 }),
    );
    const accepted = new Promise<void>((resolve) =>
      server.server.once('connection', () => resolve()),
    );
    const socket = createConnection({
      host: address.hostname,
      port: Number(address.port),
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    await accepted;
    let closed = false;
    const closing = server.close().then(() => {
      closed = true;
    });
    try {
      await expect.poll(() => closed, { timeout: 1000 }).toBe(true);
    } finally {
      socket.destroy();
      await closing;
    }
  });

  it('lets active HTTP work finish during simulator shutdown', async () => {
    const server = await createApp({
      databaseUrl: database.url,
      token,
      autonomous: false,
    });
    let entered!: () => void;
    let finish!: () => void;
    let draining!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const work = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const stoppedAccepting = new Promise<void>((resolve) => {
      draining = resolve;
    });
    server.get('/api/shutdown-work', async () => {
      entered();
      await work;

      return { finished: true };
    });
    server.addHook('preClose', async () => {
      draining();
    });
    const origin = await server.listen({ host: '127.0.0.1', port: 0 });
    const agent = new Agent({ keepAlive: true });
    const response = new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        request(
          `${origin}/api/shutdown-work`,
          {
            agent,
            headers: { authorization: `Bearer ${token}` },
          },
          (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => {
              body += chunk;
            });
            response.on('end', () =>
              resolve({ status: response.statusCode, body }),
            );
          },
        )
          .on('error', reject)
          .end();
      },
    );
    await started;
    let closed = false;
    const closing = server.close().then(() => {
      closed = true;
    });
    try {
      await stoppedAccepting;
      await expect
        .poll(() => server.server.listening, { timeout: 1000 })
        .toBe(false);
      expect(closed).toBe(false);
      finish();
      const result = await response;
      expect(result.status).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ finished: true });
      await expect.poll(() => closed, { timeout: 1000 }).toBe(true);
    } finally {
      finish();
      agent.destroy();
      await closing;
    }
  });

  it('requires its token and provisions runs from a profile and chaos preset', async () => {
    expect((await app.inject({ url: '/api/runs' })).statusCode).toBe(401);
    await call('runs', {
      id: 'host',
      profile: 'test',
      chaos: 'calm',
      running: false,
    });
    await expect(call('runs', { id: 'host', profile: 'test' })).rejects.toThrow(
      '409',
    );
    const run = await ready('host');
    expect(run).toMatchObject({
      profile: { name: 'test' },
      chaos: { preset: 'calm' },
      instances: [
        { name: 'jtl', kind: 'jtl', health: 'healthy' },
        { name: 'shopify', kind: 'shopify', health: 'healthy' },
        { name: 'starshipit', kind: 'starshipit', health: 'healthy' },
        { name: 'gmail', kind: 'gmail', health: 'healthy' },
      ],
      counts: { orders: 2, activeIncidents: 0 },
      merchant: { variants: 2 },
    });
    expect(
      (await call<{ merchants: unknown[] }>('profiles')).merchants.length,
    ).toBe(Object.keys(merchantProfiles).length);
  });

  it('serves provider requests with service health and manual faults', async () => {
    const orders = await provider(
      'host',
      'query LumaPage($first: Int!) { page: orders(first: $first) { nodes { id } pageInfo { hasNextPage endCursor } } }',
      { first: 10 },
    );
    expect(orders).toMatchObject({
      status: 200,
      body: {
        data: {
          page: {
            nodes: [
              { id: 'gid://shopify/Order/1' },
              { id: 'gid://shopify/Order/10' },
            ],
          },
        },
      },
    });
    await call('runs/host/control', {
      action: 'service-health',
      instance: 'shopify',
      status: 'unauthorized',
    });
    expect((await provider('host', '{ shop { name } }')).status).toBe(401);
    await call('runs/host/control', {
      action: 'service-health',
      instance: 'shopify',
      status: 'healthy',
    });
    await call('runs/host/control', {
      action: 'fault',
      rule: {
        instance: 'shopify',
        operation: '*',
        kind: 'malformed',
        occurrence: 2,
      },
    });
    expect((await provider('host', '{ shop { name } }')).status).toBe(200);
    const malformed = await provider('host', '{ shop { name } }');
    expect(malformed.bodyText).toBeDefined();
    expect(() => JSON.parse(malformed.bodyText!)).toThrow();
    const detail = await call<RunDetail>('runs/host');
    expect(detail.faults).toEqual([
      expect.objectContaining({
        kind: 'malformed',
        status: 'triggered',
        occurrence: 2,
      }),
    ]);
  });

  it('places orders through the integration, advances time and records metrics and journal', async () => {
    await call('runs/host/control', {
      action: 'order',
      lines: [{ sku: 'LUMA-001', quantity: 3 }],
    });
    await call('runs/host/control', {
      action: 'advance',
      milliseconds: 60_000,
    });
    const records = await call<{
      items: { data: { externalSalesOrderNumber?: string } }[];
    }>('runs/host/records/jtl?kind=sales-order&limit=10');
    expect(records.items.length).toBe(3);
    const kinds = await call<{ kind: string; count: number }[]>(
      'runs/host/records/shopify/kinds',
    );
    expect(kinds).toContainEqual({ kind: 'Order', count: 3 });
    const sku = await call<{
      erp: { reserved: number };
      shops: { committed: number; drift: number | null }[];
    }>('runs/host/skus/LUMA-001');
    expect(sku.erp.reserved).toBe(7);
    expect(sku.shops[0]).toMatchObject({ committed: 7 });
    expect(await call('runs/host/skus?q=luma')).toEqual([
      { sku: 'LUMA-001', name: 'Canvas tote' },
      { sku: 'LUMA-SCENARIO-001', name: 'Canvas tote · scenario' },
    ]);
    const journal = await call<{
      items: { kind: string }[];
      nextCursor: number | null;
    }>('runs/host/journal?limit=5');
    expect(journal.items.length).toBe(5);
    expect(journal.nextCursor).not.toBeNull();
    await delay(2_200);
    const metrics = await call<{
      series: { name: string; instance: string | null }[];
    }>('runs/host/metrics?windowMs=3600000');
    expect(metrics.series.map((series) => series.name)).toEqual(
      expect.arrayContaining([
        'orders.created',
        'requests',
        'requests.failed',
        'latency.mean',
      ]),
    );
  });

  it('injects, recovers and scores incidents without Luma', async () => {
    const id = randomUUID();
    const incident = await call<{
      id: string;
      status: string;
      resources: { id: string }[];
    }>('runs/host/incidents', {
      id,
      kind: 'inventory-drift',
      target: 'LUMA-SCENARIO-001',
    });
    expect(incident).toMatchObject({ id, status: 'active' });
    expect(
      await call('runs/host/incidents', { id, kind: 'inventory-drift' }),
    ).toMatchObject({ id });
    const sku = await call<{ shops: { drift: number }[]; incidents: string[] }>(
      'runs/host/skus/LUMA-SCENARIO-001',
    );
    expect(sku.shops[0]!.drift).not.toBe(0);
    expect(sku.incidents).toEqual([id]);
    const score = await call<{
      luma: { connected: boolean };
      totals: { incidents: number };
    }>('runs/host/scorecard');
    expect(score).toMatchObject({
      luma: { connected: false },
      totals: { incidents: 1 },
    });
    await call(`runs/host/incidents/${id}/recover`, {});
    expect(
      (
        await call<{ shops: { drift: number }[] }>(
          'runs/host/skus/LUMA-SCENARIO-001',
        )
      ).shops[0]!.drift,
    ).toBe(0);
    expect(await call('runs/host/incidents')).toEqual([
      expect.objectContaining({ id, status: 'recovered' }),
    ]);
  });

  it('starts a workflow scenario once, however often the request repeats', async () => {
    const request = {
      id: randomUUID(),
      scenario: 'stock-correction-lost-response',
    };
    const [incident] = await call<{ id: string; kind: string }[]>(
      'runs/host/scenarios',
      request,
    );
    expect(incident).toMatchObject({ kind: 'inventory-drift' });
    expect(await call('runs/host/scenarios', request)).toEqual([
      expect.objectContaining({ id: incident!.id }),
    ]);
    const run = await call<{
      faults: { operation: string; kind: string; status: string }[];
    }>('runs/host');
    expect(run.faults.filter((item) => item.kind === 'response-loss')).toEqual([
      expect.objectContaining({
        operation: 'inventory.available.reconcile',
        status: 'armed',
      }),
    ]);
    await call(`runs/host/incidents/${incident!.id}/recover`, {});
  });

  it('serves the mailbox, accepts mail commands and counts repeated sends', async () => {
    const gmail = (path: string, method = 'GET', body: unknown = null) =>
      call<{
        status: number;
        body: {
          emailAddress: string;
          messages: { id: string; threadId: string }[];
          threadId: string;
        };
      }>('runs/host/providers/gmail/request', {
        url: `https://gmail.googleapis.com/gmail/v1/users/me/${path}`,
        method,
        headers: {
          authorization: 'Bearer ya29.test',
          'content-type': 'application/json',
        },
        body: body === null ? null : JSON.stringify(body),
      });
    expect((await gmail('profile')).body).toMatchObject({
      emailAddress: 'einkauf@luma-goods.example',
    });
    await call('runs/host/control', {
      action: 'command',
      instance: 'gmail',
      command: {
        kind: 'deliver',
        from: { address: 'kunde@customer.example', name: 'Kunde' },
        subject: 'Bestellung #SIM-1',
        text: 'Wo bleibt meine Bestellung #SIM-1?',
        messageId: '<kunde-1@customer.example>',
      },
    });
    const listed = await gmail('messages?q=from:@customer.example');
    expect(listed.body.messages).toHaveLength(1);
    const raw = Buffer.from(
      [
        'To: kunde@customer.example',
        'Subject: Re: Bestellung #SIM-1',
        'Message-ID: <luma.host-test@luma-goods.example>',
        'In-Reply-To: <kunde-1@customer.example>',
        '',
        'Ihre Bestellung ist unterwegs.',
      ].join('\r\n'),
    ).toString('base64url');
    const send = { raw, threadId: listed.body.messages[0]!.threadId };
    const sent = await gmail('messages/send', 'POST', send);
    expect(sent.body.threadId).toBe(send.threadId);
    await gmail('messages/send', 'POST', send);
    const card = await call<{ repeatedWrites: unknown[] }>(
      'runs/host/scorecard',
    );
    expect(JSON.stringify(card)).toContain('messages.send');
    await expect(
      call('runs/host/control', {
        action: 'command',
        instance: 'gmail',
        command: {
          kind: 'deliver',
          from: { address: 'not-an-address' },
          text: 'x',
        },
      }),
    ).rejects.toThrow('400');
    const token = await call<{ status: number; body: unknown }>(
      'runs/host/providers/gmail/request',
      {
        url: 'https://oauth2.googleapis.com/token',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=refresh_token&refresh_token=1%2F%2Fx&client_id=c',
      },
    );
    expect(token).toMatchObject({
      status: 200,
      body: { token_type: 'Bearer' },
    });
  });

  it('delivers signed webhooks, including duplicates of the same event', async () => {
    const deliveries: { topic: string; event: string; valid: boolean }[] = [];
    const secret = 'webhook-test-secret-value';
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks);
        deliveries.push({
          topic: String(request.headers['x-shopify-topic']),
          event: String(request.headers['x-shopify-event-id']),
          valid:
            createHmac('sha256', secret).update(body).digest('base64') ===
            request.headers['x-shopify-hmac-sha256'],
        });
        response.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const { port } = server.address() as AddressInfo;
      await call(
        'runs/host/webhooks',
        {
          targets: [
            {
              instance: 'shopify',
              url: `http://127.0.0.1:${port}/hooks`,
              secret,
            },
          ],
        },
        'PUT',
      );
      const detail = await call<RunDetail>('runs/host');
      await call('runs/host/control', {
        action: 'chaos',
        chaos: {
          ...detail.chaosProfile,
          webhooks: {
            dropRate: 0,
            duplicateRate: 1,
            reorderRate: 0,
            delay: { medianMs: 10, p99Ms: 20 },
          },
        },
      });
      await call('runs/host/control', {
        action: 'order',
        lines: [{ sku: 'LUMA-001', quantity: 1 }],
      });
      // The order's new customer is delivered too, under its own topic.
      const created = () =>
        deliveries.filter((delivery) => delivery.topic === 'orders/create');
      for (let attempt = 0; attempt < 60 && created().length < 2; attempt++)
        await delay(100);
      expect(created()).toHaveLength(2);
      expect(created()[0]!.event).toBe(created()[1]!.event);
      expect(deliveries.every((delivery) => delivery.valid)).toBe(true);
    } finally {
      server.close();
    }
  });

  it('resets and deletes runs', async () => {
    await call('runs/host/control', { action: 'reset' });
    const reset = await ready('host');
    expect(reset.counts).toEqual({ orders: 2, activeIncidents: 0 });
    expect(reset.faults).toEqual([]);
    await call('runs/host', undefined, 'DELETE');
    await expect(call('runs/host')).rejects.toThrow('404');
  });
});
