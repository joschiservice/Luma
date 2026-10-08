-- Connection-pair rules opt into identity matching. Configuration revisions are append-only.
CREATE TABLE commerce_auto_link_rules (
 tenant_id uuid NOT NULL, id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('sku','order')),
 target_connection_id uuid NOT NULL, source_connection_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0), enabled boolean NOT NULL, principal_id text NOT NULL,
 state text NOT NULL CHECK(state IN ('disabled','waiting','active','blocked','failed')),
 message text, last_checked_at timestamptz, linked integer NOT NULL DEFAULT 0 CHECK(linked>=0),
 due_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), CHECK(target_connection_id<>source_connection_id),
 FOREIGN KEY(tenant_id,target_connection_id) REFERENCES connector_installations(tenant_id,id),
 FOREIGN KEY(tenant_id,source_connection_id) REFERENCES connector_installations(tenant_id,id)
);
CREATE UNIQUE INDEX commerce_auto_link_pair ON commerce_auto_link_rules
 (tenant_id,kind,least(target_connection_id,source_connection_id),greatest(target_connection_id,source_connection_id));
CREATE INDEX commerce_auto_link_due ON commerce_auto_link_rules(tenant_id,due_at) WHERE enabled AND state<>'blocked';
CREATE TABLE commerce_auto_link_rule_revisions (
 tenant_id uuid NOT NULL, rule_id uuid NOT NULL, revision integer NOT NULL,
 enabled boolean NOT NULL, actor_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,rule_id,revision),
 FOREIGN KEY(tenant_id,rule_id) REFERENCES commerce_auto_link_rules(tenant_id,id)
);
GRANT SELECT,INSERT,UPDATE ON commerce_auto_link_rules TO luma_commerce_sync;
GRANT SELECT,INSERT ON commerce_auto_link_rule_revisions TO luma_commerce_sync;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['commerce_auto_link_rules','commerce_auto_link_rule_revisions'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO luma_commerce_sync USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
 END LOOP;
END $$;

-- Like sync discovery, this exposes tenant IDs only, through a restricted function.
CREATE FUNCTION commerce_auto_link_scopes() RETURNS TABLE(tenant_id uuid)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT r.tenant_id FROM public.commerce_auto_link_rules r
 WHERE r.enabled AND r.state<>'blocked' AND r.due_at<=now() LIMIT 1000
$$;
REVOKE ALL ON FUNCTION commerce_auto_link_scopes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_auto_link_scopes() TO luma_commerce_sync;
