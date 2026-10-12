import { payExchangeBalance } from './exchanges.js';
import { readLevel, writeLevel } from './inventory.js';
import { editOrder } from './order-edits.js';
import { cancelOrder, createOrder, holdOrder, markPaid } from './orders.js';
import {
  all,
  type CustomerData,
  gid,
  insert,
  type InventoryItemData,
  type InventoryLevelData,
  iso,
  levelGid,
  levelId,
  load,
  location,
  minorUnits,
  nextId,
  notify,
  type ProductData,
  type ProductVariantData,
  save,
  type ShopifyContext,
} from './records.js';
import {
  approveReturn,
  closeReturn,
  declineReturn,
  receiveReturn,
  refundReturn,
  requestReturn,
  settleRefund,
} from './returns.js';
import { fulfillOrder, shipmentStatus } from './shipments.js';
import { recordInventoryTransfer } from './transfers.js';
import type {
  ShopifyCommand,
  ShopifyCommandResult,
  ShopifyCustomerInput,
  ShopifySeedProduct,
} from './types.js';

type Command<K extends ShopifyCommand['kind']> = Extract<
  ShopifyCommand,
  { kind: K }
>;

/**
 * Applies a merchant, customer or integration action at the context's simulation time and
 * sends the webhooks Shopify would send. Fails without changes when the action is not
 * allowed in the current state.
 */
export function command(
  context: ShopifyContext,
  value: ShopifyCommand,
): Promise<ShopifyCommandResult> {
  switch (value.kind) {
    case 'inventory-transfer':
      return recordInventoryTransfer(context, value.transfer);
    case 'seed-catalog':
      return seedCatalog(context, value.products);
    case 'customer':
      return createCustomer(context, value.customer);
    case 'order':
      return createOrder(context, value);
    case 'order-edit':
      return editOrder(context, value);
    case 'paid':
      return markPaid(context, value);
    case 'exchange-pay':
      return payExchangeBalance(context, value.order);
    case 'cancel':
      return cancelOrder(context, value);
    case 'hold':
    case 'release':
      return holdOrder(context, value);
    case 'stock':
    case 'available':
      return setStock(context, value);
    case 'fulfill':
      return fulfillOrder(context, value);
    case 'shipment-status':
      return shipmentStatus(context, value);
    case 'return':
      return requestReturn(context, value);
    case 'return-approve':
      return approveReturn(context, value);
    case 'return-decline':
      return declineReturn(context, value);
    case 'return-receive':
      return receiveReturn(context, value);
    case 'return-close':
      return closeReturn(context, value);
    case 'refund':
      return refundReturn(context, value);
    case 'refund-settle':
      return settleRefund(context, value);
    case 'product-update':
      return updateProduct(context, value);
  }
}

/**
 * Bulk-imports new products with their variants, inventory items and stock levels in one
 * write. Imports happen before any app subscribes, so they send no webhooks.
 */
async function seedCatalog(
  context: ShopifyContext,
  products: ShopifySeedProduct[],
): Promise<ShopifyCommandResult> {
  const existing = await context.store.getMany(
    'Product',
    products.map((product) => product.id),
  );
  if (existing.length)
    throw new Error(`Product ${existing[0]?.id ?? ''} already exists`);
  const publishedAt = iso(context.now);
  const records = [];
  for (const product of products) {
    if (!product.variants.length)
      throw new Error(`Product ${product.id} needs a variant`);
    const prices = product.variants.map((variant) => minorUnits(variant.price));
    records.push(
      insert(context, 'Product', product.id, {
        title: product.title,
        vendor: product.vendor,
        productType: product.productType,
        status: 'ACTIVE',
        publishedAt: product.published ? publishedAt : null,
        minPrice: Math.min(...prices),
      } satisfies ProductData),
    );
    product.variants.forEach((variant, index) => {
      records.push(
        insert(
          context,
          'ProductVariant',
          variant.id,
          {
            product: product.id,
            sku: variant.sku,
            title: variant.title,
            price: prices[index] ?? 0,
            barcode: variant.barcode,
          } satisfies ProductVariantData,
          { parent: product.id, key: variant.sku },
        ),
        insert(
          context,
          'InventoryItem',
          variant.id,
          {
            variant: variant.id,
            product: product.id,
            sku: variant.sku,
            tracked: true,
          } satisfies InventoryItemData,
          { key: variant.sku },
        ),
      );
      for (const [place, onHand] of Object.entries(variant.stock)) {
        if (!location(context, place))
          throw new Error(`Location ${place} not found`);
        records.push(
          insert(
            context,
            'InventoryLevel',
            levelId(variant.id, place),
            {
              item: variant.id,
              location: place,
              onHand,
              committed: 0,
            } satisfies InventoryLevelData,
            { parent: variant.id, key: place },
          ),
        );
      }
    });
  }
  await context.store.putMany(records);
  const first = products[0]?.id ?? '';

  return { id: first, gid: gid('Product', first) };
}

