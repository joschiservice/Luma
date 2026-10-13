DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='luma_adaptive') THEN
  CREATE ROLE luma_adaptive NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
 END IF;
END $$;
GRANT USAGE ON SCHEMA public TO luma_adaptive;
CREATE TABLE adaptive_fields (
 tenant_id uuid NOT NULL REFERENCES organizations(id), id uuid NOT NULL, record_type text NOT NULL,
 field_key text NOT NULL, field_type text NOT NULL, archived boolean NOT NULL DEFAULT false,
 source text NOT NULL DEFAULT 'luma', document jsonb NOT NULL, created_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,record_type,field_key), UNIQUE(tenant_id,record_type,id),
 CHECK(record_type IN ('order','product','supplier','purchase_order')),
 CHECK(field_type IN ('text','number','date','boolean','single_choice','multi_choice','person')),
 CHECK(source IN ('luma','provider')),
 CHECK(COALESCE(document->>'id'=id::text AND document->>'recordType'=record_type
  AND document->>'key'=field_key AND document->>'type'=field_type
  AND (document->>'archived')::boolean=archived AND document->>'source'=source,false))
);
CREATE TABLE adaptive_field_values (
 tenant_id uuid NOT NULL, record_type text NOT NULL, record_id uuid NOT NULL, field_id uuid NOT NULL,
 value jsonb NOT NULL, document jsonb NOT NULL,
 text_value text GENERATED ALWAYS AS (CASE WHEN jsonb_typeof(value)='string' THEN value#>>'{}' END) STORED,
 number_value numeric GENERATED ALWAYS AS (CASE WHEN jsonb_typeof(value)='number' THEN (value#>>'{}')::numeric END) STORED,
 boolean_value boolean GENERATED ALWAYS AS (CASE WHEN jsonb_typeof(value)='boolean' THEN (value#>>'{}')::boolean END) STORED,
 date_value text GENERATED ALWAYS AS (CASE WHEN jsonb_typeof(value)='string' THEN value#>>'{}' END) STORED,
 PRIMARY KEY(tenant_id,record_type,record_id,field_id),
 FOREIGN KEY(tenant_id,record_type,field_id) REFERENCES adaptive_fields(tenant_id,record_type,id),
 CHECK(COALESCE(document->>'fieldId'=field_id::text AND document->'value'=value,false))
);
CREATE INDEX adaptive_field_text ON adaptive_field_values(tenant_id,field_id,text_value,record_id);
CREATE INDEX adaptive_field_number ON adaptive_field_values(tenant_id,field_id,number_value,record_id);
CREATE INDEX adaptive_field_boolean ON adaptive_field_values(tenant_id,field_id,boolean_value,record_id);
CREATE INDEX adaptive_field_date ON adaptive_field_values(tenant_id,field_id,date_value,record_id);
CREATE INDEX adaptive_field_choices ON adaptive_field_values USING gin(value jsonb_path_ops);
CREATE TABLE adaptive_field_events (
 tenant_id uuid NOT NULL, id uuid NOT NULL, field_id uuid NOT NULL, record_id uuid, actor_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL, document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,field_id) REFERENCES adaptive_fields(tenant_id,id),
 CHECK(COALESCE(document->>'id'=id::text AND document->>'fieldId'=field_id::text
  AND document->>'actorId'=actor_id::text,false))
);
CREATE INDEX adaptive_field_history ON adaptive_field_events(tenant_id,field_id,record_id,occurred_at DESC,id);
CREATE TABLE adaptive_field_effects (tenant_id uuid NOT NULL REFERENCES organizations(id),id text NOT NULL,digest text NOT NULL,result jsonb NOT NULL,PRIMARY KEY(tenant_id,id));
CREATE TABLE adaptive_field_commands (tenant_id uuid NOT NULL REFERENCES organizations(id),id uuid NOT NULL,digest text NOT NULL,result jsonb NOT NULL,PRIMARY KEY(tenant_id,id));
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['adaptive_fields','adaptive_field_values','adaptive_field_events','adaptive_field_commands','adaptive_field_effects'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO luma_adaptive USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',relation);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO luma_adaptive',relation);
 END LOOP;
END $$;
GRANT UPDATE ON adaptive_fields,adaptive_field_values TO luma_adaptive;
-- Only deliberate record identity reads cross ownership; no provider payload access is granted.
GRANT SELECT(tenant_id,id,kind) ON orders_entities,inventory_entities TO luma_adaptive;
CREATE POLICY adaptive_identity_read ON orders_entities FOR SELECT TO luma_adaptive USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY adaptive_identity_read ON inventory_entities FOR SELECT TO luma_adaptive USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT(tenant_id,id) ON procurement_suppliers,procurement_purchase_orders TO luma_adaptive;
CREATE POLICY adaptive_identity_read ON procurement_suppliers FOR SELECT TO luma_adaptive USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY adaptive_identity_read ON procurement_purchase_orders FOR SELECT TO luma_adaptive USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT(tenant_id,user_id,status) ON memberships TO luma_adaptive;
CREATE POLICY adaptive_person_read ON memberships FOR SELECT TO luma_adaptive USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE FUNCTION adaptive_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Custom field history is immutable'; END $$;
CREATE TRIGGER adaptive_event_immutable BEFORE UPDATE OR DELETE ON adaptive_field_events FOR EACH ROW EXECUTE FUNCTION adaptive_event_immutable();
