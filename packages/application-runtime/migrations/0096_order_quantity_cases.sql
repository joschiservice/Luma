-- Order line quantities that still differ between an order's sources open their own case class.
ALTER TABLE exceptions DROP CONSTRAINT exceptions_document_check1;
ALTER TABLE exceptions ADD CONSTRAINT exceptions_class_check
 CHECK(COALESCE(document->>'exceptionClass' IN ('sync_failure','stuck_fulfillment','inventory_mismatch',
  'order_quantity_mismatch','workflow_failure'),false));

-- Scheduled detection finds orders whose sources differ without scanning every order.
CREATE INDEX orders_list_differing ON orders_list(tenant_id,comparison_read_at,entity_id)
 WHERE selected AND comparison_raw='different';
