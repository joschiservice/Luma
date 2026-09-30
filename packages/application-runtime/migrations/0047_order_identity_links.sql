-- Order linking keeps immutable snapshots and parent bindings while retiring old pointers.
ALTER TABLE commerce_identity_links DROP CONSTRAINT commerce_identity_links_kind_check;
ALTER TABLE commerce_identity_links ADD CONSTRAINT commerce_identity_links_kind_check
 CHECK(kind IN ('sku','location','order'));

CREATE TABLE orders_projection_retirements (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, entity_id uuid NOT NULL, connection_id uuid NOT NULL,
 target_entity_id uuid NOT NULL, snapshot_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000), actor_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,snapshot_id) REFERENCES orders_snapshots(tenant_id,id),
 FOREIGN KEY(tenant_id,target_entity_id) REFERENCES orders_entities(tenant_id,id)
);
CREATE INDEX orders_retirement_entity ON orders_projection_retirements(tenant_id,entity_id,connection_id);
CREATE TABLE orders_entity_redirects (
 tenant_id uuid NOT NULL, entity_id uuid NOT NULL, target_entity_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,entity_id), CHECK(entity_id<>target_entity_id),
 FOREIGN KEY(tenant_id,entity_id) REFERENCES orders_entities(tenant_id,id),
 FOREIGN KEY(tenant_id,target_entity_id) REFERENCES orders_entities(tenant_id,id)
);
CREATE INDEX orders_redirect_target ON orders_entity_redirects(tenant_id,target_entity_id);
GRANT SELECT,INSERT ON orders_projection_retirements TO luma_orders;
GRANT SELECT,INSERT,UPDATE,DELETE ON orders_entity_redirects TO luma_orders;
GRANT DELETE ON orders_projections TO luma_orders;
GRANT SELECT ON orders_projection_retirements,orders_entity_redirects TO luma_case_reader;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['orders_projection_retirements','orders_entity_redirects'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO luma_orders USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
  EXECUTE format('CREATE POLICY reader ON %I FOR SELECT TO luma_case_reader USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
 END LOOP;
END $$;

-- Indexed suggestion signals. Totals and dates are supporting evidence, never matching rules.
ALTER TABLE orders_list ADD COLUMN external_order_number text;
ALTER TABLE orders_list ADD COLUMN external_order_key text GENERATED ALWAYS AS
 (NULLIF(btrim(external_order_number,' #'),'')) STORED;
ALTER TABLE orders_list ADD COLUMN display_number_key text GENERATED ALWAYS AS
 (NULLIF(btrim(display_number,' #'),'')) STORED;
CREATE INDEX orders_list_external_order ON orders_list(tenant_id,external_order_key) WHERE external_order_key IS NOT NULL;
CREATE INDEX orders_list_order_number ON orders_list(tenant_id,display_number_key) WHERE display_number_key IS NOT NULL;
UPDATE orders_list l SET external_order_number=o.document->'observation'->'data'->>'externalOrderNumber'
 FROM orders_snapshots s JOIN connector_observations o ON o.tenant_id=s.tenant_id AND o.id=s.observation_id
 WHERE s.tenant_id=l.tenant_id AND s.id=l.snapshot_id;
