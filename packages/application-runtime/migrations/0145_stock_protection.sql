-- Consent belongs to Policies; incident ownership and exact write intent belong to Shopify.
CREATE TABLE stock_protection_policies (
 tenant_id uuid NOT NULL REFERENCES organizations(id), connection_id uuid NOT NULL, source_connection_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0), principal_id text NOT NULL, document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,connection_id,source_connection_id)
);
CREATE TABLE stock_protection_policy_revisions (
 tenant_id uuid NOT NULL, connection_id uuid NOT NULL, source_connection_id uuid NOT NULL,
 revision integer NOT NULL, principal_id text NOT NULL, document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,connection_id,source_connection_id,revision),
 FOREIGN KEY(tenant_id,connection_id,source_connection_id) REFERENCES stock_protection_policies(tenant_id,connection_id,source_connection_id)
);
CREATE TABLE stock_protection_budgets (
 tenant_id uuid NOT NULL, proposal_id uuid NOT NULL, connection_id uuid NOT NULL, utc_day date NOT NULL,
 units bigint NOT NULL CHECK(units>=0), PRIMARY KEY(tenant_id,proposal_id,utc_day)
);
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['stock_protection_policies','stock_protection_policy_revisions','stock_protection_budgets'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO luma_policies USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',relation);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON stock_protection_policies TO luma_policies;
GRANT SELECT,INSERT ON stock_protection_policy_revisions,stock_protection_budgets TO luma_policies;

CREATE TABLE shopify_stock_protection_incidents (
 tenant_id uuid NOT NULL REFERENCES organizations(id), id uuid NOT NULL, connection_id uuid NOT NULL,
 source_connection_id uuid NOT NULL, principal_id text NOT NULL, document jsonb NOT NULL,
 revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), CHECK(document->'view'->>'id'=id::text)
);
CREATE TABLE shopify_stock_protection_actions (
 tenant_id uuid NOT NULL, id uuid NOT NULL, incident_id uuid NOT NULL, hold_id uuid NOT NULL,
 operation_key text NOT NULL, document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,incident_id,hold_id,operation_key),
 FOREIGN KEY(tenant_id,incident_id) REFERENCES shopify_stock_protection_incidents(tenant_id,id)
);
CREATE TABLE shopify_stock_protection_events (
 tenant_id uuid NOT NULL, id uuid NOT NULL, incident_id uuid NOT NULL, kind text NOT NULL,
 document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,incident_id,kind),
 FOREIGN KEY(tenant_id,incident_id) REFERENCES shopify_stock_protection_incidents(tenant_id,id)
);
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['shopify_stock_protection_incidents','shopify_stock_protection_actions','shopify_stock_protection_events'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO luma_connectors USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',relation);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON shopify_stock_protection_incidents TO luma_connectors;
GRANT SELECT,INSERT ON shopify_stock_protection_actions,shopify_stock_protection_events TO luma_connectors;
GRANT UPDATE(delivered_at) ON shopify_stock_protection_events TO luma_connectors;
CREATE INDEX shopify_stock_protection_active ON shopify_stock_protection_incidents(tenant_id,connection_id) WHERE document->'view'->>'state'<>'released';
-- Explicit read adapters inspect ownership; they never update Shopify's records.
GRANT SELECT ON shopify_stock_protection_incidents,shopify_stock_protection_actions TO luma_desk,luma_policies;
ALTER POLICY tenant_scope ON shopify_stock_protection_incidents TO luma_connectors,luma_desk,luma_policies;
ALTER POLICY tenant_scope ON shopify_stock_protection_actions TO luma_connectors,luma_desk,luma_policies;

ALTER TABLE workspace_mail ADD COLUMN stock_protection_document jsonb;
ALTER TABLE shopify_stock_protection_events ADD CHECK(kind IN ('placed','partial_failure','escalated','released'));
-- Notification identity is the incident transition, so activity replay cannot send a second batch email.
CREATE FUNCTION enqueue_stock_protection_notification() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE incident jsonb;
BEGIN
 IF NULLIF(current_setting('app.tenant_id',true),'')::uuid IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'Notification requires workspace context' USING ERRCODE='42501'; END IF;
 SELECT document->'view' INTO incident FROM public.shopify_stock_protection_incidents WHERE tenant_id=NEW.tenant_id AND id=NEW.incident_id;
 INSERT INTO public.workspace_mail(tenant_id,id,event_key,kind,user_id,target_id,stock_protection_document)
 SELECT NEW.tenant_id,gen_random_uuid(),'stock-protection:'||NEW.incident_id::text||':'||NEW.kind||':'||p.user_id::text,'issues',p.user_id,NEW.incident_id,
  jsonb_build_object('stage',NEW.kind,'store',incident->>'label')
 FROM public.notification_preferences p JOIN public.memberships m ON m.tenant_id=p.tenant_id AND m.user_id=p.user_id
 WHERE p.tenant_id=NEW.tenant_id AND p.issues AND m.status='active'
 ON CONFLICT(tenant_id,event_key) DO NOTHING;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION enqueue_stock_protection_notification() FROM PUBLIC;
CREATE TRIGGER stock_protection_notification AFTER INSERT ON shopify_stock_protection_events FOR EACH ROW EXECUTE FUNCTION enqueue_stock_protection_notification();
GRANT SELECT ON shopify_stock_protection_incidents TO luma_identity;
ALTER POLICY tenant_scope ON shopify_stock_protection_incidents TO luma_connectors,luma_desk,luma_policies,luma_identity;
