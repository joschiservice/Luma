-- Historical import, incremental sync and reconciliation of connected commerce records.

DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'luma_commerce_sync') THEN
  CREATE ROLE luma_commerce_sync NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
 END IF;
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'luma_customers') THEN
  CREATE ROLE luma_customers NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
 END IF;
END $$;
GRANT USAGE ON SCHEMA public TO luma_commerce_sync, luma_customers;

-- Customer reads are an installable capability like the other commerce reads.
ALTER TABLE connector_read_checks DROP CONSTRAINT connector_read_checks_capability_check;
ALTER TABLE connector_read_checks ADD CONSTRAINT connector_read_checks_capability_check
 CHECK(capability IN ('orders.read','products.read','inventory.read','fulfillment.read','customers.read','orders.shipping-method.read'));

-- Remapping moves a source to another canonical entity. The original mapping evidence is
-- kept; each move appends a revision in the same transaction, before the change.
CREATE TABLE connector_mapping_revisions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, mapping_id uuid NOT NULL, connection_id uuid NOT NULL,
 resource text NOT NULL, from_canonical_id uuid NOT NULL, to_canonical_id uuid NOT NULL,
 method text NOT NULL CHECK(length(method) BETWEEN 1 AND 1024),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 actor_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id), CHECK(from_canonical_id<>to_canonical_id),
 FOREIGN KEY(tenant_id,mapping_id) REFERENCES connector_source_mappings(tenant_id,id)
);
CREATE INDEX connector_mapping_revision_mapping ON connector_mapping_revisions(tenant_id,mapping_id,created_at);
GRANT SELECT,INSERT ON connector_mapping_revisions TO luma_connectors;
GRANT SELECT ON connector_mapping_revisions TO luma_case_reader;
GRANT UPDATE(canonical_id) ON connector_source_mappings TO luma_connectors;
ALTER TABLE connector_mapping_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_mapping_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON connector_mapping_revisions TO luma_connectors
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY revision_reader ON connector_mapping_revisions FOR SELECT TO luma_case_reader
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE FUNCTION connector_require_mapping_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.canonical_id IS DISTINCT FROM OLD.canonical_id AND NOT EXISTS (
  SELECT 1 FROM connector_mapping_revisions r WHERE r.tenant_id=NEW.tenant_id AND r.mapping_id=NEW.id
   AND r.from_canonical_id=OLD.canonical_id AND r.to_canonical_id=NEW.canonical_id
   AND r.created_at >= transaction_timestamp()) THEN
  RAISE EXCEPTION 'Mapping changes require a revision';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER connector_require_mapping_revision BEFORE UPDATE ON connector_source_mappings
 FOR EACH ROW EXECUTE FUNCTION connector_require_mapping_revision();

-- Verified provider change notifications. They only schedule fresh reads.
CREATE TABLE connector_refresh_hints (
 tenant_id uuid NOT NULL, connection_id uuid NOT NULL, event_key text NOT NULL CHECK(length(event_key) BETWEEN 1 AND 128),
 capabilities text[] NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), consumed_at timestamptz,
 PRIMARY KEY(tenant_id,connection_id,event_key),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id)
);
CREATE INDEX connector_refresh_hint_pending ON connector_refresh_hints(tenant_id,received_at) WHERE consumed_at IS NULL;
GRANT SELECT,INSERT,DELETE ON connector_refresh_hints TO luma_connectors;
GRANT UPDATE(consumed_at) ON connector_refresh_hints TO luma_connectors;
ALTER TABLE connector_refresh_hints ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_refresh_hints FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON connector_refresh_hints TO luma_connectors
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

