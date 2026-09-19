-- Source history and owner projections are retained independently of raw payloads.
CREATE TABLE connector_observations (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, connection_id uuid NOT NULL,
 ingest_key text NOT NULL, document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,connection_id,id), UNIQUE(tenant_id,connection_id,ingest_key),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id),
 CHECK (document->'observation'->'source'->>'tenantId'=tenant_id::text AND document->'observation'->'source'->>'connectionId'=connection_id::text)
);
CREATE TABLE connector_source_mappings (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, connection_id uuid NOT NULL,
 resource text NOT NULL CHECK(resource IN ('order','order_line','fulfillment','sku','location','product')),
 scope_key text NOT NULL, external_id text NOT NULL, canonical_id uuid NOT NULL,
 observation_id uuid NOT NULL, method text NOT NULL CHECK(length(method)>0), actor_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id),
 UNIQUE(tenant_id,connection_id,resource,scope_key,external_id),
 FOREIGN KEY(tenant_id,connection_id,observation_id) REFERENCES connector_observations(tenant_id,connection_id,id)
);
CREATE INDEX connector_mapping_target ON connector_source_mappings(tenant_id,resource,canonical_id);
GRANT SELECT,INSERT ON connector_observations,connector_source_mappings TO luma_connectors;

DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'luma_orders') THEN
  CREATE ROLE luma_orders NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
 END IF;
END $$;
GRANT USAGE ON SCHEMA public TO luma_orders;
CREATE TABLE orders_entities (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('order','order_line','fulfillment')),
 reconciliation_key text NOT NULL CHECK(length(reconciliation_key)>0),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), UNIQUE(tenant_id,kind,id),
 UNIQUE(tenant_id,kind,reconciliation_key)
);
CREATE TABLE orders_snapshots (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, entity_id uuid NOT NULL, kind text NOT NULL,
 connection_id uuid NOT NULL, observation_id uuid NOT NULL, normalizer_version text NOT NULL, mapping_version text NOT NULL,
 source_updated_at timestamptz, observed_at timestamptz NOT NULL, document jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id),
 UNIQUE(tenant_id,entity_id,connection_id,id),
 UNIQUE(tenant_id,entity_id,observation_id,normalizer_version,mapping_version),
 FOREIGN KEY(tenant_id,kind,entity_id) REFERENCES orders_entities(tenant_id,kind,id),
 CHECK(COALESCE(document->>'entityId'=entity_id::text AND document->>'connectionId'=connection_id::text
 AND document->>'observationId'=observation_id::text AND document->>'kind'=kind,false))
);
CREATE INDEX orders_snapshot_history ON orders_snapshots(tenant_id,entity_id,connection_id,observed_at);
CREATE INDEX orders_snapshot_observation ON orders_snapshots(tenant_id,observation_id);
CREATE TABLE orders_projections (
 tenant_id uuid NOT NULL, entity_id uuid NOT NULL, connection_id uuid NOT NULL,
 snapshot_id uuid NOT NULL, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,entity_id,connection_id),
 FOREIGN KEY(tenant_id,entity_id,connection_id,snapshot_id) REFERENCES orders_snapshots(tenant_id,entity_id,connection_id,id)
);
GRANT SELECT,INSERT ON orders_entities,orders_snapshots,orders_projections TO luma_orders;
GRANT UPDATE(snapshot_id,version,updated_at) ON orders_projections TO luma_orders;

DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'luma_inventory') THEN
  CREATE ROLE luma_inventory NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
 END IF;
END $$;
GRANT USAGE ON SCHEMA public TO luma_inventory;
CREATE TABLE inventory_entities (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('sku','location','product','position')),
 reconciliation_key text NOT NULL CHECK(length(reconciliation_key)>0),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), UNIQUE(tenant_id,kind,id),
 UNIQUE(tenant_id,kind,reconciliation_key)
);
CREATE TABLE inventory_snapshots (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, entity_id uuid NOT NULL, kind text NOT NULL,
 connection_id uuid NOT NULL, observation_id uuid NOT NULL, normalizer_version text NOT NULL, mapping_version text NOT NULL,
 source_updated_at timestamptz, observed_at timestamptz NOT NULL, document jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id),
 UNIQUE(tenant_id,entity_id,connection_id,id),
 UNIQUE(tenant_id,entity_id,observation_id,normalizer_version,mapping_version),
 FOREIGN KEY(tenant_id,kind,entity_id) REFERENCES inventory_entities(tenant_id,kind,id),
 CHECK(COALESCE(document->>'entityId'=entity_id::text AND document->>'connectionId'=connection_id::text
 AND document->>'observationId'=observation_id::text AND document->>'kind'=kind,false))
);
CREATE INDEX inventory_snapshot_history ON inventory_snapshots(tenant_id,entity_id,connection_id,observed_at);
CREATE INDEX inventory_snapshot_observation ON inventory_snapshots(tenant_id,observation_id);
CREATE TABLE inventory_projections (
 tenant_id uuid NOT NULL, entity_id uuid NOT NULL, connection_id uuid NOT NULL,
 snapshot_id uuid NOT NULL, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,entity_id,connection_id),
 FOREIGN KEY(tenant_id,entity_id,connection_id,snapshot_id) REFERENCES inventory_snapshots(tenant_id,entity_id,connection_id,id)
);
GRANT SELECT,INSERT ON inventory_entities,inventory_snapshots,inventory_projections TO luma_inventory;
GRANT UPDATE(snapshot_id,version,updated_at) ON inventory_projections TO luma_inventory;
ALTER TABLE connector_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON connector_observations TO luma_connectors
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE connector_source_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_source_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON connector_source_mappings TO luma_connectors
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE orders_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders_entities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON orders_entities TO luma_orders
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE orders_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON orders_snapshots TO luma_orders
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE orders_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders_projections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON orders_projections TO luma_orders
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE inventory_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_entities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON inventory_entities TO luma_inventory
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE inventory_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON inventory_snapshots TO luma_inventory
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE inventory_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_projections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON inventory_projections TO luma_inventory
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

