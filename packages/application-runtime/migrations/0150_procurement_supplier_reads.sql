-- A supplier's page reads that supplier's orders newest first; summaries read follow-ups for a
-- bounded set of orders. Both would otherwise scan the tenant's rows.
CREATE INDEX procurement_orders_supplier
 ON procurement_purchase_orders(tenant_id,supplier_id,created_at DESC,id);
CREATE INDEX procurement_follow_ups_order
 ON procurement_follow_ups(tenant_id,purchase_order_id,responded_at);
