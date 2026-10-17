import type {
  ExternalId,
  FulfillmentSnapshot,
  Page,
  PageQuery,
  WriteReceipt,
} from './capabilities.js';

interface FulfillmentRecoveryInput {
  orderId: string;
  fulfillmentOrderId: string;
  expectedRevision: string;
  holdId?: string;
  locationId?: string;
}

/** Fulfillment reads and recovery, dispatch and tracking writes. */
export interface FulfillmentCapabilities {
  'fulfillment.hold.release': {
    input: FulfillmentRecoveryInput;
    output: WriteReceipt;
  };
  'fulfillment.open': { input: FulfillmentRecoveryInput; output: WriteReceipt };
  'fulfillment.move': { input: FulfillmentRecoveryInput; output: WriteReceipt };
  /** Publishes a persisted, approved physical dispatch once against exact provider work lines. */
  'fulfillment.shipment.create': {
    input: { operationId: string; orderId: string; expectedRevision: string };
    output: WriteReceipt;
  };
  /** Publishes persisted tracking and notification choices for an exact existing shipment. */
  'fulfillment.tracking.update': {
    input: { operationId: string; orderId: string; expectedRevision: string };
    output: WriteReceipt;
  };
  'fulfillment.read': {
    input: PageQuery & { order?: ExternalId };
    output: Page<FulfillmentSnapshot>;
  };
  'fulfillment.retry': {
    input: { fulfillment: ExternalId; expectedRevision: string };
    output: WriteReceipt;
  };
}
