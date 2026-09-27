CREATE TABLE replenishment_activations (
 tenant_id uuid NOT NULL REFERENCES organizations(id),
 id uuid NOT NULL,
 position_id uuid NOT NULL,
 principal_id text NOT NULL,
 document jsonb NOT NULL,
 active boolean NOT NULL DEFAULT true,
 revoked_at timestamptz,
 revoked_by text,
 created_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,position_id) REFERENCES inventory_entities(tenant_id,id),
 CHECK(document->>'id'=id::text AND document->>'positionId'=position_id::text AND document->>'principalId'=principal_id)
);
CREATE UNIQUE INDEX replenishment_active_position ON replenishment_activations(tenant_id,position_id) WHERE active;
CREATE TABLE replenishment_claims (
 tenant_id uuid NOT NULL,
 position_id uuid NOT NULL,
 run_id uuid NOT NULL,
 sku text NOT NULL,
 PRIMARY KEY(tenant_id,position_id),
 UNIQUE(tenant_id,sku),
 FOREIGN KEY(tenant_id,run_id) REFERENCES workflow_trigger_runs(tenant_id,id)
);
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['replenishment_activations','replenishment_claims'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO luma_desk USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',relation);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO luma_desk',relation);
 END LOOP;
END $$;
GRANT UPDATE(active,revoked_at,revoked_by) ON replenishment_activations TO luma_desk;
GRANT DELETE ON replenishment_claims TO luma_desk;
-- Discovery reveals routing identities only. Every read and start reauthorizes in tenant scope.
CREATE FUNCTION replenishment_worker_scopes() RETURNS TABLE(tenant_id uuid,principal_id text)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT tenant_id,principal_id FROM public.replenishment_activations
$$;
REVOKE ALL ON FUNCTION replenishment_worker_scopes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION replenishment_worker_scopes() TO luma_desk;

GRANT SELECT ON inventory_entities,inventory_snapshots,inventory_projections TO luma_desk;
CREATE POLICY replenishment_reads ON inventory_entities FOR SELECT TO luma_desk USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY replenishment_reads ON inventory_snapshots FOR SELECT TO luma_desk USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY replenishment_reads ON inventory_projections FOR SELECT TO luma_desk USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
