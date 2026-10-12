-- Plain target columns allow index lookup under forced RLS; receipts remain immutable.
ALTER TABLE shopify_inventory_evidence
 ADD COLUMN inventory_item_id text GENERATED ALWAYS AS (document->>'inventoryItemId') STORED,
 ADD COLUMN location_id text GENERATED ALWAYS AS (document->>'locationId') STORED;
CREATE INDEX shopify_inventory_evidence_target
 ON shopify_inventory_evidence(tenant_id,connection_id,inventory_item_id,location_id,observed_at DESC,id DESC)
 WHERE kind='acceptance';
