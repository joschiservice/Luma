import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  publishingBlocker,
  type PublishingChoice,
  type PublishingSnapshot,
  publishingVerified,
} from './shipment-publishing.js';

const gid = (kind: string, id = 1) => `gid://shopify/${kind}/${id}`;

function fixture() {
  const snapshot: PublishingSnapshot = {
    id: randomUUID(),
    observedAt: new Date().toISOString(),
    revision: 'revision',
    orderId: gid('Order'),
    cancelled: false,
    complete: true,
    work: [
      {
        id: gid('FulfillmentOrder'),
        status: 'OPEN',
        requestStatus: 'UNSUBMITTED',
        actions: ['CREATE_FULFILLMENT'],
        locationId: gid('Location'),
        locationName: 'Warehouse',
        lines: [
          {
            id: gid('FulfillmentOrderLineItem'),
            orderLineId: gid('LineItem'),
            name: 'Canvas tote',
            remaining: 3,
            total: 3,
          },
        ],
      },
    ],
    shipments: [],
    dispatch: {
      id: randomUUID(),
      observationId: randomUUID(),
      observedAt: new Date().toISOString(),
      revision: 'dispatch',
      complete: true,
      connectionId: randomUUID(),
      shipmentId: 'parcel1',
      stage: 'carrier',
      locationId: null,
      lines: [],
      tracking: [
        {
          company: 'Synthetic',
          number: 'parcel1',
          url: 'https://tracking.example.test/parcel1',
        },
      ],
    },
  };
  const choice: PublishingChoice = {
    capability: 'fulfillment.shipment.create',
    source: {
      downstreamConnectionId: snapshot.dispatch!.connectionId,
      shipmentId: 'parcel1',
    },
    notifyCustomer: false,
    allocationSource: 'operator',
    allocations: [
      {
        fulfillmentOrderId: gid('FulfillmentOrder'),
        fulfillmentOrderLineId: gid('FulfillmentOrderLineItem'),
        orderLineId: gid('LineItem'),
        locationId: gid('Location'),
        quantity: 1,
      },
    ],
  };

  return { snapshot, choice };
}

describe('physical Shopify shipment publishing', () => {
  it('permits an explicit reviewed partial allocation while provider allocation stays unknown', () => {
    const { snapshot, choice } = fixture();
    expect(publishingBlocker(snapshot, choice, [choice.capability])).toBeNull();
    expect(
      publishingBlocker(snapshot, { ...choice, allocationSource: 'provider' }, [
        choice.capability,
      ]),
    ).not.toBeNull();
  });
  it('blocks labels, stale evidence, incomplete reads and missing write scope', () => {
    const { snapshot, choice } = fixture();
    expect(publishingBlocker(snapshot, choice, [])).not.toBeNull();
    expect(
      publishingBlocker({ ...snapshot, complete: false }, choice, [
        choice.capability,
      ]),
    ).not.toBeNull();
    expect(
      publishingBlocker(
        { ...snapshot, dispatch: { ...snapshot.dispatch!, stage: 'unknown' } },
        choice,
        [choice.capability],
      ),
    ).not.toBeNull();
    expect(
      publishingBlocker(
        {
          ...snapshot,
          dispatch: {
            ...snapshot.dispatch!,
            observedAt: new Date(Date.now() - 301_000).toISOString(),
          },
        },
        choice,
        [choice.capability],
      ),
    ).not.toBeNull();
  });
  it('withholds cancelled work and concurrent fulfillment or changed warehouse allocation', () => {
    const { snapshot, choice } = fixture();
    expect(
      publishingBlocker({ ...snapshot, cancelled: true }, choice, [
        choice.capability,
      ]),
    ).not.toBeNull();
    snapshot.work[0]!.lines[0]!.remaining = 0;
    expect(
      publishingBlocker(snapshot, choice, [choice.capability]),
    ).not.toBeNull();
    snapshot.work[0]!.lines[0]!.remaining = 3;
    snapshot.dispatch!.locationId = gid('Location', 2);
    expect(
      publishingBlocker(snapshot, choice, [choice.capability]),
    ).not.toBeNull();
  });
  it('never overrides provider-reported quantities with an operator allocation', () => {
    const { snapshot, choice } = fixture();
    snapshot.dispatch!.lines = [{ orderLineId: gid('LineItem'), quantity: 2 }];
    expect(
      publishingBlocker(snapshot, choice, [choice.capability]),
    ).not.toBeNull();
  });
  it('verifies one new exact shipment independently and rejects duplicates, changed lines, tracking and cancellations', () => {
    const { snapshot, choice } = fixture();
    const shipment = {
      id: gid('Fulfillment'),
      fulfillmentOrderIds: [gid('FulfillmentOrder')],
      status: 'SUCCESS',
      locationId: gid('Location'),
      lines: [{ orderLineId: gid('LineItem'), quantity: 1 }],
      tracking: snapshot.dispatch!.tracking,
    };
    const after = {
      ...snapshot,
      id: randomUUID(),
      work: snapshot.work.map((w) => ({
        ...w,
        lines: w.lines.map((l) => ({ ...l, remaining: l.remaining - 1 })),
      })),
      shipments: [shipment],
    };
    expect(publishingVerified(snapshot, choice, after)).toBe(true);
    expect(
      publishingVerified(snapshot, choice, {
        ...after,
        shipments: [shipment, { ...shipment, id: gid('Fulfillment', 2) }],
      }),
    ).toBe(false);
    expect(
      publishingVerified(snapshot, choice, {
        ...after,
        shipments: [
          {
            ...shipment,
            lines: [{ orderLineId: gid('LineItem'), quantity: 2 }],
          },
        ],
      }),
    ).toBe(false);
    expect(
      publishingVerified(snapshot, choice, {
        ...after,
        shipments: [
          {
            ...shipment,
            tracking: [{ ...shipment.tracking[0]!, number: 'another' }],
          },
        ],
      }),
    ).toBe(false);
    expect(
      publishingVerified(snapshot, choice, { ...after, cancelled: true }),
    ).toBe(false);
    expect(
      publishingVerified(snapshot, choice, { ...after, complete: false }),
    ).toBe(false);
  });
});
