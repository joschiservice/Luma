import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  createGmailConnector,
  createInstallationVerifier,
  outboundMessageId,
} from '@luma/app-gmail';
import { createCapabilityRuntime } from '@luma/connections/adapters';
import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';

import {
  createMemoryStore,
  createTransport,
} from '../../packages/simulator/core/dist/index.js';
import { gmail, textPdf } from '../../packages/simulator/gmail/dist/index.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const connectionId = 'gmail-contract';
const address = 'einkauf@luma-goods.example';
const start = Date.parse('2026-10-01T08:00:00Z');

const tenant = makeTenantContext(
  { userId: 'owner', sessionId: 'session' },
  {
    id: tenantId,
    name: 'Test',
    slug: 'test',
    status: 'active',
    dataRegion: 'EU',
  },
  builtInMembership(
    { id: 'member', organizationId: tenantId, userId: 'owner' },
    'owner',
  ),
  'request',
);

const filter = {
  senderDomains: ['supplier.example'],
  senderAddresses: [],
  recipientAddresses: [],
  labels: [],
  includeSent: true,
};

/**
 * A mailbox with a purchase-order email the ERP sent to a supplier, the supplier's answer with a
 * PDF in the same thread, and a customer's email that the supplier filter must not return.
 * `loseNextSend` drops the response of the next send after Gmail stored the message.
 */
async function createEnvironment() {
  const store = createMemoryStore();
  const clock = { now: start };
  const context = () => ({
    store,
    now: clock.now,
    wallTime: clock.now,
    instance: 'gmail',
    config: { address, name: 'Luma Goods Einkauf' },
    indexLagMs: 0,
    notify: () => {},
  });
  const command = (value) => gmail.command(context(), value);
  await command({ kind: 'seed-mailbox', address, name: 'Luma Goods Einkauf' });
  await command({
    kind: 'deliver',
    from: { address, name: 'Luma Goods Einkauf' },
    to: [{ address: 'orders1@supplier.example', name: 'Nordwind Textil' }],
    subject: 'Bestellung BE-00042',
    text: 'Bitte liefern Sie 100 x LUMA-001.',
    messageId: 'po.be-00042@luma-goods.example',
  });
  clock.now += 60_000;
  const answer = await command({
    kind: 'deliver',
    from: { address: 'orders1@supplier.example', name: 'Nordwind Textil' },
    threadOf: 'po.be-00042@luma-goods.example',
    text: 'Wir können 60 Stück am 14.10.2026 senden; die restlichen 40 folgen in der Woche darauf.',
    messageId: 'split.be-00042@supplier.example',
    attachments: [
      {
        filename: 'AB-BE-00042.pdf',
        mimeType: 'application/pdf',
        base64: textPdf(['Auftragsbestätigung BE-00042', '60 x LUMA-001']),
      },
    ],
  });
  clock.now += 60_000;
  await command({
    kind: 'deliver',
    from: { address: 'ada.lovelace.1@customer.example' },
    subject: 'Wo bleibt #DE1001?',
    text: 'Meine Bestellung ist noch nicht da.',
  });
  clock.now += 60_000;

  const control = { loseNextSend: false, unauthorized: false };
  const fetch = createTransport(async (request) => {
    if (control.unauthorized) return gmail.unauthorized(request);
    const response = await gmail.handle(context(), request);
    if (response.committed && control.loseNextSend) {
      control.loseNextSend = false;

      return { ...response, lost: true };
    }

    return response;
  });
  const connector = createGmailConnector({
    tenantId,
    connectionId,
    emailAddress: address,
    accessToken: async () => 'ya29.synthetic-only',
    fetch,
    now: () => new Date(clock.now),
  });
  const runtime = createCapabilityRuntime({
    resolve: async () => connector,
    record: async () => {},
  });

  return {
    store,
    clock,
    control,
    fetch,
    connector,
    answer,
    async read(capability, input) {
      const result = await runtime.read(tenant, {
        connectionId,
        capability,
        version: '0',
        input,
      });
      assert.equal(result.ok, true, JSON.stringify(result));

      return result.value;
    },
    send(input, key = 'send-1') {
      const handler = connector.capabilities['messages.send'];

      return handler.run(
        { tenant, connectionId, provider: 'gmail', idempotencyKey: key },
        handler.parseInput(input),
      );
    },
    async sentCount(outboundId) {
      return store.count({
        kind: 'message',
        key: outboundMessageId(outboundId, address),
      });
    },
  };
}

test('the Gmail verifier grants reads for the matching mailbox', async () => {
  const environment = await createEnvironment();
  const verify = createInstallationVerifier({ fetch: environment.fetch });
  const connection = (emailAddress) => ({
    tenantId,
    id: connectionId,
    provider: 'gmail',
    label: 'Operations mailbox',
    target: { kind: 'gmail', emailAddress },
  });
  assert.deepEqual(
    await verify(connection(address), { token: 'ya29.synthetic-only' }),
    ['messages.read', 'message-threads.read', 'message-attachments.read'],
  );
  await assert.rejects(
    verify(connection('other@luma-goods.example'), {
      token: 'ya29.synthetic-only',
    }),
  );
});

