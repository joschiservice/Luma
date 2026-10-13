-- A recorded manual receipt is explicit evidence, distinct from purchasing-system observations.
DO $$
DECLARE constraint_name text;
BEGIN
 SELECT c.conname INTO STRICT constraint_name FROM pg_constraint c
 WHERE c.conrelid='procurement_commitments'::regclass AND c.contype='c'
  AND pg_get_constraintdef(c.oid) LIKE '%purchasing_system%'
  AND pg_get_constraintdef(c.oid) LIKE '%received%';
 EXECUTE format('ALTER TABLE procurement_commitments DROP CONSTRAINT %I',constraint_name);
END $$;
ALTER TABLE procurement_commitments ADD CONSTRAINT procurement_receipt_source CHECK (
 document->>'kind'<>'received' OR document->'source'->>'kind' IN ('purchasing_system','manual_receipt')
);
-- The owner API checks line and cumulative quantity; this guard preserves receipt authority
-- even when an internal caller writes directly through the tenant runtime role.
CREATE FUNCTION procurement_manual_receipt_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.document->>'kind'='received' AND NEW.document->'source'->>'kind'='manual_receipt' THEN
  IF NOT EXISTS (
   SELECT 1 FROM procurement_purchase_orders o
   JOIN procurement_suppliers s ON s.tenant_id=o.tenant_id AND s.id=(o.document->>'supplierId')::uuid
   WHERE o.tenant_id=NEW.tenant_id AND o.id=NEW.purchase_order_id
    AND o.document->>'authority'='luma' AND o.document->>'status'='open'
    AND (s.document->'link' IS NULL OR s.document->'link'='null'::jsonb)
  ) OR EXISTS (
   SELECT 1 FROM procurement_submissions s WHERE s.tenant_id=NEW.tenant_id
    AND s.purchase_order_id=NEW.purchase_order_id AND COALESCE(s.document->>'channel','purchasing_system')<>'email'
  ) THEN RAISE EXCEPTION 'Receipt must be recorded in the purchasing system'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER procurement_manual_receipt_authority BEFORE INSERT ON procurement_commitments
 FOR EACH ROW EXECUTE FUNCTION procurement_manual_receipt_authority();
