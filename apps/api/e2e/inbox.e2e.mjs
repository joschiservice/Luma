import { randomUUID } from 'node:crypto';

import { expect, test } from 'vitest';

import { until } from './helpers.mjs';
import {
  inboxFixture,
  mailboxAddress,
  splitDelivery,
} from './inbox-fixture.mjs';
import { expectStoredWriteReceipts } from './write-receipts-fixture.mjs';

const origin = 'http://127.0.0.1:3000';

test('reads only mail its rules select, links supplier mail to the purchase order and hands it to procurement', async (t) => {
  const f = await inboxFixture(t);
  const [mailbox] = (await f.messaging('/mailboxes')).items;
  expect(mailbox).toMatchObject({
    connectionId: f.mailboxId,
    provider: 'gmail',
    address: mailboxAddress,
    connectionStatus: 'active',
    canSend: true,
  });
  expect(
    mailbox.rules.map((rule) => [rule.kind, rule.value, rule.party.kind]),
  ).toEqual(
    expect.arrayContaining([
      ['sender_address', 'orders1@supplier.example', 'supplier'],
      ['sender_domain', 'supplier.example', 'other'],
      ['sender_domain', 'customer.example', 'customer'],
    ]),
  );
  expect(
    mailbox.rules.find((rule) => rule.party.kind === 'supplier').partyLabel,
  ).toBeTruthy();

  // Mail outside the rules never reaches Luma, not even as a stored message.
  const privateSubject = `Private note ${randomUUID()}`;
  await f.deliver({
    from: { address: 'friend@unrelated.example', name: 'A friend' },
    subject: privateSubject,
    text: 'Dinner on Friday? This should stay private.',
  });
  const { reference, order, lineId, supplierRule, summary } =
    await splitDelivery(f);
  const current = (await f.messaging('/mailboxes')).items[0];
  expect(current.state).toBe('current');
  expect(current.lastSyncedAt).not.toBeNull();
  expect(current.coveredUntil).not.toBeNull();
  expect(
    (await f.threads()).items.some((item) => item.subject === privateSubject),
  ).toBe(false);
  expect(
    (
      await f.db.owner.query(
        `SELECT count(*)::int AS n FROM messaging_messages
         WHERE tenant_id=$1 AND (from_address=$2 OR document->>'subject'=$3)`,
        [f.org, 'friend@unrelated.example', privateSubject],
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (await f.mailbox()).some((message) => message.subject === privateSubject),
  ).toBe(true);

  // The supplier's answer links to its supplier by rule and to the order by its reference.
  expect(summary).toMatchObject({
    status: 'open',
    awaitingReply: true,
    replyDueSource: 'automatic',
    correspondent: { address: 'orders1@supplier.example' },
  });
  const detail = await f.thread(summary.id);
  const supplierLink = detail.links.find(
    (link) => link.record.kind === 'supplier',
  );
  expect(supplierLink).toMatchObject({
    method: 'rule',
    state: 'active',
    record: { id: supplierRule.party.supplierId },
    evidence: { ruleId: supplierRule.id, text: 'orders1@supplier.example' },
  });
  const orderLink = detail.links.find(
    (link) => link.record.kind === 'purchase_order',
  );
  expect(orderLink).toMatchObject({
    method: 'reference',
    state: 'active',
    record: { id: order.id, label: reference },
    evidence: { text: reference },
  });
  const cited = detail.messages.find(
    (message) => message.id === orderLink.evidence.messageId,
  );
  const { start, end } = orderLink.evidence.span;
  expect(
    [cited.subject, cited.text].some(
      (text) => text?.slice(start, end) === reference,
    ),
  ).toBe(true);
  const answer = detail.messages.find(
    (message) => message.direction === 'inbound',
  );
  expect(answer).toMatchObject({
    origin: 'sync',
    from: { address: 'orders1@supplier.example' },
    source: { provider: 'gmail' },
  });
  expect(answer.text).toContain(reference);
  expect(detail.messages.find((m) => m.direction === 'outbound').from).toEqual(
    expect.objectContaining({ address: mailboxAddress }),
  );

  // The supplier message is recorded on the purchase order once.
  const handedOff = detail.events.filter(
    (event) => event.type === 'handed_off',
  );
  expect(handedOff).toEqual([
    expect.objectContaining({
      details: expect.objectContaining({ outcome: 'recorded' }),
    }),
  ]);
  let record = await f.request(
    `/procurement/purchase-orders/${order.id}/record`,
  );
  expect(record.communications).toHaveLength(1);
  const communication = record.communications[0];
  expect(communication).toMatchObject({
    channel: 'email',
    from: expect.stringContaining('orders1@supplier.example'),
  });
  await f.readMail();
  expect(
    (await f.request(`/procurement/purchase-orders/${order.id}/record`))
      .communications,
  ).toHaveLength(1);
  // Without a model route there is no extraction; a buyer records the commitment by hand,
  // citing the supplier's words, and it shows beside the order.
  expect(record.extractions[0]).toMatchObject({ state: 'unavailable' });
  const phrase = communication.body.match(/(\d+) (?:Stück|units)/);
  const span = { start: phrase.index, end: phrase.index + phrase[0].length };
  const quantity = Number(phrase[1]);
  await f.request(`/procurement/purchase-orders/${order.id}/commitments`, {
    id: randomUUID(),
    kind: 'confirmed_quantity',
    lineId,
    quantity,
    communicationId: communication.id,
    span,
  });
  record = await f.request(`/procurement/purchase-orders/${order.id}/record`);
  expect(record.commitments).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'confirmed_quantity',
        quantity,
        source: expect.objectContaining({
          kind: 'communication',
          communicationId: communication.id,
          span,
        }),
      }),
    ]),
  );

  // Records list the threads linked to them.
  for (const [kind, id] of [
    ['purchase_order', order.id],
    ['supplier', supplierRule.party.supplierId],
  ])
    expect(
      (await f.messaging(`/records/${kind}/${id}/threads`)).items.map(
        (item) => item.id,
      ),
    ).toContain(summary.id);
});

