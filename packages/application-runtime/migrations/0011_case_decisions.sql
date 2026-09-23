DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='luma_desk') THEN
  CREATE ROLE luma_desk NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
 END IF;
END $$;
GRANT USAGE ON SCHEMA public TO luma_desk;
GRANT luma_case_reader,luma_policies,luma_audit TO luma_desk;
CREATE TABLE case_proposals (
 tenant_id uuid NOT NULL, id uuid NOT NULL, exception_id uuid NOT NULL,
 diagnosis_revision integer NOT NULL CHECK(diagnosis_revision>0),
 version integer NOT NULL DEFAULT 1 CHECK(version=1),
 action_hash text NOT NULL CHECK(length(action_hash)=64), document jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,exception_id,diagnosis_revision),
 FOREIGN KEY(tenant_id,exception_id) REFERENCES exceptions(tenant_id,id),
 CHECK(COALESCE(document->>'id'=id::text AND document->>'tenantId'=tenant_id::text,false))
);
CREATE TABLE case_commands (
 tenant_id uuid NOT NULL, id uuid NOT NULL, exception_id uuid NOT NULL,
 actor_id text NOT NULL, request jsonb NOT NULL, document jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,exception_id) REFERENCES exceptions(tenant_id,id)
);
CREATE INDEX case_commands_case_idx ON case_commands(tenant_id,exception_id,created_at,id);
GRANT SELECT,INSERT ON case_proposals,case_commands TO luma_desk;
GRANT SELECT ON case_proposals,case_commands TO luma_execution;
GRANT SELECT ON executed_actions,execution_outbox,exception_outbox TO luma_desk;
GRANT UPDATE(state,document,version,updated_at) ON exceptions TO luma_desk;
CREATE POLICY desk_updates ON exceptions FOR UPDATE TO luma_desk
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['case_proposals','case_commands'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO luma_desk USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
  EXECUTE format('CREATE POLICY execution_reads ON %I FOR SELECT TO luma_execution USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
 END LOOP;
 FOREACH name IN ARRAY ARRAY['executed_actions','execution_outbox','exception_outbox'] LOOP
  EXECUTE format('CREATE POLICY desk_reads ON %I FOR SELECT TO luma_desk USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
 END LOOP;
END $$;
-- Fence proposal dispatch against decisions and diagnosis changes under the detection lock.
-- Unbound intents retain the execution service's existing policy/idempotency contract.
GRANT SELECT ON exceptions,exception_diagnosis_heads,exception_diagnoses TO luma_execution;
CREATE POLICY execution_reads ON exceptions FOR SELECT TO luma_execution USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY execution_reads ON exception_diagnosis_heads FOR SELECT TO luma_execution USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY execution_reads ON exception_diagnoses FOR SELECT TO luma_execution USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE FUNCTION fence_case_execution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proposal case_proposals; valid boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('exceptions:' || NEW.tenant_id::text,0));
 SELECT * INTO proposal FROM case_proposals WHERE tenant_id=NEW.tenant_id AND id=NEW.proposal_id;
 IF FOUND THEN
  SELECT e.state NOT IN ('resolved','escalated') AND h.revision=proposal.diagnosis_revision
    AND d.document->>'status'='ready'
    AND (d.document->'provenance'->>'validUntil' IS NULL OR (d.document->'provenance'->>'validUntil')::timestamptz>clock_timestamp())
    AND (proposal.document->>'expiresAt')::timestamptz>clock_timestamp()
    AND (proposal.document->'preconditions'->>'validUntil')::timestamptz>clock_timestamp()
    AND proposal.action_hash=NEW.action_hash
    AND NOT EXISTS(SELECT 1 FROM case_commands c WHERE c.tenant_id=NEW.tenant_id AND c.exception_id=proposal.exception_id AND c.request->>'kind' IN ('reject','escalate') AND (c.request->>'proposalId'=proposal.id::text OR c.request->>'kind'='escalate'))
  INTO valid FROM exceptions e JOIN exception_diagnosis_heads h ON h.tenant_id=e.tenant_id AND h.exception_id=e.id
   JOIN exception_diagnoses d ON d.tenant_id=h.tenant_id AND d.exception_id=h.exception_id AND d.revision=h.revision
   WHERE e.tenant_id=NEW.tenant_id AND e.id=proposal.exception_id;
  IF valid IS DISTINCT FROM true THEN RAISE EXCEPTION 'Case proposal no longer permits dispatch'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER case_execution_fence BEFORE INSERT ON executed_actions FOR EACH ROW EXECUTE FUNCTION fence_case_execution();
GRANT SELECT ON case_proposals,case_commands,policy_decisions,policy_approvals TO luma_case_reader;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['case_proposals','case_commands','policy_decisions','policy_approvals'] LOOP
  EXECUTE format('CREATE POLICY case_reads ON %I FOR SELECT TO luma_case_reader USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
 END LOOP;
END $$;
CREATE TABLE case_workflows (
 tenant_id uuid NOT NULL,exception_id uuid NOT NULL,source_kind text NOT NULL CHECK(source_kind IN ('incident','detection')),source_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,source_kind,source_id),
 FOREIGN KEY(tenant_id,exception_id) REFERENCES exceptions(tenant_id,id)
);
CREATE INDEX case_workflows_case_idx ON case_workflows(tenant_id,exception_id,created_at DESC);
ALTER TABLE case_workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_workflows FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON case_workflows TO luma_desk;
CREATE POLICY tenant_scope ON case_workflows TO luma_desk USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT INSERT ON exception_outbox TO luma_desk;
CREATE POLICY desk_escalation_audit ON exception_outbox FOR INSERT TO luma_desk WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
