-- Connection coverage reads the latest observation time per capability for every connection.
-- Row security keeps PostgreSQL from using indexes on JSON expressions (`->>` is not
-- leakproof), and a text-to-timestamptz cast is not immutable, so a generated column cannot
-- hold `observed_at`. A trigger copies both keys from the document on write instead.
ALTER TABLE connector_observations ADD COLUMN capability text, ADD COLUMN observed_at timestamptz;

CREATE FUNCTION connector_observation_keys() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.capability := NEW.document->>'capability';
 NEW.observed_at := (NEW.document->'observation'->>'observedAt')::timestamptz;
 RETURN NEW;
END $$;
CREATE TRIGGER connector_observation_keys BEFORE INSERT OR UPDATE OF document ON connector_observations
 FOR EACH ROW EXECUTE FUNCTION connector_observation_keys();

-- The backfill changes no data that live views read, so it sends no change wake-ups.
ALTER TABLE connector_observations DISABLE TRIGGER metric_change;
UPDATE connector_observations SET capability=document->>'capability',
 observed_at=(document->'observation'->>'observedAt')::timestamptz;
ALTER TABLE connector_observations ENABLE TRIGGER metric_change;
CREATE INDEX connector_observations_latest
 ON connector_observations(tenant_id,connection_id,capability,observed_at DESC);
GRANT SELECT(capability,observed_at) ON connector_observations TO luma_case_reader;

-- Successful checks are found per capability without stepping over runs of failed checks.
CREATE INDEX connector_read_checks_latest_success ON connector_read_checks(tenant_id,connection_id,capability,observed_at DESC)
 WHERE succeeded;

-- Sync failure issues name their connection as the subject. Coverage looks them up per
-- connection without the subject kind, so open issues get their own subject index.
CREATE INDEX exceptions_open_subject ON exceptions(tenant_id,subject_id) WHERE state <> 'resolved';

-- Product pages are retained in read checks because product labels are not stored as
-- observations. Case evidence reads labels for one mapped SKU; these tables hold the latest
-- revision of each product and its SKU keys, so the read no longer unnests every stored page.
-- They are maintained from read checks, which stay the source of history.
CREATE TABLE connector_product_labels (
 tenant_id uuid NOT NULL, connection_id uuid NOT NULL,
 scope_key text NOT NULL, external_id text NOT NULL,
 read_check_id bigint NOT NULL REFERENCES connector_read_checks(id) ON DELETE CASCADE,
 observed_at timestamptz NOT NULL, item jsonb NOT NULL,
 PRIMARY KEY(tenant_id,connection_id,scope_key,external_id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id)
);
CREATE INDEX connector_product_labels_check ON connector_product_labels(read_check_id);
CREATE TABLE connector_product_label_skus (
 tenant_id uuid NOT NULL, connection_id uuid NOT NULL,
 scope_key text NOT NULL, external_id text NOT NULL,
 sku_scope_key text NOT NULL, sku_external_id text NOT NULL,
 PRIMARY KEY(tenant_id,connection_id,sku_scope_key,sku_external_id,scope_key,external_id),
 FOREIGN KEY(tenant_id,connection_id,scope_key,external_id)
  REFERENCES connector_product_labels(tenant_id,connection_id,scope_key,external_id) ON DELETE CASCADE
);
CREATE INDEX connector_product_label_skus_product
 ON connector_product_label_skus(tenant_id,connection_id,scope_key,external_id);
GRANT SELECT,INSERT,UPDATE,DELETE ON connector_product_labels,connector_product_label_skus TO luma_connectors;
GRANT SELECT ON connector_product_labels,connector_product_label_skus TO luma_case_reader;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['connector_product_labels','connector_product_label_skus'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', name);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO luma_connectors
   USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)
   WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)', name);
  EXECUTE format('CREATE POLICY overview_reads ON %I FOR SELECT TO luma_case_reader
   USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)', name);
 END LOOP;
END $$;

