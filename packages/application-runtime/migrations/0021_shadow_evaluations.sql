CREATE TABLE shadow_evaluations (
 tenant_id uuid NOT NULL, id uuid NOT NULL, incident_id uuid NOT NULL,
 workflow text NOT NULL, actor_id text NOT NULL, document jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,incident_id) REFERENCES exceptions(tenant_id,id),
 CHECK(COALESCE(document->>'mode'='shadow' AND document->>'executed'='false'
 AND document->>'id'=id::text AND document->>'incidentId'=incident_id::text
 AND document->>'workflow'=workflow AND document->>'actorId'=actor_id,false))
);
CREATE INDEX shadow_workflow_incident_idx ON shadow_evaluations(tenant_id,workflow,incident_id,created_at);
CREATE TABLE shadow_reviews (
 tenant_id uuid NOT NULL, evaluation_id uuid NOT NULL, document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,evaluation_id),
 FOREIGN KEY(tenant_id,evaluation_id) REFERENCES shadow_evaluations(tenant_id,id)
);
GRANT SELECT,INSERT ON shadow_evaluations,shadow_reviews TO luma_desk;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['shadow_evaluations','shadow_reviews'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY shadow_read ON %I FOR SELECT TO luma_desk USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
  EXECUTE format('CREATE POLICY shadow_insert ON %I FOR INSERT TO luma_desk WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
 END LOOP;
END $$;
