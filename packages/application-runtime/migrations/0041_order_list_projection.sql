-- Equality postings keep substring candidate lookup indexable under forced RLS.
-- Include one- and two-character grams to preserve short literal searches.
CREATE FUNCTION luma_search_grams(value text) RETURNS text[]
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
 SELECT COALESCE(array_agg(DISTINCT substr(lower(value),pos,width)), '{}'::text[])
 FROM generate_series(1,3) width
 CROSS JOIN LATERAL generate_series(1,length(lower(value))-width+1) pos
$$;

CREATE TABLE orders_list (
 tenant_id uuid NOT NULL, entity_id uuid NOT NULL, connection_id uuid NOT NULL,
 snapshot_id uuid NOT NULL, selected boolean NOT NULL,
 status text NOT NULL, payment_status text NOT NULL, display_number text,
 observed_at timestamptz NOT NULL, source_updated_at timestamptz,
 placed_at timestamptz, due_at timestamptz, deleted boolean NOT NULL,
 line_count integer NOT NULL, fulfillment text NOT NULL, open boolean,
 state_valid_from timestamptz NOT NULL, differs boolean NOT NULL,
 updated_key text COLLATE "C" NOT NULL,
 placed_key text COLLATE "C" NOT NULL, placed_rank integer NOT NULL,
 number_key text COLLATE "C" NOT NULL, number_rank integer NOT NULL,
 due_key text COLLATE "C" NOT NULL, due_rank integer NOT NULL,
 updated_rank integer NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant_id,entity_id,connection_id),
 FOREIGN KEY(tenant_id,entity_id,connection_id,snapshot_id)
 REFERENCES orders_snapshots(tenant_id,entity_id,connection_id,id)
);
CREATE UNIQUE INDEX orders_list_selected ON orders_list(tenant_id,entity_id) WHERE selected;
CREATE INDEX orders_list_status ON orders_list(tenant_id,status,entity_id);
CREATE INDEX orders_list_payment ON orders_list(tenant_id,payment_status,entity_id);
CREATE INDEX orders_list_open ON orders_list(tenant_id,open,entity_id);
CREATE INDEX orders_list_differs ON orders_list(tenant_id,differs,entity_id);
CREATE INDEX orders_list_placed_range ON orders_list(tenant_id,placed_at,entity_id);
CREATE INDEX orders_list_updated_range ON orders_list(tenant_id,source_updated_at,entity_id);
CREATE INDEX orders_list_future ON orders_list(tenant_id,state_valid_from);
-- Each page seeks one null-rank at a time; backward scans cover descending sorts.
CREATE INDEX orders_list_updated_asc ON orders_list(tenant_id,updated_rank,updated_key ASC,entity_id ASC) WHERE selected;
CREATE INDEX orders_list_updated_asc_source ON orders_list(tenant_id,connection_id,updated_rank,updated_key ASC,entity_id ASC);
CREATE INDEX orders_list_placed_asc ON orders_list(tenant_id,placed_rank,placed_key ASC,entity_id ASC) WHERE selected;
CREATE INDEX orders_list_placed_asc_source ON orders_list(tenant_id,connection_id,placed_rank,placed_key ASC,entity_id ASC);
CREATE INDEX orders_list_number_asc ON orders_list(tenant_id,number_rank,number_key ASC,entity_id ASC) WHERE selected;
CREATE INDEX orders_list_number_asc_source ON orders_list(tenant_id,connection_id,number_rank,number_key ASC,entity_id ASC);
CREATE INDEX orders_list_due_asc ON orders_list(tenant_id,due_rank,due_key ASC,entity_id ASC) WHERE selected;
CREATE INDEX orders_list_due_asc_source ON orders_list(tenant_id,connection_id,due_rank,due_key ASC,entity_id ASC);

