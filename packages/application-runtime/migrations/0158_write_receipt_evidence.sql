-- Execution attempts and their audit entries cite the receipt of each accepted provider write.
-- The owner that binds the write now stores that receipt before execution cites it, so every
-- cited ID resolves to stored evidence. A receipt keeps the normalized acceptance: provider,
-- connection, the external records the response named, the provider request ID, the attempt's
-- idempotency key and dispatch identity, the adapter version and the time. Provider payloads,
-- credentials and message content are never stored. A write whose response was lost has no
-- receipt and cites none. Rows stay append-only.
--
-- Procurement and orders keep receipts beside the reads they cite, told apart by `kind`, so one
-- table per owner resolves its cited IDs. Existing rows are reads.
ALTER TABLE procurement_read_evidence
 ADD COLUMN kind text NOT NULL DEFAULT 'read' CHECK(kind IN ('read','write_receipt'));
ALTER TABLE procurement_read_evidence DROP CONSTRAINT procurement_read_evidence_check;
ALTER TABLE procurement_read_evidence ADD CONSTRAINT procurement_read_evidence_document
 CHECK(document->>'id'=id::text AND document->>'tenantId'=tenant_id::text
  AND document->>'purchaseOrderId'=purchase_order_id::text
  AND document->'source'->>'connectionId'=connection_id::text
  AND document->>'purpose'=purpose AND document->>'subjectId'=subject_id::text
  AND CASE kind
   WHEN 'read' THEN document->>'completeness' IN ('complete','partial')
   ELSE document->>'kind'='write_receipt' AND document->>'status'='accepted'
    AND document->>'idempotencyKey'<>'' END);

ALTER TABLE orders_return_read_evidence
 ADD COLUMN kind text NOT NULL DEFAULT 'read' CHECK(kind IN ('read','write_receipt'));
ALTER TABLE orders_return_read_evidence DROP CONSTRAINT orders_return_read_evidence_check;
ALTER TABLE orders_return_read_evidence ADD CONSTRAINT orders_return_read_evidence_document
 CHECK(document->>'id'=id::text AND document->>'tenantId'=tenant_id::text
  AND document->>'caseId'=case_id::text
  AND document->'source'->>'connectionId'=connection_id::text
  AND document->>'purpose'=purpose AND document->>'subjectId'=subject_id::text
  AND CASE kind
   WHEN 'read' THEN document->>'completeness' IN ('complete','partial')
   ELSE document->>'kind'='write_receipt' AND document->>'status'='accepted'
    AND purpose IN ('creation','settlement','exchange') AND document->>'idempotencyKey'<>'' END);

-- Messaging cites stored messages and outgoing replies as reads; a reply's send receipt has its
-- own table beside the reply it belongs to.
CREATE TABLE messaging_send_receipts (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 outbound_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 accepted_at timestamptz NOT NULL,
 document jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,outbound_id) REFERENCES messaging_outbound(tenant_id,id),
 CHECK(document->>'id'=id::text AND document->>'tenantId'=tenant_id::text
  AND document->>'outboundId'=outbound_id::text
  AND document->'source'->>'connectionId'=connection_id::text
  AND document->>'kind'='write_receipt' AND document->>'status'='accepted'
  AND document->>'idempotencyKey'<>'')
);
CREATE INDEX messaging_send_receipts_outbound ON messaging_send_receipts(tenant_id,outbound_id);
ALTER TABLE messaging_send_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging_send_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON messaging_send_receipts TO luma_desk
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON messaging_send_receipts TO luma_desk;
