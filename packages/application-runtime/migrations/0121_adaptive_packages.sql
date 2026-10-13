CREATE TABLE adaptive_package_installations (
 tenant_id uuid NOT NULL, package_id text NOT NULL, document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,package_id)
);
CREATE TABLE adaptive_package_receipts (
 tenant_id uuid NOT NULL, command_id uuid NOT NULL, document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,command_id)
);
CREATE TABLE adaptive_package_events (
 tenant_id uuid NOT NULL, id uuid NOT NULL, actor_id text NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(), before jsonb, after jsonb,
 PRIMARY KEY(tenant_id,id)
);
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['adaptive_package_installations','adaptive_package_receipts','adaptive_package_events'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO luma_adaptive USING(tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON adaptive_package_installations TO luma_adaptive;
GRANT SELECT,INSERT ON adaptive_package_receipts,adaptive_package_events TO luma_adaptive;
CREATE TABLE adaptive_action_receipts(tenant_id uuid NOT NULL,command_id uuid NOT NULL,digest text NOT NULL,results jsonb NOT NULL,PRIMARY KEY(tenant_id,command_id));
ALTER TABLE adaptive_action_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE adaptive_action_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON adaptive_action_receipts TO luma_adaptive USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON adaptive_action_receipts TO luma_adaptive;
