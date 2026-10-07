/** The scopes each first-party app requests; installing must consent to exactly these. */
export const appScopes = {
  shopify: [
    'orders.read',
    'fulfillment.read',
    'inventory.read',
    'products.read',
    'customers.read',
    'returns.read',
    'actions.propose',
    'actions.execute',
  ],
  jtl: [
    'orders.read',
    'fulfillment.read',
    'inventory.read',
    'products.read',
    'customers.read',
    'procurement.read',
    'actions.propose',
    'actions.execute',
  ],
};
