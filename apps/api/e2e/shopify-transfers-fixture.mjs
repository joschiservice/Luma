import { correctionFixture } from './shopify-inventory-fixture.mjs';

function transferFixtureData() {
  const created = new Date(Date.now() - 3_600_000).toISOString();

  return {
    id: '1',
    name: 'Move to retired depot',
    status: 'IN_PROGRESS',
    dateCreated: created,
    origin: {
      location: '1',
      name: 'Warehouse before rename',
      snapshottedAt: created,
      address: {
        address1: 'Old street 4',
        address2: null,
        city: 'Hamburg',
        provinceCode: null,
        countryCode: 'DE',
        zip: '20095',
      },
    },
    destination: {
      location: null,
      name: 'Retired depot',
      snapshottedAt: created,
      address: {
        address1: 'Original destination 8',
        address2: null,
        city: 'Berlin',
        provinceCode: null,
        countryCode: 'DE',
        zip: '10115',
      },
    },
    totalQuantity: 10,
    receivedQuantity: 8,
    lines: [
      {
        id: '1',
        inventoryItem: '1',
        title: 'Canvas tote',
        totalQuantity: 10,
        pickedForShipmentQuantity: 0,
        shippableQuantity: 0,
        shippedQuantity: 10,
      },
    ],
    shipments: [
      {
        id: '1',
        name: 'Receiving shipment',
        status: 'PARTIALLY_RECEIVED',
        dateCreated: created,
        dateShipped: created,
        dateReceived: created,
        lineItemTotalQuantity: 10,
        totalAcceptedQuantity: 7,
        totalRejectedQuantity: 1,
        totalReceivedQuantity: 8,
        tracking: {
          arrivesAt: new Date(Date.now() - 60_000).toISOString(),
          company: 'Carrier',
          trackingNumber: 'TRACK-1',
          trackingUrl: 'https://example.test/TRACK-1',
        },
        lines: [
          {
            id: '1',
            inventoryItem: '1',
            quantity: 10,
            acceptedQuantity: 7,
            rejectedQuantity: 1,
            unreceivedQuantity: 2,
          },
        ],
      },
    ],
  };
}

/** Exercises granted reads, canonical identity, history, receiving checks and tenant boundaries through real services. */
export async function transfersFixture(t, origin) {
  const fixture = await correctionFixture(t, origin, { transferReads: true });
  const transfer = transferFixtureData();
  await fixture.recordTransfer(transfer);
  await fixture.syncRecords('inventory.transfers.read', { limit: 100 });
  await fixture.syncRecords('inventory.shipments.read', { limit: 100 });
  const list = await fixture.f.request(
    fixture.f.owner,
    `${fixture.f.base}/inventory/transfers`,
  );
  const item = list.items[0];
  const url = `${fixture.f.base}/inventory/transfers/${item.id}/sources/${item.connectionId}`;

  return { ...fixture, transfer, item, url };
}
