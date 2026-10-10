ALTER TABLE orders_list
 ADD COLUMN comparison_signature text,
 ADD COLUMN comparison_changed_at timestamptz,
 ADD COLUMN comparison_raw text NOT NULL DEFAULT 'inconclusive' CHECK(comparison_raw IN ('matching','different','inconclusive')),
 ADD COLUMN comparison_read_at timestamptz,
 ADD COLUMN comparison_latest_read_at timestamptz,
 ADD COLUMN comparison_confirm_after timestamptz,
 ADD COLUMN comparison_differences jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Rebuild safely under owner locks; old comparisons cannot claim confirmation during rollout.
INSERT INTO orders_list_backfill(tenant_id)
 SELECT DISTINCT tenant_id FROM orders_projections
 ON CONFLICT(tenant_id) DO UPDATE SET after_id=NULL;
