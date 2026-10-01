-- Supplier commitments: submissions to a purchasing system, supplier messages, extracted and
-- observed commitments, and people's follow-up responses. Procurement owns every write.

-- Suppliers gain a mutable purchasing-system link and follow-up terms, guarded by a revision.
GRANT UPDATE(document) ON procurement_suppliers TO luma_desk;

CREATE TABLE procurement_submissions (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 purchase_order_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('approval_required','approved','rejected','expired','submitting','uncertain','submitted','failed')),
 -- Set when the order needs no more purchasing-system reads: fully received, closed or cancelled.
 settled boolean NOT NULL DEFAULT false,
 principal_id text NOT NULL,
 document jsonb NOT NULL,
 created_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,purchase_order_id) REFERENCES procurement_purchase_orders(tenant_id,id),
 CHECK(document->>'id'=id::text AND document->>'tenantId'=tenant_id::text AND document->>'purchaseOrderId'=purchase_order_id::text)
);
-- At most one live submission per order; rejected, expired and failed attempts stay as history.
CREATE UNIQUE INDEX procurement_submissions_live ON procurement_submissions(tenant_id,purchase_order_id)
 WHERE state NOT IN ('rejected','expired','failed');
CREATE INDEX procurement_submissions_order ON procurement_submissions(tenant_id,purchase_order_id,created_at DESC);

CREATE TABLE procurement_communications (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 supplier_id uuid NOT NULL,
 purchase_order_id uuid,
 -- Message ID, or a digest of sender, subject, time and text; repeated deliveries reuse it.
 message_key text NOT NULL CHECK(length(message_key) BETWEEN 1 AND 300),
 document jsonb NOT NULL,
 received_at timestamptz NOT NULL,
 retain_until timestamptz NOT NULL,
 purged_at timestamptz,
 created_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,message_key),
 FOREIGN KEY(tenant_id,supplier_id) REFERENCES procurement_suppliers(tenant_id,id),
 FOREIGN KEY(tenant_id,purchase_order_id) REFERENCES procurement_purchase_orders(tenant_id,id),
 CHECK(document->>'id'=id::text AND document->>'tenantId'=tenant_id::text)
);
CREATE INDEX procurement_communications_order ON procurement_communications(tenant_id,purchase_order_id,received_at DESC);
CREATE INDEX procurement_communications_supplier ON procurement_communications(tenant_id,supplier_id,received_at DESC);
CREATE INDEX procurement_communications_retention ON procurement_communications(retain_until) WHERE purged_at IS NULL;

CREATE TABLE procurement_extractions (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 communication_id uuid NOT NULL,
 attempt integer NOT NULL CHECK(attempt>0),
 document jsonb NOT NULL,
 created_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,communication_id,attempt),
 FOREIGN KEY(tenant_id,communication_id) REFERENCES procurement_communications(tenant_id,id)
);

CREATE TABLE procurement_commitments (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 purchase_order_id uuid NOT NULL,
 -- Deduplicates repeated observations and extractions of the same fact.
 source_key text NOT NULL CHECK(length(source_key) BETWEEN 1 AND 400),
 document jsonb NOT NULL,
 recorded_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,source_key),
 FOREIGN KEY(tenant_id,purchase_order_id) REFERENCES procurement_purchase_orders(tenant_id,id),
 CHECK(document->>'id'=id::text AND document->>'purchaseOrderId'=purchase_order_id::text),
 CHECK(document->>'status' IN ('confirmed','needs_review','rejected')),
 -- Booked receipt is evidence only when a purchasing system reported it.
 CHECK(document->>'kind'<>'received' OR document->'source'->>'kind'='purchasing_system')
);
CREATE INDEX procurement_commitments_order ON procurement_commitments(tenant_id,purchase_order_id,recorded_at);

CREATE TABLE procurement_observations (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 purchase_order_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 digest text NOT NULL,
 document jsonb NOT NULL,
 observed_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,purchase_order_id) REFERENCES procurement_purchase_orders(tenant_id,id)
);
CREATE INDEX procurement_observations_order ON procurement_observations(tenant_id,purchase_order_id,observed_at DESC);

CREATE TABLE procurement_follow_ups (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 purchase_order_id uuid NOT NULL,
 key text NOT NULL CHECK(length(key) BETWEEN 1 AND 400),
 document jsonb NOT NULL,
 responded_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,key),
 FOREIGN KEY(tenant_id,purchase_order_id) REFERENCES procurement_purchase_orders(tenant_id,id)
);

DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['procurement_submissions','procurement_communications','procurement_extractions',
  'procurement_commitments','procurement_observations','procurement_follow_ups'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO luma_desk USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',relation);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO luma_desk',relation);
  EXECUTE format('CREATE TRIGGER metric_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION notify_metric_change()',relation);
 END LOOP;
END $$;
GRANT UPDATE(state,settled,document) ON procurement_submissions TO luma_desk;
-- Only a review outcome changes a commitment; values are never edited.
GRANT UPDATE(document) ON procurement_commitments TO luma_desk;

-- Commitment reviews may change only the review outcome.
CREATE FUNCTION procurement_commitment_review_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (OLD.document - 'status' - 'review') <> (NEW.document - 'status' - 'review')
  OR OLD.document->>'status'<>'needs_review' OR NEW.document->>'status' NOT IN ('confirmed','rejected') THEN
  RAISE EXCEPTION 'Commitments are append-only; only a pending review can be answered';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER procurement_commitment_review_only BEFORE UPDATE ON procurement_commitments
 FOR EACH ROW EXECUTE FUNCTION procurement_commitment_review_only();

-- Discovery reveals routing identities only. Every read and command reauthorizes in tenant scope.
CREATE FUNCTION procurement_submission_scopes() RETURNS TABLE(tenant_id uuid,principal_id text)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT tenant_id,principal_id FROM public.procurement_submissions
 WHERE NOT settled AND state IN ('approved','submitting','uncertain','submitted')
$$;
REVOKE ALL ON FUNCTION procurement_submission_scopes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION procurement_submission_scopes() TO luma_desk;

-- Removes supplier message text after its retention period, across tenants. Metadata, the
-- content digest and commitments remain; quotes are read from the message, so they go too.
CREATE FUNCTION purge_expired_procurement_communications(batch integer) RETURNS integer
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 WITH due AS (
  SELECT tenant_id,id FROM public.procurement_communications
  WHERE purged_at IS NULL AND retain_until<=now() ORDER BY retain_until LIMIT LEAST(GREATEST(batch,1),500)
  FOR UPDATE SKIP LOCKED
 ), purged AS (
  UPDATE public.procurement_communications c
  SET document=c.document-'subject'-'body'||jsonb_build_object('purgedAt',to_jsonb(now()),'purgeReason','retention'),purged_at=now()
  FROM due WHERE c.tenant_id=due.tenant_id AND c.id=due.id RETURNING 1
 ) SELECT count(*)::integer FROM purged
$$;
REVOKE ALL ON FUNCTION purge_expired_procurement_communications(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_expired_procurement_communications(integer) TO luma_desk;
GRANT UPDATE(document,purged_at) ON procurement_communications TO luma_desk;