/** Creates a customer account; Shopify requires a unique email address. */
async function createCustomer(
  context: ShopifyContext,
  input: ShopifyCustomerInput,
): Promise<ShopifyCommandResult> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email))
    throw new Error('Invalid email address');
  if (await context.store.count({ kind: 'Customer', key: email }))
    throw new Error('Email has already been taken');
  const id = await nextId(context);
  await save(
    context,
    'Customer',
    id,
    {
      firstName: input.firstName,
      lastName: input.lastName,
      email,
      phone: input.phone,
      address: {
        address1: input.address.address1,
        city: input.address.city,
        zip: input.address.zip,
        countryCode: input.address.countryCode,
      },
      state: 'ENABLED',
      tags: [],
      numberOfOrders: 0,
      amountSpent: 0,
    } satisfies CustomerData,
    { key: email, created: true },
  );
  notify(context, 'customers/create', 'Customer', id);

  return { id, gid: gid('Customer', id) };
}

/** Changes a product's status, publication or the price of all its variants. */
async function updateProduct(
  context: ShopifyContext,
  value: Command<'product-update'>,
): Promise<ShopifyCommandResult> {
  const product = await load<ProductData>(context, 'Product', value.product);
  const data = { ...product.data };
  if (value.price !== undefined) {
    const price = minorUnits(value.price);
    data.minPrice = price;
    for (const variant of await all<ProductVariantData>(context, {
      kind: 'ProductVariant',
      parent: product.id,
    }))
      await save(context, 'ProductVariant', variant.id, {
        ...variant.data,
        price,
      });
  }
  if (value.status) data.status = value.status;
  if (value.published !== undefined)
    data.publishedAt = value.published
      ? (data.publishedAt ?? iso(context.now))
      : null;
  await save(context, 'Product', product.id, data);
  notify(context, 'products/update', 'Product', product.id, {
    title: data.title,
    status: data.status.toLowerCase(),
  });

  return { id: product.id, gid: gid('Product', product.id) };
}

/**
 * Sets on-hand stock, or available stock as a stock sync does while keeping committed units.
 * Stocking a tracked item at a new location connects it there.
 */
async function setStock(
  context: ShopifyContext,
  value: Command<'stock'> | Command<'available'>,
): Promise<ShopifyCommandResult> {
  if (
    !Number.isSafeInteger(value.quantity) ||
    value.quantity < 0 ||
    value.quantity > 1_000_000_000
  )
    throw new Error('Stock must be a whole number from 0 to 1,000,000,000');
  if (!location(context, value.location))
    throw new Error(`Location ${value.location} not found`);
  await load<InventoryItemData>(context, 'InventoryItem', value.variant);
  const level = await readLevel(context, value.variant, value.location);
  const committed = level?.data.committed ?? 0;
  await writeLevel(context, {
    ...level?.data,
    item: value.variant,
    location: value.location,
    committed,
    onHand:
      value.kind === 'stock'
        ? value.quantity
        : value.quantity +
          committed +
          (level?.data.reserved ?? 0) +
          (level?.data.damaged ?? 0) +
          (level?.data.qualityControl ?? 0) +
          (level?.data.safetyStock ?? 0),
  });

  return {
    id: levelId(value.variant, value.location),
    gid: levelGid(value.variant, value.location),
  };
}
