import { randomUUID } from 'node:crypto';

import { settlementFixture } from './return-settlement-fixture.mjs';

/** Runs native order import and fulfillment in Shopify and Wawi before opening an all-resale exchange case. */
export async function completionFixture(t, options = {}) {
  const f = await settlementFixture(t, {
    ...options,
    resolution: 'exchange',
    prepare: 'opened',
    resellable: 2,
    fulfillment: 'pipeline',
  });
  let detail = f.detail;
  const evidence = {
    note: 'Warehouse counted two returned units and inspected both as resale stock',
    link: null,
  };
  const recordPhysical = async () => {
    detail = await f.request(`${f.path}/receipt`, {
      commandId: randomUUID(),
      expectedRevision: detail.case.revision,
      lines: f.lines.map((l) => ({ orderLineId: l.orderLineId, received: 2 })),
      evidence,
    });
    detail = await f.request(`${f.path}/inspection`, {
      commandId: randomUUID(),
      expectedRevision: detail.case.revision,
      lines: f.lines.map((l) => ({
        orderLineId: l.orderLineId,
        resellable: 2,
        damaged: 0,
      })),
      evidence,
    });
    detail = await f.request(`${f.path}/proposal`, {
      commandId: randomUUID(),
      expectedRevision: detail.case.revision,
      kind: 'exchange',
      lines: f.lines.map((l) => ({ orderLineId: l.orderLineId, restock: 2 })),
      evidence,
    });

    return detail;
  };
  const approve = (kind, id, decisionId) =>
    f.request(
      `${f.path}/${kind}/${id}/decision`,
      { decisionId, outcome: 'approved' },
      f.approver,
    );
  const createWawi = async (operationId, replacement, total) => {
    await f.call('runs/operations/control', {
      action: 'command',
      instance: 'jtl',
      command: {
        kind: 'order',
        externalNumber: `luma-ex:${operationId}`,
        lines: [
          {
            itemId: replacement.item.externalId,
            quantity: 2,
            price: Number(total.amount) / 2,
          },
        ],
        paid: true,
        currency: total.currency,
        shippingMethodId: '7',
      },
    });
  };

  return { ...f, recordPhysical, approve, createWawi };
}
