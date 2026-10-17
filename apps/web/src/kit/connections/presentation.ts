import type {
  InstallationCapability,
  InstalledConnection,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import type { OperationalState } from '@luma/ui/components/primitives/state';
import { connectionHealthLabel } from '@luma/ui/lib/connection-health';

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

export const capabilities = localized({
  'orders.read': m.connections_capability_orders_read,
  'products.read': m.connections_capability_products_read,
  'inventory.read': m.connections_capability_inventory_read,
  'inventory.transfers.read': m.connections_capability_inventory_transfers_read,
  'inventory.shipments.read': m.connections_capability_inventory_shipments_read,
  'inventory.available.reconcile': m.connections_capability_inventory_reconcile,
  'fulfillment.read': m.connections_capability_fulfillment_read,
  'fulfillment.hold.release': m.connections_capability_fulfillment_hold_release,
  'fulfillment.open': m.connections_capability_fulfillment_open,
  'fulfillment.move': m.connections_capability_fulfillment_move,
  'orders.quantity.edit': m.connections_capability_orders_quantity_edit,
  'orders.quantity.update': m.connections_capability_orders_quantity_update,
  'fulfillment.shipment.create':
    m.connections_capability_fulfillment_shipment_create,
  'fulfillment.tracking.update':
    m.connections_capability_fulfillment_tracking_update,
  'customers.read': m.connections_capability_customers_read,
  'returns.read': m.connections_capability_returns_read,
  'orders.shipping-method.read': m.connections_capability_shipping_method_read,
  'orders.shipping-method.write':
    m.connections_capability_shipping_method_write,
  'suppliers.read': m.connections_capability_suppliers_read,
  'purchase-orders.read': m.connections_capability_purchase_orders_read,
  'purchase-orders.submit': m.connections_capability_purchase_orders_submit,
  'purchase-orders.revise': m.connections_capability_purchase_orders_revise,
  'messages.read': m.connections_capability_messages_read,
  'message-threads.read': m.connections_capability_message_threads_read,
  'message-attachments.read': m.connections_capability_message_attachments_read,
  'messages.send': m.connections_capability_messages_send,
  'returns.options.read': m.connections_capability_returns_options_read,
  'returns.created.read': m.connections_capability_returns_created_read,
  'returns.create': m.connections_capability_returns_create,
  'returns.settlement.quote.read': m.connections_capability_returns_quote,
  'returns.settlement.proof.read': m.connections_capability_returns_proof,
  'returns.exchange.options.read': m.connections_capability_exchange_options,
  'returns.exchange.quote.read': m.connections_capability_exchange_quote,
  'returns.exchange.proof.read': m.connections_capability_exchange_proof,
  'returns.exchange.price.read': m.connections_capability_exchange_price,
  'returns.exchange.reservation.read':
    m.connections_capability_exchange_reservation,
  'returns.exchange.request': m.connections_capability_exchange_request,
  'returns.exchange.process': m.connections_capability_exchange_process,
  'returns.exchange.cancel': m.connections_capability_exchange_cancel,
  'returns.exchange.release': m.connections_capability_exchange_release,
  'returns.refund': m.connections_capability_returns_refund,
  'returns.restock': m.connections_capability_returns_restock,
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
  if (kind === 'starshipit') return 'Starshipit';

  return kind;
}

/** Whether a capability only reads; every other capability changes data in the connected system. */
function isReadCapability(capability: string) {
  return capability.endsWith('.read');
}

/** The one state a connection shows, with a label and whether someone needs to act. */
export interface ConnectionState {
  state: OperationalState;
  label: string;
  attention: boolean;
}

const lifecycleStates = {
  pending: 'waiting',
  active: 'verified',
  degraded: 'attention',
  revoked: 'error',
  disconnected: 'idle',
} satisfies Record<InstalledConnection['status'], OperationalState>;

/**
 * Combines installation validation and operational health into one state. Shared health wins,
 * so Home, Data sync and Apps agree, except before validation: a pending connection can't read
 * anything yet, so it says so instead of reporting an import.
 */
export function connectionState(
  connection: Pick<InstalledConnection, 'status' | 'coverage'>,
): ConnectionState {
  const health =
    connection.status !== 'pending' && connection.coverage?.health
      ? connectionHealthLabel(connection.coverage.health)
      : {
          state: lifecycleStates[connection.status],
          label: statuses[connection.status],
        };

  return {
    ...health,
    attention:
      ['pending', 'degraded', 'revoked'].includes(connection.status) ||
      health.state === 'error' ||
      health.state === 'attention',
  };
}

/**
 * Splits a connection's requested capabilities into those Luma may use now, by reads and
 * changes, and those it can't use. Only an active connection of an available app permits
 * anything, and only capabilities that are both requested and confirmed by the provider.
 */
export function connectionAccess(
  connection: Pick<InstalledConnection, 'status' | 'permissions' | 'granted'>,
  appAvailable = true,
) {
  const permitted =
    connection.status === 'active' && appAvailable
      ? connection.permissions.filter((item) =>
          connection.granted.includes(item),
        )
      : [];
  const reads = permitted.filter(isReadCapability);
  const changes = permitted.filter((item) => !isReadCapability(item));

  return {
    reads,
    changes,
    unavailable: connection.permissions.filter(
      (item) => !permitted.includes(item),
    ),
    level: changes.length
      ? ('read_write' as const)
      : reads.length
        ? ('read_only' as const)
        : ('none' as const),
  };
}

const targetLabels: Record<string, () => string> = {
  shop: m.connections_target_shop,
  jtlTenantId: m.connections_target_tenant,
  baseUrl: m.connections_target_base_url,
  appId: m.connections_target_app_id,
  appVersion: m.connections_target_app_version,
  accountId: m.connections_target_account,
  emailAddress: m.connections_target_mailbox,
};

// The field that names the account a person recognizes, in order of preference.
const primaryTargets = [
  'shop',
  'emailAddress',
  'baseUrl',
  'jtlTenantId',
  'accountId',
];

/**
 * Names the account a connection reaches: its most recognizable identifier, such as the shop
 * hostname or mailbox, and every target field with a label. Unknown fields keep their key.
 */
export function connectionTarget(target: InstalledConnection['target']) {
  const fields = Object.entries(target)
    .filter(([key]) => key !== 'kind')
    .map(([key, value]) => ({
      key,
      label: targetLabels[key]?.() ?? key,
      value,
    }));
  const primary =
    primaryTargets
      .map((key) => fields.find((field) => field.key === key))
      .find(Boolean) ?? fields[0];

  return { primary: primary?.value, fields };
}
