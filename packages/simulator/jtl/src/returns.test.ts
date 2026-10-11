import { describe, expect, it } from 'vitest';

import { jtl } from './index.js';
import { call, order, seeded, start } from './test-support/fixture.js';

const body = (overrides: Record<string, unknown> = {}) => ({
  companyId: 1,
  salesOrderId: '1',
  warehouseId: '1',
  externalNumber: 'luma-rc:case-1',
  internalComment: 'Created by Luma',
  items: [
    {
      salesOrderLineItemId: '1',
      quantity: 2,
      returnReasonId: '1',
      credit: false,
    },
  ],
  ...overrides,
});

describe('JTL returns', () => {
  it('creates returns once per idempotency key and serves list, detail and lines', async () => {
    const { context, events } = await seeded();
    await order(context, 3);
    await order(context, 1);
    events.length = 0;
    const post = (key: string, value = body()) =>
      call(context, 'returns', 'POST', value, { 'idempotency-key': key });
    const created = await post('k');
    expect(created).toMatchObject({
      status: 201,
      body: {
        id: 1,
        number: 'RE-00001',
        returnDate: new Date(start).toISOString(),
        externalNumber: 'luma-rc:case-1',
        companyId: 1,
        salesOrderId: 1,
        warehouseId: 1,
        internalComment: 'Created by Luma',
      },
      committed: true,
    });
    expect(events).toEqual([
      {
        topic: 'returns/create',
        resource: '1',
        payload: { returnId: '1', salesOrderId: '1' },
      },
    ]);
    // A replay answers with the recorded return and creates nothing.
    const replay = await post('k');
    expect(replay).toEqual({
      status: 201,
      body: created.body,
      headers: { 'content-type': 'application/json' },
    });
    expect(events).toHaveLength(1);
    expect(
      await post(
        'other',
        body({
          salesOrderId: '2',
          externalNumber: 'x',
          items: [
            { salesOrderLineItemId: '2', quantity: 1, returnReasonId: '3' },
          ],
        }),
      ),
    ).toMatchObject({ status: 201, committed: true });

    expect(
      (await call(context, 'returns?salesOrderId=1&pageNumber=1&pageSize=10'))
        .body,
    ).toMatchObject({ totalItems: 1, items: [{ id: 1, salesOrderId: 1 }] });
    expect((await call(context, 'returns')).body).toMatchObject({
      totalItems: 2,
      items: [{ id: 1 }, { id: 2, externalNumber: 'x' }],
    });
    expect((await call(context, 'returns/1')).body).toMatchObject({
      id: 1,
      number: 'RE-00001',
    });
    expect((await call(context, 'returns/1/line-items')).body).toEqual([
      {
        id: 1,
        returnId: 1,
        stateId: 1,
        itemId: 1,
        name: 'Canvas tote',
        sKU: 'LUMA-001',
        quantity: 2,
        returnReasonId: 1,
        conditionId: 0,
        conditionComment: '',
        credit: false,
        salesOrderId: 1,
        salesOrderLineItemId: 1,
        deliveryNoteLineItemId: 0,
      },
    ]);
    expect((await call(context, 'returns/9')).status).toBe(404);
    expect((await call(context, 'returns?salesOrderId=x')).status).toBe(400);
  });

  it('serves return reasons in German and English and the order company', async () => {
    const { context } = await seeded();
    await order(context);
    expect((await call(context, 'return-reasons')).body).toEqual([
      {
        id: 1,
        translations: [
          { languageIso: 'de', name: 'Defekt' },
          { languageIso: 'en', name: 'Defective' },
        ],
      },
      expect.objectContaining({ id: 2 }),
      expect.objectContaining({ id: 3 }),
    ]);
    expect((await call(context, 'sales-orders/1')).body).toMatchObject({
      companyId: 1,
    });
    context.config = {
      ...context.config,
      returnReasons: [{ id: '5', name: 'Damaged in transit' }],
    };
    expect((await call(context, 'return-reasons')).body).toEqual([
      {
        id: 5,
        translations: [
          { languageIso: 'de', name: 'Damaged in transit' },
          { languageIso: 'en', name: 'Damaged in transit' },
        ],
      },
    ]);
  });

  it('refuses returns JTL would reject without recording anything', async () => {
    const { context, events } = await seeded();
    await order(context, 3);
    await order(context, 1);
    await jtl.command(context, { kind: 'cancel', id: '2' });
    events.length = 0;
    const post = (value: unknown) => call(context, 'returns', 'POST', value);
    const line = (overrides: Record<string, unknown>) => ({
      items: [
        {
          salesOrderLineItemId: '1',
          quantity: 1,
          returnReasonId: '1',
          ...overrides,
        },
      ],
    });
    for (const value of [
      body({ salesOrderId: '9' }),
      body({ salesOrderId: '2', items: [] }),
      body({ companyId: 2 }),
      body({ warehouseId: '9' }),
      body({ unknown: true }),
      body({ items: [] }),
      body(line({ returnReasonId: '9' })),
      body(line({ salesOrderLineItemId: '2' })),
      body(line({ quantity: 0 })),
      body(line({ quantity: 4 })),
      body(line({ credit: 'yes' })),
      body(line({ note: 'x' })),
      'not json',
    ])
      expect((await post(value)).status).toBe(400);
    expect(
      (
        await post(
          body({
            salesOrderId: '2',
            items: [
              { salesOrderLineItemId: '2', quantity: 1, returnReasonId: '1' },
            ],
          }),
        )
      ).body,
    ).toMatchObject({ status: 400, title: 'Sales order is cancelled' });

    // Units already in other returns cannot be returned again.
    expect((await post(body())).status).toBe(201);
    expect((await post(body(line({ quantity: 1 })))).status).toBe(201);
    expect(await post(body(line({ quantity: 1 })))).toMatchObject({
      status: 400,
      body: { title: 'Quantity exceeds the units left to return' },
    });
    expect((await call(context, 'returns?salesOrderId=1')).body).toMatchObject({
      totalItems: 2,
    });
    expect(events).toHaveLength(2);
  });
});
