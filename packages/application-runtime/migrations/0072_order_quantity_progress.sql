-- Recompute cached comparisons and progress from current units and shipped evidence.
-- Legacy reads remain available until the existing resumable rebuilder finishes.
INSERT INTO orders_list_backfill(tenant_id)
 SELECT DISTINCT tenant_id FROM orders_projections
 ON CONFLICT(tenant_id) DO UPDATE SET after_id=NULL;