test('links a customer’s delay email to the order, and suggests profiles that share the address', async (t) => {
  const f = await inboxFixture(t);
  const incident = await f.scenario('customer-delay-mail');
  const orderName = incident.resources.find(
    (item) => item.kind === 'Order',
  ).label;
  let summary;
  await f.readUntil(async () => {
    summary = (await f.threads()).items.find((item) =>
      item.subject.includes(orderName),
    );

    return summary;
  }, 'the customer thread');
  expect(summary).toMatchObject({
    awaitingReply: true,
    replyDueSource: 'automatic',
    overdue: false,
  });
  expect(Date.parse(summary.replyDueAt)).toBeGreaterThan(Date.now());
  const detail = await f.thread(summary.id);
  const orderLink = detail.links.find((link) => link.record.kind === 'order');
  expect(orderLink).toMatchObject({
    method: 'reference',
    state: 'active',
    record: { label: orderName },
  });
  const sender = detail.messages[0].from.address;
  expect(sender).toMatch(/@customer\.example$/);
  // Each source's customer profile carries the address; several matches are only suggested.
  const customers = detail.links.filter(
    (link) => link.record.kind === 'customer',
  );
  expect(customers.length).toBeGreaterThan(0);
  for (const link of customers)
    expect(link).toMatchObject({
      method: 'address',
      evidence: { text: sender },
    });
  if (customers.length > 1) {
    expect(customers.every((link) => link.state === 'suggested')).toBe(true);
    // Confirming one suggestion activates only that link.
    const confirmed = await f.messaging(`/threads/${summary.id}/links`, {
      id: randomUUID(),
      kind: 'customer',
      recordId: customers[0].record.id,
    });
    const after = confirmed.links.filter(
      (link) => link.record.kind === 'customer',
    );
    expect(
      after.find((link) => link.record.id === customers[0].record.id).state,
    ).toBe('active');
    expect(
      after
        .filter((link) => link.record.id !== customers[0].record.id)
        .every((link) => link.state === 'suggested'),
    ).toBe(true);
  } else expect(customers[0].state).toBe('active');
  expect(
    (
      await f.messaging(`/records/order/${orderLink.record.id}/threads`)
    ).items.map((item) => item.id),
  ).toContain(summary.id);
});