-- Parent bindings prevent a canonical line or fulfillment from moving between orders.
CREATE TABLE orders_relationships (
 tenant_id uuid NOT NULL, child_id uuid NOT NULL, order_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,child_id),
 FOREIGN KEY(tenant_id,child_id) REFERENCES orders_entities(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders_entities(tenant_id,id)
);
CREATE INDEX orders_relationship_parent ON orders_relationships(tenant_id,order_id);
GRANT SELECT,INSERT ON orders_relationships TO luma_orders;
ALTER TABLE orders_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders_relationships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON orders_relationships TO luma_orders
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

ALTER TABLE inventory_snapshots
 ADD COLUMN sku_id uuid GENERATED ALWAYS AS ((document->'data'->>'skuId')::uuid) STORED,
 ADD COLUMN location_id uuid GENERATED ALWAYS AS ((document->'data'->>'locationId')::uuid) STORED,
 ADD COLUMN unit text GENERATED ALWAYS AS (document->'data'->>'unit') STORED,
 ADD COLUMN on_hand numeric(20,6) GENERATED ALWAYS AS ((document->'data'->>'onHand')::numeric) STORED,
 ADD COLUMN reserved numeric(20,6) GENERATED ALWAYS AS ((document->'data'->>'reserved')::numeric) STORED,
 ADD COLUMN available numeric(20,6) GENERATED ALWAYS AS ((document->'data'->>'available')::numeric) STORED,
 ADD CONSTRAINT inventory_sku_fk FOREIGN KEY(tenant_id,sku_id) REFERENCES inventory_entities(tenant_id,id),
 ADD CONSTRAINT inventory_location_fk FOREIGN KEY(tenant_id,location_id) REFERENCES inventory_entities(tenant_id,id);
CREATE INDEX inventory_snapshot_sku ON inventory_snapshots(tenant_id,sku_id,location_id,connection_id);
CREATE INDEX inventory_snapshot_location ON inventory_snapshots(tenant_id,location_id);
ALTER TABLE orders_snapshots
 ADD COLUMN status text GENERATED ALWAYS AS (document->'data'->>'status') STORED,
 ADD COLUMN payment_status text GENERATED ALWAYS AS (document->'data'->>'paymentStatus') STORED,
 ADD COLUMN display_number text GENERATED ALWAYS AS (document->'data'->>'displayNumber') STORED,
 ADD COLUMN order_id uuid GENERATED ALWAYS AS ((document->'data'->>'orderId')::uuid) STORED,
 ADD CONSTRAINT orders_parent_fk FOREIGN KEY(tenant_id,order_id) REFERENCES orders_entities(tenant_id,id),
 ADD CONSTRAINT orders_status CHECK(status IN ('open','completed','cancelled','unknown','pending','processing','shipped','delivered','failed')),
 ADD CONSTRAINT orders_payment_status CHECK(payment_status IN ('pending','authorized','paid','partially_refunded','refunded','failed','unknown'));
CREATE INDEX orders_snapshot_parent ON orders_snapshots(tenant_id,order_id);
CREATE INDEX orders_snapshot_display ON orders_snapshots(tenant_id,display_number);

CREATE TABLE orders_projection_events (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, snapshot_id uuid NOT NULL, actor_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,snapshot_id) REFERENCES orders_snapshots(tenant_id,id)
);
CREATE INDEX orders_projection_event_snapshot ON orders_projection_events(tenant_id,snapshot_id);
GRANT SELECT,INSERT ON orders_projection_events TO luma_orders;
ALTER TABLE orders_projection_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders_projection_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON orders_projection_events TO luma_orders
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

CREATE TABLE inventory_projection_events (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, snapshot_id uuid NOT NULL, actor_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,snapshot_id) REFERENCES inventory_snapshots(tenant_id,id)
);
CREATE INDEX inventory_projection_event_snapshot ON inventory_projection_events(tenant_id,snapshot_id);
GRANT SELECT,INSERT ON inventory_projection_events TO luma_inventory;
ALTER TABLE inventory_projection_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_projection_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON inventory_projection_events TO luma_inventory
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
