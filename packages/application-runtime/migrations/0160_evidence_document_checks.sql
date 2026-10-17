-- A CHECK passes when its expression is null, and `document->>'field'` is null when the field is
-- missing. The evidence document checks from 0158 therefore accepted a read without
-- `completeness` or a receipt without `idempotencyKey`, `status` or matching identity fields.
-- Each check now treats a missing field as a failure. Stored evidence was always written with
-- every field, so the constraints are validated in place.
ALTER TABLE procurement_read_evidence DROP CONSTRAINT procurement_read_evidence_document;
ALTER TABLE procurement_read_evidence ADD CONSTRAINT procurement_read_evidence_document
 CHECK(COALESCE(document->>'id'=id::text AND document->>'tenantId'=tenant_id::text
  AND document->>'purchaseOrderId'=purchase_order_id::text
  AND document->'source'->>'connectionId'=connection_id::text
  AND document->>'purpose'=purpose AND document->>'subjectId'=subject_id::text
  AND CASE kind
   WHEN 'read' THEN document->>'completeness' IN ('complete','partial')
   ELSE document->>'kind'='write_receipt' AND document->>'status'='accepted'
    AND document->>'idempotencyKey'<>'' END, false));

ALTER TABLE orders_return_read_evidence DROP CONSTRAINT orders_return_read_evidence_document;
ALTER TABLE orders_return_read_evidence ADD CONSTRAINT orders_return_read_evidence_document
 CHECK(COALESCE(document->>'id'=id::text AND document->>'tenantId'=tenant_id::text
  AND document->>'caseId'=case_id::text
  AND document->'source'->>'connectionId'=connection_id::text
  AND document->>'purpose'=purpose AND document->>'subjectId'=subject_id::text
  AND CASE kind
   WHEN 'read' THEN document->>'completeness' IN ('complete','partial')
   ELSE document->>'kind'='write_receipt' AND document->>'status'='accepted'
    AND purpose IN ('creation','settlement','exchange') AND document->>'idempotencyKey'<>'' END,
  false));

ALTER TABLE messaging_send_receipts DROP CONSTRAINT messaging_send_receipts_check;
ALTER TABLE messaging_send_receipts ADD CONSTRAINT messaging_send_receipts_document
 CHECK(COALESCE(document->>'id'=id::text AND document->>'tenantId'=tenant_id::text
  AND document->>'outboundId'=outbound_id::text
  AND document->'source'->>'connectionId'=connection_id::text
  AND document->>'kind'='write_receipt' AND document->>'status'='accepted'
  AND document->>'idempotencyKey'<>'', false));