-- Product catalog projections share inventory storage. Retiring a projection keeps its
-- snapshots as history and records why the source left the entity.
-- SKU codes are descriptive source text: they label SKUs and suggest links, never identity.
CREATE TABLE inventory_product_skus (
 tenant_id uuid NOT NULL, product_id uuid NOT NULL, connection_id uuid NOT NULL, sku_id uuid NOT NULL,
 code text, code_key text GENERATED ALWAYS AS (NULLIF(lower(btrim(code)),'')) STORED,
 PRIMARY KEY(tenant_id,product_id,connection_id,sku_id),
 FOREIGN KEY(tenant_id,product_id,connection_id) REFERENCES inventory_projections(tenant_id,entity_id,connection_id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,sku_id) REFERENCES inventory_entities(tenant_id,id)
);
CREATE INDEX inventory_product_sku ON inventory_product_skus(tenant_id,sku_id);
CREATE INDEX inventory_product_sku_code ON inventory_product_skus(tenant_id,code_key) WHERE code_key IS NOT NULL;
CREATE TABLE inventory_projection_retirements (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, entity_id uuid NOT NULL, connection_id uuid NOT NULL,
 snapshot_id uuid NOT NULL, reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000), actor_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,snapshot_id) REFERENCES inventory_snapshots(tenant_id,id)
);
CREATE INDEX inventory_retirement_entity ON inventory_projection_retirements(tenant_id,entity_id);
GRANT SELECT,INSERT,DELETE ON inventory_product_skus TO luma_inventory;
GRANT SELECT,INSERT ON inventory_projection_retirements TO luma_inventory;
GRANT DELETE ON inventory_projections TO luma_inventory;
GRANT SELECT ON inventory_product_skus,inventory_projection_retirements TO luma_case_reader;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['inventory_product_skus','inventory_projection_retirements'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO luma_inventory USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
  EXECUTE format('CREATE POLICY reader ON %I FOR SELECT TO luma_case_reader USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
 END LOOP;
END $$;

-- Customer profiles keep only the current source version so erasure removes them entirely.
CREATE TABLE customer_profiles (
 tenant_id uuid NOT NULL, connection_id uuid NOT NULL,
 external_id text NOT NULL CHECK(length(external_id) BETWEEN 1 AND 1024), id uuid NOT NULL,
 display_name text, email text, phone text, address jsonb,
 state text NOT NULL CHECK(state IN ('enabled','disabled','invited','declined','unknown')),
 source_created_at timestamptz, order_count integer CHECK(order_count >= 0),
 amount_spent numeric(20,6), currency text CHECK(currency ~ '^[A-Z]{3}$'),
 tags text[] NOT NULL DEFAULT '{}', contact_shared boolean NOT NULL, address_shared boolean NOT NULL,
 source_updated_at timestamptz, observed_at timestamptz NOT NULL, observation_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 email_key text GENERATED ALWAYS AS (lower(email)) STORED,
 PRIMARY KEY(tenant_id,connection_id,external_id), UNIQUE(tenant_id,id),
 CHECK((amount_spent IS NULL) = (currency IS NULL)),
 CHECK(contact_shared OR (display_name IS NULL AND email IS NULL AND phone IS NULL)),
 CHECK(address_shared OR address IS NULL),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id)
);
CREATE INDEX customer_profile_email ON customer_profiles(tenant_id,email_key text_pattern_ops);
CREATE INDEX customer_profile_created ON customer_profiles(tenant_id,source_created_at DESC,id);
CREATE TABLE customer_erasures (
 tenant_id uuid NOT NULL, connection_id uuid NOT NULL, external_digest bytea NOT NULL,
 erased_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,connection_id,external_digest)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON customer_profiles TO luma_customers;
GRANT SELECT,INSERT ON customer_erasures TO luma_customers;
GRANT SELECT ON customer_profiles TO luma_case_reader;
CREATE POLICY profile_reader ON customer_profiles FOR SELECT TO luma_case_reader
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['customer_profiles','customer_erasures'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO luma_customers USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
 END LOOP;
END $$;

-- One stream per connection and record type. The cursor is the checkpoint of the active scan.
CREATE TABLE commerce_sync_streams (
 tenant_id uuid NOT NULL, id uuid NOT NULL, connection_id uuid NOT NULL,
 record_type text NOT NULL CHECK(record_type IN ('orders','fulfillments','products','inventory','customers')),
 principal_id text NOT NULL, paused boolean NOT NULL DEFAULT false,
 phase text NOT NULL CHECK(phase IN ('backfill','incremental')),
 scan text CHECK(scan IN ('backfill','incremental','reconcile')), scan_id uuid, cursor text,
 scan_started_at timestamptz, scan_since timestamptz, scan_pages integer NOT NULL DEFAULT 0,
 scan_records integer NOT NULL DEFAULT 0, scan_total integer, full_requested boolean NOT NULL DEFAULT false,
 watermark timestamptz, history_from timestamptz, history_requirement text, current_history_from timestamptz,
 current_history_limited boolean NOT NULL DEFAULT false,
 due_at timestamptz, hint_at timestamptz, attempts integer NOT NULL DEFAULT 0,
 error_code text, error_message text, error_at timestamptz,
 blocked text CHECK(blocked IN ('connection_inactive','principal_unavailable','capability_removed')),
 lease_token uuid, lease_until timestamptz,
 last_success_at timestamptz, last_complete_at timestamptz, last_full_scan_at timestamptz,
 backfill_started_at timestamptz, backfill_completed_at timestamptz,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,connection_id,record_type),
 CHECK((scan IS NULL) = (scan_id IS NULL)),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id)
);
CREATE INDEX commerce_sync_due ON commerce_sync_streams(tenant_id,due_at) WHERE NOT paused AND blocked IS NULL;

