import { m } from '@luma/i18n/messages';

/** Operator labels for provider capabilities, detector results and evidence kinds. */
export const operatorCodeMessages: Record<string, () => string> = {
  'order.shipping_method.update':
    m.vocabulary_operator_orders_shipping_method_write,
  inventory: m.vocabulary_operator_inventory,
  order_line: m.vocabulary_operator_order_line,
  product: m.vocabulary_operator_product,
  customer: m.vocabulary_operator_customer,
  return: m.vocabulary_operator_return,
  refund: m.vocabulary_operator_refund,
  supplier: m.vocabulary_operator_supplier,
  purchase_order: m.vocabulary_operator_purchase_order,
  message: m.vocabulary_operator_message,
  return_reason: m.vocabulary_operator_return_reason,
  inventory_transfer: m.vocabulary_operator_inventory_transfer,
  inventory_shipment: m.vocabulary_operator_inventory_shipment,
  workflow_run: m.vocabulary_operator_workflow_run,
  connection: m.vocabulary_operator_connection,

  authentication: m.vocabulary_operator_authentication,
  permission_denied: m.vocabulary_operator_permission_denied,
  invalid_response: m.vocabulary_operator_invalid_response,
  export_unavailable: m.vocabulary_operator_export_unavailable,
  unsupported_capability: m.vocabulary_operator_unsupported_capability,
  unsupported_version: m.vocabulary_operator_unsupported_version,
  transient: m.vocabulary_operator_transient,
  timeout: m.vocabulary_operator_timeout,
  rate_limited: m.vocabulary_operator_rate_limited,
  internal: m.vocabulary_operator_internal,
  unavailable: m.vocabulary_operator_unavailable,
  invalid_input: m.vocabulary_operator_invalid_input,
  not_found: m.vocabulary_operator_not_found,
  conflict: m.vocabulary_operator_conflict,

  'orders.read': m.vocabulary_operator_orders_read,
  'products.read': m.vocabulary_operator_products_read,
  'inventory.read': m.vocabulary_operator_inventory_read,
  'inventory.transfers.read': m.vocabulary_operator_inventory_transfers_read,
  'inventory.shipments.read': m.vocabulary_operator_inventory_shipments_read,
  'inventory.available.reconcile':
    m.vocabulary_operator_inventory_available_reconcile,
  'fulfillment.read': m.vocabulary_operator_fulfillment_read,
  'fulfillment.hold.release': m.vocabulary_operator_fulfillment_hold_release,
  'fulfillment.open': m.vocabulary_operator_fulfillment_open,
  'fulfillment.move': m.vocabulary_operator_fulfillment_move,
  'fulfillment.shipment.create':
    m.vocabulary_operator_fulfillment_shipment_create,
  'fulfillment.tracking.update':
    m.vocabulary_operator_fulfillment_tracking_update,
  'orders.quantity.edit': m.vocabulary_operator_orders_quantity_edit,
  'orders.quantity.update': m.vocabulary_operator_orders_quantity_update,
  'customers.read': m.vocabulary_operator_customers_read,
  'returns.read': m.vocabulary_operator_returns_read,
  'orders.shipping-method.read':
    m.vocabulary_operator_orders_shipping_method_read,
  'orders.shipping-method.write':
    m.vocabulary_operator_orders_shipping_method_write,
  'suppliers.read': m.vocabulary_operator_suppliers_read,
  'purchase-orders.read': m.vocabulary_operator_purchase_orders_read,
  'purchase-orders.submit': m.vocabulary_operator_purchase_orders_submit,
  'purchase-orders.revise': m.vocabulary_operator_purchase_orders_revise,
  'messages.read': m.vocabulary_operator_messages_read,
  'message-threads.read': m.vocabulary_operator_message_threads_read,
  'message-attachments.read': m.vocabulary_operator_message_attachments_read,
  'messages.send': m.vocabulary_operator_messages_send,
  'procurement.purchase-order.create':
    m.vocabulary_operator_procurement_purchase_order_create,
  'procurement.purchase-order.transition':
    m.vocabulary_operator_procurement_purchase_order_transition,
  within_tolerance: m.vocabulary_operator_within_tolerance,
  complete_scan_after_detection:
    m.vocabulary_operator_complete_scan_after_detection,
  sync_stream: m.vocabulary_operator_sync_stream,
  sku: m.vocabulary_operator_sku,
  location: m.vocabulary_operator_location,
  inventory_position: m.vocabulary_operator_inventory_position,
  order: m.vocabulary_operator_order,
  fulfillment: m.vocabulary_operator_fulfillment,
  'returns.options.read': m.vocabulary_operator_returns_options_read,
  'returns.created.read': m.vocabulary_operator_returns_created_read,
  'returns.create': m.vocabulary_operator_returns_create,
  'returns.exchange.options.read':
    m.vocabulary_operator_returns_exchange_options_read,
  'returns.exchange.quote.read':
    m.vocabulary_operator_returns_exchange_quote_read,
  'returns.exchange.proof.read':
    m.vocabulary_operator_returns_exchange_proof_read,
  'returns.exchange.price.read':
    m.vocabulary_operator_returns_exchange_price_read,
  'returns.exchange.reservation.read':
    m.vocabulary_operator_returns_exchange_reservation_read,
  'returns.exchange.request': m.vocabulary_operator_returns_exchange_request,
  'returns.exchange.process': m.vocabulary_operator_returns_exchange_process,
  'returns.exchange.cancel': m.vocabulary_operator_returns_exchange_cancel,
  'returns.exchange.release': m.vocabulary_operator_returns_exchange_release,
  'returns.settlement.quote.read':
    m.vocabulary_operator_returns_settlement_quote_read,
  'returns.settlement.proof.read':
    m.vocabulary_operator_returns_settlement_proof_read,
  'returns.refund': m.vocabulary_operator_returns_refund,
  'returns.restock': m.vocabulary_operator_returns_restock,
  propagation_pending: m.vocabulary_operator_propagation_pending,
  oversell_risk: m.vocabulary_operator_oversell_risk,
  quantity_mismatch: m.vocabulary_operator_quantity_mismatch,
  stale_evidence: m.vocabulary_operator_stale_evidence,
  unknown_quantity: m.vocabulary_operator_unknown_quantity,
  incomplete_evidence: m.vocabulary_operator_incomplete_evidence,
  inconclusive_authority: m.vocabulary_operator_inconclusive_authority,
  incomparable_units: m.vocabulary_operator_incomparable_units,
  hard_read_failure: m.vocabulary_operator_hard_read_failure,
  retry_window_exhausted: m.vocabulary_operator_retry_window_exhausted,
  retry_window_open: m.vocabulary_operator_retry_window_open,
  inactive_connection: m.vocabulary_operator_inactive_connection,
  access_lost: m.vocabulary_operator_access_lost,
  read_succeeded: m.vocabulary_operator_read_succeeded,
  unclassified_error: m.vocabulary_operator_unclassified_error,
  tenant_mismatch: m.vocabulary_operator_tenant_mismatch,
  progress_timeout: m.vocabulary_operator_progress_timeout,
  progress_within_window: m.vocabulary_operator_progress_within_window,
  operation_failed: m.vocabulary_operator_operation_failed,
  terminal_operation: m.vocabulary_operator_terminal_operation,
  no_remaining_work: m.vocabulary_operator_no_remaining_work,
  explicit_exemption: m.vocabulary_operator_explicit_exemption,
  unknown_eligibility: m.vocabulary_operator_unknown_eligibility,
  unknown_progress: m.vocabulary_operator_unknown_progress,
  unknown_status: m.vocabulary_operator_unknown_status,
  unmapped_fulfillment: m.vocabulary_operator_unmapped_fulfillment,
  invalid_quantity: m.vocabulary_operator_invalid_quantity,
  unmapped_sku: m.vocabulary_operator_unmapped_sku,
  incomparable_pool: m.vocabulary_operator_incomparable_pool,
  incomparable_basis: m.vocabulary_operator_incomparable_basis,
  observation_skew: m.vocabulary_operator_observation_skew,
  future_evidence: m.vocabulary_operator_future_evidence,
  ambiguous_projection: m.vocabulary_operator_ambiguous_projection,
  terminal_failure: m.vocabulary_operator_terminal_failure,
  retry_pending: m.vocabulary_operator_retry_pending,
  healthy_workflow: m.vocabulary_operator_healthy_workflow,
  intentional_cancellation: m.vocabulary_operator_intentional_cancellation,
  missing_durable_evidence: m.vocabulary_operator_missing_durable_evidence,
  reconciliation_required: m.vocabulary_operator_reconciliation_required,
  quantities_agree: m.vocabulary_operator_quantities_agree,
  unknown_value: m.vocabulary_operator_unknown_value,
};

/** Names a registered code; unknown codes remain an explicit unavailable label. */
export function operatorCodeLabel(code: string) {
  return (
    (
      operatorCodeMessages[code] ?? operatorCodeMessages[code.toLowerCase()]
    )?.() ?? m.common_not_reported()
  );
}