test('thread work is permission-checked, idempotent and revision-checked, notes are never sent, and overdue threads reach Needs you', async (t) => {
  const f = await inboxFixture(t);
  const { summary } = await splitDelivery(f);
  const member = await f.join('Member', 'member');
  const roles = await f.request('/roles', undefined, { cookie: f.owner });
  const buyerRole = (roles.roles ?? roles.items).find(
    (role) => role.name === 'Buyer',
  );
  const buyer = await f.join('Buyer', buyerRole.id);
  const ownerId = f.manifest.requesterId;
  const operatorId = f.manifest.operatorId;

  // Members read threads but cannot change them.
  expect(
    (await f.thread(summary.id, { cookie: member.cookie })).thread.id,
  ).toBe(summary.id);
  await f.messaging(
    `/threads/${summary.id}/assignment`,
    {
      id: randomUUID(),
      expectedRevision: summary.revision,
      ownerId: member.id,
    },
    { cookie: member.cookie, status: 403 },
  );
  // Owners must be able to read messages.
  await f.messaging(
    `/threads/${summary.id}/assignment`,
    { id: randomUUID(), expectedRevision: summary.revision, ownerId: buyer.id },
    { status: 409 },
  );
  const assign = {
    id: randomUUID(),
    expectedRevision: summary.revision,
    ownerId: operatorId,
  };
  const assigned = await f.messaging(
    `/threads/${summary.id}/assignment`,
    assign,
  );
  expect(assigned).toMatchObject({ ownerId: operatorId });
  expect(assigned.revision).toBeGreaterThan(summary.revision);
  // A retry with the same request ID returns the same result; another body under it conflicts.
  expect(
    await f.messaging(`/threads/${summary.id}/assignment`, assign),
  ).toMatchObject({ ownerId: operatorId, revision: assigned.revision });
  await f.messaging(
    `/threads/${summary.id}/assignment`,
    { ...assign, ownerId: ownerId },
    { status: 409 },
  );
  // A stale revision is refused.
  await f.messaging(
    `/threads/${summary.id}/assignment`,
    { id: randomUUID(), expectedRevision: summary.revision, ownerId },
    { status: 409 },
  );
  expect((await f.threads('view=mine')).items.map((item) => item.id)).toContain(
    summary.id,
  );

  // An internal note stays in Luma.
  const note = `Internal: check stock before answering ${randomUUID()}`;
  const noted = await f.messaging(`/threads/${summary.id}/notes`, {
    id: randomUUID(),
    body: note,
  });
  expect(noted.notes).toEqual([
    expect.objectContaining({ body: note, authorId: operatorId }),
  ]);
  expect(noted.events.map((event) => event.type)).toContain('note_added');

  // A deadline in the past makes the thread overdue and a Needs you item for its owner.
  const due = new Date(Date.now() - 60_000).toISOString();
  const deadline = await f.messaging(`/threads/${summary.id}/deadline`, {
    id: randomUUID(),
    expectedRevision: noted.thread.revision,
    replyDueAt: due,
  });
  expect(deadline).toMatchObject({
    replyDueAt: due,
    replyDueSource: 'manual',
    overdue: true,
  });
  expect(
    (await f.threads('view=overdue')).items.map((item) => item.id),
  ).toContain(summary.id);
  const needsYou = async (cookie) =>
    (
      await f.request('/decisions?view=all&limit=100', undefined, { cookie })
    ).items.filter(
      (item) =>
        item.kind === 'message_reply' && item.owner?.threadId === summary.id,
    );
  expect(await needsYou(f.operator)).toEqual([
    expect.objectContaining({
      id: `message:${summary.id}`,
      reason: 'manual_intervention',
    }),
  ]);

  const waiting = await f.messaging(`/threads/${summary.id}/status`, {
    id: randomUUID(),
    expectedRevision: deadline.revision,
    status: 'waiting',
  });
  expect(waiting.status).toBe('waiting');
  const timeline = (await f.thread(summary.id)).events.map(
    (event) => event.type,
  );
  expect(timeline).toEqual(
    expect.arrayContaining([
      'assigned',
      'note_added',
      'deadline_set',
      'status_changed',
    ]),
  );

  // Further mail passes never send the note.
  await f.readMail();
  expect(
    (await f.mailbox()).filter((message) => message.text.includes(note)),
  ).toEqual([]);
  expect(
    (await f.thread(summary.id)).messages.some((message) =>
      message.text?.includes(note),
    ),
  ).toBe(false);
});