CREATE TABLE commerce_sync_runs (
 tenant_id uuid NOT NULL, id uuid NOT NULL, stream_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('backfill','incremental','reconcile')),
 trigger text NOT NULL CHECK(trigger IN ('connection','operator','schedule','webhook')),
 since timestamptz, full_scan boolean NOT NULL, started_at timestamptz NOT NULL, finished_at timestamptz,
 outcome text NOT NULL CHECK(outcome IN ('running','completed','cancelled')),
 pages integer NOT NULL DEFAULT 0, records integer NOT NULL DEFAULT 0, changed integer NOT NULL DEFAULT 0,
 unchanged integer NOT NULL DEFAULT 0, pending integer NOT NULL DEFAULT 0, failed integer NOT NULL DEFAULT 0,
 missing integer, errors integer NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,stream_id) REFERENCES commerce_sync_streams(tenant_id,id)
);
CREATE INDEX commerce_sync_run_recent ON commerce_sync_runs(tenant_id,started_at DESC);

-- One ledger entry per source record: what was last imported, when it was seen and whether
-- the latest full scan still found it. Digests let unchanged records skip projection.
CREATE TABLE commerce_sync_items (
 tenant_id uuid NOT NULL, connection_id uuid NOT NULL,
 record_type text NOT NULL CHECK(record_type IN ('orders','fulfillments','products','inventory','customers')),
 resource text NOT NULL, scope_key text NOT NULL, external_id text NOT NULL,
 digest text NOT NULL, status text NOT NULL CHECK(status IN ('current','pending','failed')),
 problem text, entity_id uuid, source_created_at timestamptz, source_updated_at timestamptz,
 first_seen_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL, changed_at timestamptz NOT NULL,
 first_seen_by text NOT NULL CHECK(first_seen_by IN ('backfill','incremental','reconcile')),
 seen_scan_id uuid, missing_since timestamptz,
 PRIMARY KEY(tenant_id,connection_id,record_type,resource,scope_key,external_id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id)
);
CREATE INDEX commerce_sync_item_created ON commerce_sync_items(tenant_id,connection_id,record_type,source_created_at);
CREATE INDEX commerce_sync_item_scan ON commerce_sync_items(tenant_id,connection_id,record_type,seen_scan_id);
CREATE INDEX commerce_sync_item_attention ON commerce_sync_items(tenant_id,connection_id,record_type,status) WHERE status<>'current';

-- A person's request to link or unlink equivalent SKUs or locations. The sync worker applies
-- it with the requester's current permissions.
CREATE TABLE commerce_identity_links (
 tenant_id uuid NOT NULL, id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('sku','location')),
 operation text NOT NULL CHECK(operation IN ('link','unlink')), entity_id uuid NOT NULL,
 other_id uuid, connection_id uuid, reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 requested_by text NOT NULL, state text NOT NULL CHECK(state IN ('requested','running','completed','failed')),
 message text, attempts integer NOT NULL DEFAULT 0, lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 PRIMARY KEY(tenant_id,id),
 CHECK((operation='link' AND other_id IS NOT NULL AND connection_id IS NULL)
  OR (operation='unlink' AND other_id IS NULL AND connection_id IS NOT NULL))
);
CREATE INDEX commerce_identity_link_entity ON commerce_identity_links(tenant_id,entity_id,created_at DESC);
CREATE INDEX commerce_identity_link_pending ON commerce_identity_links(tenant_id,created_at) WHERE state IN ('requested','running');

