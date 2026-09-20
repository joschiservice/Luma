-- Each read has a durable start and an optional completion. A missing completion stays pending.
CREATE TABLE execution_verifications (
 tenant_id uuid NOT NULL, id uuid NOT NULL, proposal_id uuid NOT NULL,
 phase text NOT NULL CHECK(phase IN ('pending','completed')),
 document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id,phase),
 FOREIGN KEY(tenant_id,proposal_id) REFERENCES executed_actions(tenant_id,proposal_id),
 CHECK(COALESCE(document->>'id'=id::text AND document->>'proposalId'=proposal_id::text AND document->>'phase'=phase,false))
);
CREATE INDEX execution_verifications_proposal_idx ON execution_verifications(tenant_id,proposal_id,created_at,id,phase);
CREATE TABLE execution_failures (
 tenant_id uuid NOT NULL, id uuid NOT NULL, proposal_id uuid NOT NULL,
 document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,proposal_id) REFERENCES executed_actions(tenant_id,proposal_id)
);
CREATE INDEX execution_failures_proposal_idx ON execution_failures(tenant_id,proposal_id,created_at,id);
GRANT SELECT,INSERT ON execution_verifications,execution_failures TO luma_execution;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['execution_verifications','execution_failures'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO luma_execution USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
 END LOOP;
END $$;