CREATE TABLE orders_search_values (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tenant_id uuid NOT NULL, value text NOT NULL,
 value_hash bytea NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,value_hash)
);
CREATE TABLE orders_search_links (
 tenant_id uuid NOT NULL, entity_id uuid NOT NULL, connection_id uuid NOT NULL, value_id bigint NOT NULL,
 PRIMARY KEY(tenant_id,value_id,entity_id,connection_id),
 FOREIGN KEY(tenant_id,value_id) REFERENCES orders_search_values(tenant_id,id),
 FOREIGN KEY(tenant_id,entity_id,connection_id) REFERENCES orders_list(tenant_id,entity_id,connection_id) ON DELETE CASCADE
);
CREATE INDEX orders_search_order ON orders_search_links(tenant_id,entity_id,connection_id,value_id);
CREATE TABLE orders_search_grams (
 tenant_id uuid NOT NULL, gram text COLLATE "C" NOT NULL, value_id bigint NOT NULL,
 PRIMARY KEY(tenant_id,gram,value_id),
 FOREIGN KEY(tenant_id,value_id) REFERENCES orders_search_values(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX orders_search_value ON orders_search_grams(tenant_id,value_id);
CREATE TABLE orders_list_skus (
 tenant_id uuid NOT NULL, sku_id uuid NOT NULL, entity_id uuid NOT NULL, connection_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,sku_id,entity_id,connection_id),
 FOREIGN KEY(tenant_id,entity_id,connection_id) REFERENCES orders_list(tenant_id,entity_id,connection_id) ON DELETE CASCADE
);
CREATE INDEX orders_list_skus_order ON orders_list_skus(tenant_id,entity_id,connection_id);

-- Aliases remain Connections-owned and are published in the mapping transaction.
CREATE TABLE connector_mapping_grams (
 tenant_id uuid NOT NULL, gram text COLLATE "C" NOT NULL, mapping_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,gram,mapping_id),
 FOREIGN KEY(tenant_id,mapping_id) REFERENCES connector_source_mappings(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX connector_mapping_gram_id ON connector_mapping_grams(tenant_id,mapping_id);
CREATE FUNCTION connector_index_mapping() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.resource IN ('order','sku') THEN
  INSERT INTO connector_mapping_grams(tenant_id,gram,mapping_id)
  SELECT NEW.tenant_id,unnest(luma_search_grams(NEW.external_id)),NEW.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER connector_index_mapping AFTER INSERT ON connector_source_mappings
 FOR EACH ROW EXECUTE FUNCTION connector_index_mapping();
INSERT INTO connector_mapping_grams(tenant_id,gram,mapping_id)
 SELECT tenant_id,unnest(luma_search_grams(external_id)),id FROM connector_source_mappings
 WHERE resource IN ('order','sku');

GRANT SELECT,INSERT ON connector_mapping_grams TO luma_connectors;
GRANT SELECT ON connector_mapping_grams TO luma_case_reader;
ALTER TABLE connector_mapping_grams ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_mapping_grams FORCE ROW LEVEL SECURITY;
CREATE POLICY mapping_gram_owner ON connector_mapping_grams TO luma_connectors
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY mapping_gram_reader ON connector_mapping_grams FOR SELECT TO luma_case_reader
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT USAGE ON SEQUENCE orders_search_values_id_seq TO luma_orders;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['orders_list','orders_search_values','orders_search_links','orders_search_grams','orders_list_skus'] LOOP
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO luma_orders',name);
  EXECUTE format('GRANT SELECT ON %I TO luma_case_reader',name);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY list_owner ON %I TO luma_orders USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
  EXECUTE format('CREATE POLICY list_reader ON %I FOR SELECT TO luma_case_reader USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
 END LOOP;
END $$;

-- Existing tenants keep using the old read until a complete rebuild publishes readiness.
CREATE TABLE orders_list_backfill (
 tenant_id uuid PRIMARY KEY, after_id uuid
);
INSERT INTO orders_list_backfill(tenant_id) SELECT DISTINCT tenant_id FROM orders_projections;
ALTER TABLE orders_list_backfill ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders_list_backfill FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON orders_list_backfill TO luma_orders;
GRANT SELECT ON orders_list_backfill TO luma_case_reader;
CREATE POLICY backfill_owner ON orders_list_backfill TO luma_orders
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY backfill_reader ON orders_list_backfill FOR SELECT TO luma_case_reader
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