GRANT SELECT,INSERT,UPDATE ON commerce_sync_streams,commerce_sync_runs,commerce_identity_links TO luma_commerce_sync;
GRANT SELECT,INSERT,UPDATE,DELETE ON commerce_sync_items TO luma_commerce_sync;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['commerce_sync_streams','commerce_sync_runs','commerce_sync_items','commerce_identity_links'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO luma_commerce_sync USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
 END LOOP;
END $$;

-- Sync status reads connection summaries and the canonical records it links.
CREATE POLICY commerce_sync_reads ON connector_installations FOR SELECT TO luma_commerce_sync
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY commerce_sync_reads ON connector_lifecycle_events FOR SELECT TO luma_commerce_sync
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY commerce_sync_reads ON connector_refresh_hints TO luma_commerce_sync
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT ON connector_installations,connector_lifecycle_events TO luma_commerce_sync;
GRANT SELECT,DELETE ON connector_refresh_hints TO luma_commerce_sync;
GRANT UPDATE(consumed_at) ON connector_refresh_hints TO luma_commerce_sync;

-- Tenants with sync work: due or hinted streams, active connections without streams, or
-- pending link requests. Returns tenant IDs only.
CREATE FUNCTION commerce_sync_scopes() RETURNS TABLE(tenant_id uuid)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT t.tenant_id FROM (
  SELECT s.tenant_id FROM public.commerce_sync_streams s WHERE NOT s.paused AND s.blocked IS NULL
   AND (s.lease_until IS NULL OR s.lease_until < now()) AND (s.due_at <= now() OR s.hint_at <= now())
  UNION ALL SELECT h.tenant_id FROM public.connector_refresh_hints h WHERE h.consumed_at IS NULL
  UNION ALL SELECT i.tenant_id FROM public.connector_installations i WHERE i.document->>'status'='active'
   AND EXISTS (SELECT 1 FROM public.connector_lifecycle_events e WHERE e.tenant_id=i.tenant_id AND e.connection_id=i.id)
   AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(i.document->'granted') g(capability)
    WHERE g.capability IN ('orders.read','fulfillment.read','products.read','inventory.read','customers.read')
    AND i.document->'permissions' ? g.capability
    AND NOT EXISTS (SELECT 1 FROM public.commerce_sync_streams s WHERE s.tenant_id=i.tenant_id AND s.connection_id=i.id
     AND s.record_type=CASE g.capability WHEN 'orders.read' THEN 'orders' WHEN 'fulfillment.read' THEN 'fulfillments'
      WHEN 'products.read' THEN 'products' WHEN 'inventory.read' THEN 'inventory' ELSE 'customers' END))
  UNION ALL SELECT s.tenant_id FROM public.commerce_sync_streams s WHERE s.blocked IN ('connection_inactive','capability_removed')
   AND EXISTS (SELECT 1 FROM public.connector_installations i WHERE i.tenant_id=s.tenant_id AND i.id=s.connection_id
    AND i.document->>'status'='active'
    AND i.document->'granted' ? CASE s.record_type WHEN 'orders' THEN 'orders.read' WHEN 'fulfillments' THEN 'fulfillment.read'
     WHEN 'products' THEN 'products.read' WHEN 'inventory' THEN 'inventory.read' ELSE 'customers.read' END
    AND i.document->'permissions' ? CASE s.record_type WHEN 'orders' THEN 'orders.read' WHEN 'fulfillments' THEN 'fulfillment.read'
     WHEN 'products' THEN 'products.read' WHEN 'inventory' THEN 'inventory.read' ELSE 'customers.read' END)
  UNION ALL SELECT s.tenant_id FROM public.commerce_sync_streams s WHERE s.blocked IS NULL AND NOT s.paused
   AND EXISTS (SELECT 1 FROM public.connector_installations i WHERE i.tenant_id=s.tenant_id AND i.id=s.connection_id
    AND (i.document->>'status'<>'active' OR NOT (i.document->'granted' ? CASE s.record_type WHEN 'orders' THEN 'orders.read'
     WHEN 'fulfillments' THEN 'fulfillment.read' WHEN 'products' THEN 'products.read' WHEN 'inventory' THEN 'inventory.read'
     ELSE 'customers.read' END)))
  UNION ALL SELECT l.tenant_id FROM public.commerce_identity_links l WHERE l.state='requested'
   OR (l.state='running' AND l.lease_until < now())
 ) t LIMIT 1000
$$;
REVOKE ALL ON FUNCTION commerce_sync_scopes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_sync_scopes() TO luma_commerce_sync;

-- Shopify privacy redaction removes imported customer data for the verified shop at once.
-- A null customer list erases every imported customer of the shop's connections.
CREATE FUNCTION erase_shopify_customer_data(app_key text, shop_domain text, customer_ids text[])
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE erased integer := 0; binding record; removed integer;
BEGIN
 FOR binding IN SELECT b.tenant_id,b.connection_id FROM public.shopify_installation_bindings b
  WHERE b.app=app_key AND b.shop=shop_domain LOOP
  IF customer_ids IS NOT NULL THEN
   INSERT INTO public.customer_erasures(tenant_id,connection_id,external_digest)
    SELECT binding.tenant_id,binding.connection_id,sha256(convert_to(c,'UTF8')) FROM unnest(customer_ids) c
    ON CONFLICT DO NOTHING;
  END IF;
  DELETE FROM public.customer_profiles p WHERE p.tenant_id=binding.tenant_id AND p.connection_id=binding.connection_id
   AND (customer_ids IS NULL OR p.external_id=ANY(customer_ids));
  GET DIAGNOSTICS removed = ROW_COUNT;
  erased := erased + removed;
  DELETE FROM public.commerce_sync_items i WHERE i.tenant_id=binding.tenant_id AND i.connection_id=binding.connection_id
   AND i.record_type='customers' AND (customer_ids IS NULL OR i.external_id=ANY(customer_ids));
 END LOOP;
 RETURN erased;
END $$;
REVOKE ALL ON FUNCTION erase_shopify_customer_data(text,text,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erase_shopify_customer_data(text,text,text[]) TO luma_connectors;