test('documents from attachments become facts to review, with duplicates and versions', async (t) => {
  const f = await inboxFixture(t);
  const { summary, reference } = await splitDelivery(f);
  let detail;
  await f.readUntil(async () => {
    detail = await f.thread(summary.id);

    return (
      detail.documents.length === 2 &&
      detail.documents.every((document) =>
        ['ready', 'failed', 'unreadable', 'unsupported'].includes(
          document.state,
        ),
      )
    );
  }, 'both attachments read');
  const csv = detail.documents.find(
    (document) => document.mimeType === 'text/csv',
  );
  const pdf = detail.documents.find(
    (document) => document.mimeType === 'application/pdf',
  );
  expect(csv, JSON.stringify(detail.documents)).toMatchObject({
    state: 'ready',
    version: 1,
    filename: `Lieferplan-${reference}.csv`,
  });
  expect(pdf, JSON.stringify(detail.documents)).toMatchObject({
    state: 'ready',
  });
  const schedule = await f.messaging(`/documents/${csv.id}`);
  expect(schedule.representation.kind).toBe('sheets');
  expect(schedule.facts.length).toBeGreaterThan(0);
  expect(schedule.facts.every((fact) => fact.origin === 'table')).toBe(true);
  const lines = schedule.facts.filter((fact) => fact.value.kind === 'line');
  expect(lines.length).toBeGreaterThan(0);
  expect(lines[0]).toMatchObject({
    locator: { kind: 'cells' },
    value: { sku: 'LUMA-001' },
  });
  const poReference = schedule.facts.find(
    (fact) =>
      fact.value.kind === 'reference' && fact.value.role === 'purchase_order',
  );
  expect(poReference).toMatchObject({
    value: { text: reference },
    match: { state: 'matched', record: { kind: 'purchase_order' } },
  });
  expect(schedule.facts.some((fact) => fact.value.kind === 'date')).toBe(true);
  expect(
    (await f.threads('view=review')).items.map((item) => item.id),
  ).toContain(summary.id);

  // A clear fact can be confirmed as it is; reviews are idempotent by request ID.
  const review = { id: randomUUID(), outcome: 'confirm' };
  const confirmed = await f.messaging(
    `/facts/${poReference.id}/review`,
    review,
  );
  expect(confirmed).toMatchObject({
    status: 'confirmed',
    review: { outcome: 'confirmed' },
  });
  expect(await f.messaging(`/facts/${poReference.id}/review`, review)).toEqual(
    confirmed,
  );

  // The same file again is a duplicate of the first, with nothing to review.
  const stored = await f.call(
    `runs/operations/records/gmail?kind=attachment&limit=100`,
  );
  const original = stored.items
    .map((item) => item.data)
    .find((item) =>
      Buffer.from(item.base64, 'base64')
        .toString('utf8')
        .includes('Liefertermin'),
    );
  const answer = detail.messages.find(
    (message) => message.direction === 'inbound',
  );
  await f.deliver({
    from: { address: 'orders1@supplier.example', name: 'Nordwind' },
    threadOf: answer.source.messageId,
    text: 'Here is the schedule again.',
    attachments: [
      {
        filename: `Lieferplan-${reference}.csv`,
        mimeType: 'text/csv',
        base64: original.base64,
      },
    ],
  });
  let duplicate;
  await f.readUntil(async () => {
    detail = await f.thread(summary.id);
    duplicate = detail.documents.find(
      (document) => document.id !== csv.id && document.mimeType === 'text/csv',
    );

    return (
      duplicate &&
      duplicate.state !== 'pending' &&
      duplicate.state !== 'reading'
    );
  }, 'the repeated schedule');
  expect(duplicate).toMatchObject({
    state: 'duplicate',
    duplicateOf: csv.id,
    factsToReview: 0,
  });

  // An amended schedule is the next version: changed facts are marked, and a date that reads
  // two ways needs a correction before it counts.
  const rows = Buffer.from(original.base64, 'base64')
    .toString('utf8')
    .trimEnd()
    .split(/\r?\n/)
    .map((row) => row.split(';'));
  const header = rows[0];
  const quantity = header.indexOf('Menge');
  const date = header.indexOf('Liefertermin');
  rows[1][quantity] = String(Number(rows[1][quantity]) - 5);
  rows[1][date] = '05/11/2026';
  await f.deliver({
    from: { address: 'orders1@supplier.example', name: 'Nordwind' },
    threadOf: answer.source.messageId,
    text: 'Correction: the first part is smaller. Updated schedule attached.',
    attachments: [
      {
        filename: `Lieferplan-${reference}.csv`,
        mimeType: 'text/csv',
        base64: Buffer.from(
          `${rows.map((row) => row.join(';')).join('\r\n')}\r\n`,
        ).toString('base64'),
      },
    ],
  });
  let amended;
  await f.readUntil(async () => {
    detail = await f.thread(summary.id);
    amended = detail.documents.find((document) => document.version === 2);

    return amended?.state === 'ready';
  }, 'the amended schedule');
  expect(amended.previousId).toBe(csv.id);
  const second = await f.messaging(`/documents/${amended.id}`);
  const changed = second.facts.filter((fact) => fact.change === 'changed');
  expect(changed.length).toBeGreaterThan(0);
  expect(
    second.facts.find(
      (fact) =>
        fact.value.kind === 'reference' && fact.value.role === 'purchase_order',
    ),
  ).toMatchObject({ change: 'unchanged', status: 'confirmed' });
  const unclear = second.facts.find(
    (fact) => fact.value.kind === 'date' && fact.confidence === 'low',
  );
  expect(unclear).toMatchObject({ status: 'needs_correction' });
  await f.messaging(
    `/facts/${unclear.id}/review`,
    { id: randomUUID(), outcome: 'confirm' },
    { status: 409 },
  );
  const corrected = await f.messaging(`/facts/${unclear.id}/review`, {
    id: randomUUID(),
    outcome: 'correct',
    correction: {
      value: { kind: 'date', role: 'delivery', date: '2026-11-05' },
      record: null,
    },
  });
  expect(corrected).toMatchObject({
    status: 'confirmed',
    value: { date: '2026-11-05' },
    review: { outcome: 'corrected', original: unclear.value },
  });
  expect(
    (await f.thread(summary.id)).events.filter(
      (event) => event.type === 'fact_reviewed',
    ),
  ).toHaveLength(2);
});

