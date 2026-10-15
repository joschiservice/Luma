-- A storefront that stops following its stock authority's changes opens one case per store.
ALTER TABLE exceptions DROP CONSTRAINT exceptions_class_check;
ALTER TABLE exceptions ADD CONSTRAINT exceptions_class_check
 CHECK(COALESCE(document->>'exceptionClass' IN ('sync_failure','stuck_fulfillment','inventory_mismatch',
  'order_quantity_mismatch','stock_sync_stall','workflow_failure'),false));
