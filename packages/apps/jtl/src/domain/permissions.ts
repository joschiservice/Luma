/** Permissions the JTL app declares for its write capabilities. */
export const jtlPermissions = {
  restock: 'jtl:returns.restock',
  purchaseOrders: 'jtl:purchase_orders.submit',
  shippingMethod: 'jtl:orders.shipping_method.write',
  returns: 'jtl:returns.create',
} as const;
