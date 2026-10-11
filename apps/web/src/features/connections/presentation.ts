import type {
  InstallationCapability,
  InstalledConnection,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';

/** Reads each message when accessed, so labels follow the active language. */
function localized<K extends string>(
  messages: Record<K, () => string>,
): Record<K, string> {
  const labels = {} as Record<K, string>;
  for (const key of Object.keys(messages) as K[])
    Object.defineProperty(labels, key, {
      enumerable: true,
      get: () => messages[key](),
    });

  return labels;
}

export const reads = [
  'orders.read',
  'products.read',
  'inventory.read',
  'fulfillment.read',
] as const;

export const capabilities = localized({
  'orders.read': m.connections_capability_orders_read,
  'products.read': m.connections_capability_products_read,
  'inventory.read': m.connections_capability_inventory_read,
  'inventory.available.reconcile': m.connections_capability_inventory_reconcile,
  'fulfillment.read': m.connections_capability_fulfillment_read,
  'fulfillment.hold.release': m.connections_capability_fulfillment_hold_release,
  'fulfillment.open': m.connections_capability_fulfillment_open,
  'fulfillment.move': m.connections_capability_fulfillment_move,
  'customers.read': m.connections_capability_customers_read,
  'returns.read': m.connections_capability_returns_read,
  'orders.shipping-method.read': m.connections_capability_shipping_method_read,
  'orders.shipping-method.write':
    m.connections_capability_shipping_method_write,
  'suppliers.read': m.connections_capability_suppliers_read,
  'purchase-orders.read': m.connections_capability_purchase_orders_read,
  'purchase-orders.submit': m.connections_capability_purchase_orders_submit,
  'messages.read': m.connections_capability_messages_read,
  'message-threads.read': m.connections_capability_message_threads_read,
  'message-attachments.read': m.connections_capability_message_attachments_read,
  'messages.send': m.connections_capability_messages_send,
} satisfies Record<InstallationCapability, () => string>);

export const statuses = localized({
  pending: m.connections_status_pending,
  active: m.connections_status_active,
  degraded: m.connections_status_degraded,
  disconnected: m.connections_status_disconnected,
  revoked: m.connections_status_revoked,
} satisfies Record<InstalledConnection['status'], () => string>);

/** The system a connection reaches, for messages that name it. */
export function connectionSystem(
  kind: string,
): 'shopify' | 'jtl' | 'cin7' | 'other' {
  if (kind === 'shopify') return 'shopify';
  if (kind.startsWith('jtl')) return 'jtl';
  if (kind.startsWith('cin7')) return 'cin7';

  return 'other';
}

/** The display name of a connection type, such as JTL Cloud. */
export function connectionKindName(kind: string) {
  if (kind === 'shopify') return 'Shopify';
  if (kind === 'jtl-cloud') return 'JTL Cloud';
  if (kind === 'jtl-onprem') return m.connections_kind_jtl_onprem();
  if (kind === 'cin7-core') return 'Cin7 Core';
  if (kind === 'gmail') return 'Gmail';

  return kind;
}