test('messages.read returns only filtered mail, paged, with thread and attachments', async () => {
  const environment = await createEnvironment();
  const receivedSince = new Date(start - 86_400_000).toISOString();
  const all = await environment.read('messages.read', {
    filter,
    receivedSince,
    limit: 100,
  });
  assert.equal(all.completeness, 'complete');
  assert.equal(all.nextCursor, null);
  const byDirection = Object.fromEntries(
    all.items.map((item) => [item.data.direction, item.data]),
  );
  assert.deepEqual(Object.keys(byDirection).sort(), ['inbound', 'outbound']);
  const inbound = byDirection.inbound;
  assert.equal(inbound.from.address, 'orders1@supplier.example');
  assert.equal(inbound.rfcMessageId, 'split.be-00042@supplier.example');
  assert.equal(inbound.inReplyTo, 'po.be-00042@luma-goods.example');
  assert.equal(
    inbound.thread.externalId,
    byDirection.outbound.thread.externalId,
  );
  assert.match(inbound.text, /restlichen 40/);
  assert.deepEqual(
    inbound.attachments.map(({ filename, mimeType }) => ({
      filename,
      mimeType,
    })),
    [{ filename: 'AB-BE-00042.pdf', mimeType: 'application/pdf' }],
  );

  const first = await environment.read('messages.read', {
    filter,
    receivedSince,
    limit: 1,
  });
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);
  const second = await environment.read('messages.read', {
    filter,
    receivedSince,
    limit: 1,
    cursor: first.nextCursor,
  });
  assert.equal(second.items.length, 1);
  assert.notEqual(
    second.items[0].source.externalId,
    first.items[0].source.externalId,
  );

  // The window starts after the purchase-order email, so only the answer is read.
  const recent = await environment.read('messages.read', {
    filter,
    receivedSince: new Date(start + 30_000).toISOString(),
    limit: 100,
  });
  assert.deepEqual(
    recent.items.map((item) => item.data.direction),
    ['inbound'],
  );
});

test('thread and attachment reads return the conversation and exact bytes', async () => {
  const environment = await createEnvironment();
  const thread = { externalId: environment.answer.threadId, scopeKey: '' };
  const page = await environment.read('message-threads.read', {
    thread,
    limit: 100,
  });
  assert.deepEqual(
    page.items.map((item) => item.data.direction),
    ['outbound', 'inbound'],
  );
  const [attachment] = page.items[1].data.attachments;
  const content = await environment.read('message-attachments.read', {
    message: { externalId: environment.answer.id, scopeKey: '' },
    attachment: attachment.attachment,
    maxBytes: 1_000_000,
  });
  const bytes = Buffer.from(content.base64, 'base64');
  assert.equal(content.size, bytes.length);
  assert.equal(
    content.sha256,
    createHash('sha256').update(bytes).digest('hex'),
  );
  assert.match(bytes.toString('latin1'), /^%PDF-1\.4/);
});

test('messages.send replies in the thread once, even after a lost response', async () => {
  const environment = await createEnvironment();
  const thread = { externalId: environment.answer.threadId, scopeKey: '' };
  const reply = (outboundId) => ({
    outboundId,
    thread,
    inReplyTo: 'split.be-00042@supplier.example',
    references: [
      'po.be-00042@luma-goods.example',
      'split.be-00042@supplier.example',
    ],
    to: [{ address: 'orders1@supplier.example', name: 'Nordwind Textil' }],
    cc: [],
    subject: 'Re: Bestellung BE-00042',
    text: 'Danke, wir erwarten die restlichen 40 Stück in der Folgewoche.',
  });
  const receipt = await environment.send(reply('out-1'));
  assert.equal(receipt.status, 'accepted');
  const page = await environment.read('message-threads.read', {
    thread,
    limit: 100,
  });
  const sent = page.items.at(-1).data;
  assert.equal(sent.direction, 'outbound');
  assert.equal(sent.rfcMessageId, outboundMessageId('out-1', address));
  assert.equal(page.items.length, 3);

  // Repeating the send finds the message instead of sending it again.
  assert.deepEqual(await environment.send(reply('out-1'), 'send-2'), receipt);
  assert.equal(await environment.sentCount('out-1'), 1);

  environment.control.loseNextSend = true;
  await assert.rejects(environment.send(reply('out-2')));
  const retried = await environment.send(reply('out-2'), 'send-3');
  assert.equal(retried.status, 'accepted');
  assert.equal(await environment.sentCount('out-2'), 1);
});

test('rejected credentials fail reads without results', async () => {
  const environment = await createEnvironment();
  environment.control.unauthorized = true;
  const result = await createCapabilityRuntime({
    resolve: async () => environment.connector,
    record: async () => {},
  }).read(tenant, {
    connectionId,
    capability: 'messages.read',
    version: '0',
    input: {
      filter,
      receivedSince: new Date(start).toISOString(),
      limit: 10,
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.effect, 'none');
});
