import { supplierProfiles } from '@luma/simulator-jtl';
import { shopifyHoldReasons } from '@luma/simulator-shopify';
import { z } from 'zod';

const id = z.string().regex(/^[1-9]\d{0,11}$/);
const quantity = z.number().int().min(0).max(2_147_483_647);
const positive = z.number().int().min(1).max(100_000);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));
const lineQuantities = z
  .array(z.object({ lineItem: id, quantity: positive }))
  .min(1)
  .max(250);

/**
 * Manual Shopify actions accepted from the control API. Catalog seeding is internal and not
 * accepted here.
 */
export const shopifyCommandSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('customer'),
    customer: z.object({
      firstName: z.string().min(1).max(80),
      lastName: z.string().min(1).max(80),
      email: z.string().email(),
      phone: z.string().max(40),
      address: z.object({
        address1: z.string().max(120),
        city: z.string().max(80),
        zip: z.string().max(20),
        countryCode: z.string().length(2),
      }),
    }),
  }),
  z.object({
    kind: z.literal('order-edit'),
    order: id,
    lines: z
      .array(z.object({ lineItem: id, quantity }))
      .min(1)
      .max(500),
  }),
  z.object({ kind: z.literal('paid'), order: id }),
  z.object({
    kind: z.literal('cancel'),
    order: id,
    reason: z.enum(['CUSTOMER', 'DECLINED', 'FRAUD', 'INVENTORY', 'OTHER']),
  }),
  z.object({
    kind: z.literal('hold'),
    order: id,
    reason: z.enum(shopifyHoldReasons),
  }),
  z.object({ kind: z.literal('release'), order: id }),
  z.object({ kind: z.literal('stock'), variant: id, location: id, quantity }),
  z.object({
    kind: z.literal('available'),
    variant: id,
    location: id,
    quantity,
  }),
  z.object({
    kind: z.literal('fulfill'),
    order: id,
    lines: lineQuantities.optional(),
    carrier: z.string().min(1).max(40).default('DHL'),
    trackingNumber: z.string().min(1).max(60).default('MANUAL-1'),
    trackingUrl: z
      .string()
      .url()
      .default('https://tracking.example.test/manual'),
  }),
  z.object({
    kind: z.literal('shipment-status'),
    fulfillment: id,
    status: z.enum([
      'IN_TRANSIT',
      'OUT_FOR_DELIVERY',
      'DELIVERED',
      'DELAYED',
      'FAILURE',
    ]),
  }),
  z.object({
    kind: z.literal('return'),
    order: id,
    lines: lineQuantities,
    reason: z.string().min(1).max(120).default('Changed my mind'),
  }),
  z.object({
    kind: z.enum([
      'return-approve',
      'return-decline',
      'return-receive',
      'return-close',
      'refund-settle',
    ]),
    order: id,
  }),
  z.object({
    kind: z.literal('refund'),
    order: id,
    outcome: z.enum(['success', 'pending', 'failure']),
  }),
  z.object({
    kind: z.literal('product-update'),
    product: id,
    price: z
      .string()
      .regex(/^\d{1,9}\.\d{2}$/)
      .optional(),
    status: z.enum(['ACTIVE', 'DRAFT', 'ARCHIVED']).optional(),
    published: z.boolean().optional(),
  }),
]);

/** Manual ERP, warehouse and supplier actions accepted from the control API. */
export const jtlCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('paid'), id }),
  z.object({ kind: z.literal('cancel'), id }),
  z.object({ kind: z.literal('delete-customer'), id }),
  z.object({
    kind: z.literal('ship'),
    id,
    warehouse: id,
    lines: z
      .array(z.object({ lineId: id, quantity: positive }))
      .min(1)
      .max(250)
      .optional(),
    trackingNumber: z.string().min(1).max(60).default('MANUAL-1'),
    trackingUrl: z
      .string()
      .url()
      .default('https://tracking.example.test/manual'),
  }),
  z.object({ kind: z.literal('stock'), itemId: id, warehouse: id, quantity }),
  z.object({
    kind: z.literal('shipping-method'),
    id,
    shippingMethodId: z.enum(['7', '8', '9']),
  }),
  z.object({
    kind: z.literal('purchase-order'),
    supplierId: id,
    deliveryDate: date,
    lines: z
      .array(
        z.object({
          itemId: id,
          quantity: z.number().positive().max(1_000_000),
        }),
      )
      .min(1)
      .max(500),
  }),
  z.object({
    kind: z.literal('purchase-order-confirm'),
    orderId: id,
    lines: z
      .array(
        z.object({
          lineItemId: id,
          quantity: z.number().min(0).max(1_000_000),
          deliveryDate: date,
        }),
      )
      .min(1)
      .max(500)
      .optional(),
  }),
  z.object({
    kind: z.literal('purchase-order-receive'),
    orderId: id,
    warehouse: id.optional(),
    lines: z
      .array(
        z.object({
          lineItemId: id,
          quantity: z.number().positive().max(1_000_000),
        }),
      )
      .min(1)
      .max(500),
  }),
  z.object({
    kind: z.literal('supplier-profile'),
    supplierId: id,
    profile: z.enum(supplierProfiles),
  }),
]);

const mailAddress = z.object({
  address: z.string().email().max(254),
  name: z.string().max(120).optional(),
});

/** Mailbox actions accepted from the control API: seeding and mail from external senders. */
export const gmailCommandSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('seed-mailbox'),
    address: z.string().email().max(254),
    name: z.string().min(1).max(120),
    labels: z.array(z.string().min(1).max(100)).max(50).optional(),
  }),
  z.object({
    kind: z.literal('deliver'),
    from: mailAddress,
    to: z.array(mailAddress).min(1).max(20).optional(),
    cc: z.array(mailAddress).max(20).optional(),
    subject: z.string().max(250).optional(),
    text: z.string().max(100_000),
    html: z.string().max(200_000).optional(),
    threadOf: z.string().min(1).max(300).optional(),
    inReplyTo: z.string().min(1).max(300).optional(),
    messageId: z
      .string()
      .regex(/^<?[^<>\s@]+@[^<>\s@]+>?$/)
      .optional(),
    labels: z.array(z.string().min(1).max(100)).max(20).optional(),
    attachments: z
      .array(
        z.object({
          filename: z.string().min(1).max(200),
          mimeType: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/),
          base64: z
            .string()
            .max(14_000_000)
            .regex(/^[A-Za-z0-9+/]*={0,2}$/),
        }),
      )
      .max(10)
      .optional(),
  }),
]);
