import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { expect, it } from 'vitest';

import { returnsFixture } from './returns-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

/** Counts the statements the application sends to PostgreSQL while `operation` runs. */
async function countStatements(operation) {
  const query = pg.Client.prototype.query;
  let statements = 0;
  pg.Client.prototype.query = function (...args) {
    statements++;

    return query.apply(this, args);
  };
  try {
    await operation();
  } finally {
    pg.Client.prototype.query = query;
  }

  return statements;
}

it('builds the Needs you queue in a fixed number of statements however many return cases wait', async (t) => {
  const f = await settingsFixture(t);
  const r = await returnsFixture(t, f);
  const casesPath = `${f.base}/orders/${r.orders[1002]}/return-cases`;
  const line = (await f.request(f.owner, casesPath)).sources.find(
    (s) => s.connectionId === r.store,
  ).lines[0];
  const opened = await f.request(f.owner, casesPath, 'POST', {
    id: randomUUID(),
    connectionId: r.store,
    sourceReturnId: r.returns.received,
    lines: [
      {
        orderLineId: line.orderLineId,
        quantity: 1,
        reason: 'damaged',
        note: null,
      },
    ],
  });
  // The sidebar's and Home's read of the whole queue.
  const read = () => f.request(f.owner, `${f.base}/decisions?limit=5`);
  expect((await read()).counts.views.all).toBe(1);
  const one = await countStatements(read);

  // Copies of the open case stand in for a busy returns desk.
  await f.db.owner.query(
    `INSERT INTO orders_return_cases(tenant_id,id,order_id,connection_id,source_return_id,state,revision,document,opened_at,updated_at)
     SELECT c.tenant_id,n.id,c.order_id,c.connection_id,NULL,c.state,c.revision,
      jsonb_set(jsonb_set(c.document,'{id}',to_jsonb(n.id::text)),'{sourceReturnId}','null'),c.opened_at,c.updated_at
     FROM orders_return_cases c CROSS JOIN (SELECT gen_random_uuid() AS id FROM generate_series(1,199)) n
     WHERE c.tenant_id=$1 AND c.id=$2`,
    [f.org.id, opened.case.id],
  );
  expect((await read()).counts.views.all).toBe(200);
  const many = await countStatements(read);

  // Owners read their decisions in bulk and share one membership check per request.
  expect(many).toBe(one);
  expect(many).toBeLessThanOrEqual(80);
});