test('replies cite records, send once after a fresh read, need another admin for commitments, and are withheld in observe-only', async (t) => {
  const f = await inboxFixture(t);
  const incident = await f.scenario('customer-delay-mail');
  const orderName = incident.resources.find(
    (item) => item.kind === 'Order',
  ).label;
  let summary;
  await f.readUntil(async () => {
    summary = (await f.threads()).items.find((item) =>
      item.subject.includes(orderName),
    );

    return summary;
  }, 'the customer thread');
  const sent = async (outboundId) =>
    (await f.mailbox()).filter(
      (message) =>
        message.messageId === `luma.${outboundId}@luma-goods.example`,
    );
  const draft = async () => {
    const reply = await f.messaging(`/threads/${summary.id}/drafts`, {
      id: randomUUID(),
    });
    expect(reply).toMatchObject({
      state: 'draft',
      to: [expect.objectContaining({ address: summary.correspondent.address })],
      cc: [],
    });
    expect(reply.subject).toMatch(/^Re: /);

    return reply;
  };
  const edit = (reply, text, subject = reply.subject) =>
    f.request(
      `/messaging/outbound/${reply.id}`,
      {
        expectedRevision: reply.revision,
        to: reply.to.map((item) => item.address),
        cc: [],
        subject,
        text,
      },
      { method: 'PUT' },
    );
  const settled = async (reply) => {
    let current = reply;
    await until(
      async () => {
        if (current.state === 'uncertain' || current.state === 'sending')
          current = await f.messaging(`/outbound/${reply.id}/check`, {
            id: randomUUID(),
          });

        return !['uncertain', 'sending'].includes(current.state);
      },
      `reply ${reply.id} settles`,
      30_000,
    );

    return current;
  };

  // Drafts cite the linked order with its observation time.
  const first = await draft();
  const citation = first.citations.find((item) => item.record.kind === 'order');
  expect(citation).toMatchObject({
    record: { label: orderName },
    freshness: expect.stringMatching(/^(fresh|stale|missing)$/),
  });
  if (citation.freshness !== 'missing')
    expect(citation.observedAt).not.toBeNull();

  // In observe-only, a requested reply is withheld and nothing reaches the mailbox.
  const settings = await f.request('/settings', undefined, {
    cookie: f.owner,
  });
  const writeMode = async (mode, revision) =>
    f.request(
      '/settings/write-mode',
      { commandId: randomUUID(), revision, writeMode: mode },
      { cookie: f.owner, method: 'PATCH' },
    );
  const observing = await writeMode(
    'observe_only',
    settings.workspace.revision,
  );
  const plain = 'Thank you for your message. We are looking into it for you.';
  const observed = await edit(first, plain);
  expect(observed.consequential).toEqual([]);
  const withheld = await f.messaging(`/outbound/${first.id}/request`, {
    id: randomUUID(),
  });
  expect(withheld.state).toBe('withheld');
  expect(await sent(first.id)).toEqual([]);
  await writeMode('writes_enabled', observing.workspace.revision);

  // A reply without commitments is sent at once and confirmed by reading the thread.
  const second = await draft();
  await edit(second, plain);
  const request = { id: randomUUID() };
  const requested = await f.messaging(
    `/outbound/${second.id}/request`,
    request,
  );
  const done = await settled(requested);
  expect(done, JSON.stringify(done)).toMatchObject({
    state: 'sent',
    consequential: [],
  });
  expect(await sent(second.id)).toHaveLength(1);
  const confirmed = await f.thread(summary.id);
  const message = confirmed.messages.find(
    (item) => item.id === done.sentMessageId,
  );
  expect(message).toMatchObject({ direction: 'outbound', origin: 'luma' });
  expect(confirmed.thread.awaitingReply).toBe(false);
  // Repeating the request, sending and checking never send again.
  await f.messaging(`/outbound/${second.id}/request`, request);
  await f.messaging(`/outbound/${second.id}/send`, { id: randomUUID() });
  await f.messaging(`/outbound/${second.id}/check`, { id: randomUUID() });
  await f.readMail();
  expect(await sent(second.id)).toHaveLength(1);

  // A reply that commits to a date and quantity needs a different admin's approval.
  const third = await draft();
  const promise = await edit(
    third,
    'We will ship 2 units on 2026-10-20. Thank you for your patience.',
  );
  expect(promise.consequential).toEqual(
    expect.arrayContaining(['date', 'quantity']),
  );
  const waiting = await f.messaging(`/outbound/${third.id}/request`, {
    id: randomUUID(),
  });
  expect(waiting).toMatchObject({
    state: 'approval_required',
    canApprove: false,
  });
  expect(waiting.decisionId).toBeTruthy();
  // The requester cannot approve their own reply, nor send it before approval.
  await f.messaging(
    `/outbound/${third.id}/decision`,
    { decisionId: waiting.decisionId, outcome: 'approved' },
    { status: 409 },
  );
  await f.messaging(
    `/outbound/${third.id}/send`,
    { id: randomUUID() },
    { status: 409 },
  );
  expect(await sent(third.id)).toEqual([]);
  const approval = (
    await f.request('/decisions?view=all&limit=100', undefined, {
      cookie: f.owner,
    })
  ).items.find((item) => item.id === `message-send:${third.id}`);
  expect(approval).toMatchObject({ kind: 'message_reply', reason: 'approval' });
  const approved = await f.messaging(
    `/outbound/${third.id}/decision`,
    { decisionId: waiting.decisionId, outcome: 'approved' },
    { cookie: f.owner },
  );
  const delivered = await settled(approved);
  expect(delivered).toMatchObject({
    state: 'sent',
    approverId: f.manifest.requesterId,
  });
  await f.messaging(`/outbound/${third.id}/send`, { id: randomUUID() });
  await f.messaging(`/outbound/${third.id}/check`, { id: randomUUID() });
  await f.readMail();
  expect(await sent(third.id)).toHaveLength(1);
  expect(await sent(first.id)).toEqual([]);
  const events = (await f.thread(summary.id)).events.map((event) => event.type);
  expect(events).toEqual(
    expect.arrayContaining([
      'reply_withheld',
      'reply_requested',
      'reply_approved',
      'sent',
    ]),
  );

  // Each accepted send cites one stored send receipt, naming the sent message.
  const receipts = await expectStoredWriteReceipts(f.db.owner, f.org);
  const accepted = receipts.filter((attempt) => attempt.cited.length);
  expect(accepted).toHaveLength(2);
  for (const attempt of accepted)
    expect(attempt.stored[0]).toMatchObject({
      owner: 'messaging',
      document: {
        source: { provider: 'gmail' },
        records: expect.arrayContaining([
          { resource: 'message', externalId: expect.any(String) },
        ]),
      },
    });
});

