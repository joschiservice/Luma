import type { ProviderSimulator } from '@luma/simulator-core';

import { seedCatalog } from './catalog.js';
import { deleteCustomer } from './customers.js';
import { drift, handle, identify, rateLimit, unauthorized } from './http.js';
import {
  cancelOrder,
  changeShippingMethod,
  markPaid,
  placeOrder,
  shipOrder,
  unpackOrder,
} from './orders.js';
import {
  confirmPurchaseOrder,
  placePurchaseOrder,
  receivePurchaseOrder,
  setSupplierProfile,
} from './purchasing.js';
import type { JtlContext } from './records.js';
import { countStock } from './stock.js';
import type { JtlCommand, JtlCommandResult, JtlConfig } from './types.js';

export { readOrder, openOrders } from './orders.js';

export { supplierEvents } from './purchasing.js';

export { kinds } from './records.js';

// A host can serve this ERP model through another provider's API, such as Cin7's.
export type {
  CustomerRecord,
  ItemRecord,
  NoteRecord,
  OrderRecord,
  PurchaseOrderRecord,
  SupplierRecord,
} from './records.js';

export { itemsPage, readItemStock } from './stock.js';

export type { ItemStock } from './stock.js';

export * from './types.js';

/** Applies a merchant, integration, warehouse or supplier action; refusals throw `JtlError`. */
async function command(
  context: JtlContext,
  value: JtlCommand,
): Promise<JtlCommandResult> {
  switch (value.kind) {
    case 'seed-catalog':
      await seedCatalog(context, value.items, value.suppliers);

      return { id: 'catalog' };
    case 'order':
      return placeOrder(context, value);
    case 'paid':
      return markPaid(context, value.id);
    case 'cancel':
      return cancelOrder(context, value.id);
    case 'delete-customer':
      return deleteCustomer(context, value.id);
    case 'ship':
      return shipOrder(context, value);
    case 'unpack':
      return unpackOrder(context, value.id);
    case 'stock':
      await countStock(context, value.itemId, value.warehouse, value.quantity);

      return { id: value.itemId };
    case 'shipping-method':
      return changeShippingMethod(context, value.id, value.shippingMethodId);
    case 'purchase-order':
      return placePurchaseOrder(context, value);
    case 'purchase-order-confirm':
      return confirmPurchaseOrder(context, value);
    case 'purchase-order-receive':
      return receivePurchaseOrder(context, value);
    case 'supplier-profile':
      return setSupplierProfile(context, value.supplierId, value.profile);
  }
}

/** The simulated JTL-Wawi ERP API 2.2 with its merchant, warehouse and supplier actions. */
export const jtl: ProviderSimulator<JtlConfig, JtlCommand, JtlCommandResult> = {
  kind: 'jtl',
  table: 'sim_jtl_records',
  identify,
  handle,
  command,
  unauthorized,
  drift,
  rateLimit,
};
