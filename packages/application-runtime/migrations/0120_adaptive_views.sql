CREATE TABLE adaptive_views (
 tenant_id uuid NOT NULL REFERENCES organizations(id), id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision > 0), archived boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL, document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,id),
 CHECK(COALESCE(document->>'tenantId'=tenant_id::text AND document->>'id'=id::text AND (document->>'revision')::integer=revision AND (document->>'archived')::boolean=archived,false))
);
CREATE INDEX adaptive_views_recent ON adaptive_views(tenant_id,updated_at DESC,id) WHERE NOT archived;
CREATE TABLE adaptive_view_revisions (
 tenant_id uuid NOT NULL, view_id uuid NOT NULL, revision integer NOT NULL CHECK(revision > 0), document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,view_id,revision), FOREIGN KEY(tenant_id,view_id) REFERENCES adaptive_views(tenant_id,id),
 CHECK(COALESCE(document->>'tenantId'=tenant_id::text AND document->>'id'=view_id::text AND (document->>'revision')::integer=revision,false))
);
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['adaptive_views','adaptive_view_revisions'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO luma_adaptive USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',relation);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON adaptive_views TO luma_adaptive;
GRANT SELECT,INSERT ON adaptive_view_revisions TO luma_adaptive;