test('another workspace cannot read or act on this inbox’s threads, documents or replies', async (t) => {
  const f = await inboxFixture(t);
  const { summary } = await splitDelivery(f);
  let document;
  await f.readUntil(async () => {
    document = (await f.thread(summary.id)).documents.find(
      (item) => item.state === 'ready',
    );

    return document;
  }, 'a read document');
  const reply = await f.messaging(`/threads/${summary.id}/drafts`, {
    id: randomUUID(),
  });
  const outsider = await f.join('Outsider');
  const other = await f.request(
    '/v1/organizations',
    {
      name: 'Other shop',
      slug: `other-${randomUUID().slice(0, 8)}`,
      dataRegion: globalThis.process.env.LUMA_REGION ?? 'AU',
    },
    { cookie: outsider.cookie, status: 201 },
  );
  const root = `/v1/organizations/${other.id}/messaging`;
  const as = { cookie: outsider.cookie, status: 404 };
  await f.request(`${root}/threads/${summary.id}`, undefined, as);
  await f.request(`${root}/documents/${document.id}`, undefined, as);
  await f.request(
    `${root}/threads/${summary.id}/notes`,
    { id: randomUUID(), body: 'Not mine' },
    as,
  );
  await f.request(
    `${root}/outbound/${reply.id}/request`,
    { id: randomUUID() },
    as,
  );
  await f.request(
    `${root}/outbound/${reply.id}/check`,
    { id: randomUUID() },
    as,
  );
  expect(
    (
      await f.request(`${root}/threads?view=all`, undefined, {
        cookie: outsider.cookie,
      })
    ).items,
  ).toEqual([]);
  // Not a member of the first workspace at all.
  const denied = await f.pilot.app.inject({
    method: 'GET',
    url: `${f.base}/messaging/threads/${summary.id}`,
    headers: { cookie: outsider.cookie, origin },
  });
  expect([403, 404]).toContain(denied.statusCode);
  expect((await f.thread(summary.id)).notes).toEqual([]);
});