-- A product revision replaces the stored one only when it is newer by observation time, then
-- by read check; a late page with an older revision leaves the newer label in place.
CREATE FUNCTION connector_product_labels_apply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO connector_product_labels(tenant_id,connection_id,scope_key,external_id,read_check_id,observed_at,item)
 SELECT DISTINCT ON (p->'source'->>'scopeKey',p->'source'->>'externalId')
  NEW.tenant_id,NEW.connection_id,p->'source'->>'scopeKey',p->'source'->>'externalId',NEW.id,(p->>'observedAt')::timestamptz,p
 FROM jsonb_array_elements(COALESCE(NEW.document->'value'->'items','[]'::jsonb)) p
 WHERE p->'source'->>'tenantId'=NEW.tenant_id::text AND p->'source'->>'connectionId'=NEW.connection_id::text
  AND p->'source'->>'resource'='product' AND p->'source'->>'scopeKey' IS NOT NULL
  AND p->'source'->>'externalId' IS NOT NULL AND p->>'observedAt' IS NOT NULL
 ORDER BY p->'source'->>'scopeKey',p->'source'->>'externalId',(p->>'observedAt')::timestamptz DESC
 ON CONFLICT(tenant_id,connection_id,scope_key,external_id) DO UPDATE
  SET read_check_id=EXCLUDED.read_check_id,observed_at=EXCLUDED.observed_at,item=EXCLUDED.item
  WHERE (EXCLUDED.observed_at,EXCLUDED.read_check_id)>(connector_product_labels.observed_at,connector_product_labels.read_check_id);

 DELETE FROM connector_product_label_skus s USING connector_product_labels l
 WHERE l.tenant_id=NEW.tenant_id AND l.read_check_id=NEW.id
  AND s.tenant_id=l.tenant_id AND s.connection_id=l.connection_id AND s.scope_key=l.scope_key AND s.external_id=l.external_id;
 INSERT INTO connector_product_label_skus(tenant_id,connection_id,scope_key,external_id,sku_scope_key,sku_external_id)
 SELECT l.tenant_id,l.connection_id,l.scope_key,l.external_id,s->'id'->>'scopeKey',s->'id'->>'externalId'
 FROM connector_product_labels l
 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(l.item->'data'->'skus')='array' THEN l.item->'data'->'skus' ELSE '[]'::jsonb END) s
 WHERE l.tenant_id=NEW.tenant_id AND l.read_check_id=NEW.id
  AND s->'id'->>'scopeKey' IS NOT NULL AND s->'id'->>'externalId' IS NOT NULL
 ON CONFLICT DO NOTHING;
 RETURN NULL;
END $$;
CREATE TRIGGER connector_product_labels_apply AFTER INSERT ON connector_read_checks
 FOR EACH ROW WHEN (NEW.capability='products.read' AND NEW.succeeded)
 EXECUTE FUNCTION connector_product_labels_apply();

INSERT INTO connector_product_labels(tenant_id,connection_id,scope_key,external_id,read_check_id,observed_at,item)
SELECT DISTINCT ON (r.tenant_id,r.connection_id,p->'source'->>'scopeKey',p->'source'->>'externalId')
 r.tenant_id,r.connection_id,p->'source'->>'scopeKey',p->'source'->>'externalId',r.id,(p->>'observedAt')::timestamptz,p
FROM connector_read_checks r
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.document->'value'->'items','[]'::jsonb)) p
WHERE r.capability='products.read' AND r.succeeded
 AND p->'source'->>'tenantId'=r.tenant_id::text AND p->'source'->>'connectionId'=r.connection_id::text
 AND p->'source'->>'resource'='product' AND p->'source'->>'scopeKey' IS NOT NULL
 AND p->'source'->>'externalId' IS NOT NULL AND p->>'observedAt' IS NOT NULL
ORDER BY r.tenant_id,r.connection_id,p->'source'->>'scopeKey',p->'source'->>'externalId',
 (p->>'observedAt')::timestamptz DESC,r.id DESC;
INSERT INTO connector_product_label_skus(tenant_id,connection_id,scope_key,external_id,sku_scope_key,sku_external_id)
SELECT l.tenant_id,l.connection_id,l.scope_key,l.external_id,s->'id'->>'scopeKey',s->'id'->>'externalId'
FROM connector_product_labels l
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(l.item->'data'->'skus')='array' THEN l.item->'data'->'skus' ELSE '[]'::jsonb END) s
WHERE s->'id'->>'scopeKey' IS NOT NULL AND s->'id'->>'externalId' IS NOT NULL
ON CONFLICT DO NOTHING;
