-- Each owner receives a separate runtime role. No role owns its tables.
DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'luma_policies') THEN
  CREATE ROLE luma_policies NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
 END IF;
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'luma_execution') THEN
  CREATE ROLE luma_execution NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
 END IF;
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'luma_audit') THEN
  CREATE ROLE luma_audit NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
 END IF;
END $$;
GRANT USAGE ON SCHEMA public TO luma_policies, luma_execution, luma_audit;

CREATE TABLE policy_decisions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, proposal_id uuid NOT NULL,
 action_hash text NOT NULL CHECK(length(action_hash)=64), document jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id),
 CHECK(COALESCE(document->>'id'=id::text AND document->>'tenantId'=tenant_id::text,false)),
 CHECK(COALESCE(document->>'outcome' IN ('allowed','denied','approval_required'),false))
);
CREATE INDEX policy_decisions_proposal_idx ON policy_decisions(tenant_id,proposal_id);
CREATE TABLE policy_approvals (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, proposal_id uuid NOT NULL,
 action_hash text NOT NULL CHECK(length(action_hash)=64), policy_version text NOT NULL,
 document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id),
 UNIQUE(tenant_id,proposal_id,action_hash,policy_version),
 CHECK(COALESCE(document->>'id'=id::text AND document->>'tenantId'=tenant_id::text,false)),
 CHECK(COALESCE(document->>'outcome' IN ('approved','rejected'),false)),
 CHECK(COALESCE(document->>'approverId' <> document->>'requesterId',false))
);
CREATE TABLE policy_outbox (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, document jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz, UNIQUE(tenant_id,id)
);
CREATE INDEX policy_outbox_pending_idx ON policy_outbox(tenant_id,created_at) WHERE delivered_at IS NULL;
CREATE TABLE execution_intents (
 id uuid NOT NULL, tenant_id uuid NOT NULL, action_hash text NOT NULL CHECK(length(action_hash)=64),
 document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 CHECK(COALESCE(document->>'id'=id::text AND document->>'tenantId'=tenant_id::text,false))
);
CREATE TABLE executed_actions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, proposal_id uuid NOT NULL,
 idempotency_key text NOT NULL, action_hash text NOT NULL CHECK(length(action_hash)=64),
 state text NOT NULL CHECK(state IN ('prepared','unknown','succeeded','failed')),
 document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,proposal_id), UNIQUE(tenant_id,idempotency_key),
 FOREIGN KEY(tenant_id,proposal_id) REFERENCES execution_intents(tenant_id,id) ON DELETE RESTRICT,
 CHECK(idempotency_key='v0:' || proposal_id::text),
 CHECK(COALESCE(document->>'state'=state AND document->>'tenantId'=tenant_id::text AND document->>'proposalId'=proposal_id::text,false)),
 CHECK(state <> 'succeeded' OR COALESCE(document->'attempt'->'verification'->>'outcome'='passed',false))
);
CREATE TABLE execution_outbox (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, proposal_id uuid NOT NULL,
 document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz,
 UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,proposal_id) REFERENCES executed_actions(tenant_id,proposal_id) ON DELETE RESTRICT
);
CREATE INDEX execution_outbox_pending_idx ON execution_outbox(tenant_id,proposal_id,created_at) WHERE delivered_at IS NULL;
CREATE TABLE audit_entries (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, event_key text NOT NULL, proposal_id uuid NOT NULL,
 document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), UNIQUE(tenant_id,event_key),
 CHECK(COALESCE(document->>'id'=id::text AND document->>'tenantId'=tenant_id::text,false))
);
CREATE INDEX audit_entries_proposal_idx ON audit_entries(tenant_id,proposal_id,created_at);
CREATE INDEX audit_entries_correlation_idx ON audit_entries(tenant_id,(document->>'correlationId'),created_at);

GRANT SELECT,INSERT ON policy_decisions,policy_approvals,policy_outbox TO luma_policies;
GRANT UPDATE(delivered_at) ON policy_outbox TO luma_policies;
GRANT SELECT,INSERT ON execution_intents,executed_actions,execution_outbox TO luma_execution;
GRANT UPDATE(state,document,updated_at) ON executed_actions TO luma_execution;
GRANT UPDATE(delivered_at) ON execution_outbox TO luma_execution;
GRANT SELECT,INSERT ON audit_entries TO luma_audit;

CREATE FUNCTION protect_execution_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT ((OLD.state = 'prepared' AND NEW.state IN ('unknown','failed','succeeded')) OR (OLD.state = 'unknown' AND NEW.state = 'succeeded')) OR
    (NEW.document - 'state' - 'attempt') IS DISTINCT FROM (OLD.document - 'state' - 'attempt') OR
    ((NEW.document->'attempt') - 'finishedAt' - 'verification' - 'effectEvidenceRefs') IS DISTINCT FROM
    ((OLD.document->'attempt') - 'finishedAt' - 'verification' - 'effectEvidenceRefs') THEN
  RAISE EXCEPTION 'Execution intent and finalized attempts are immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER execution_intent_immutable BEFORE UPDATE ON executed_actions FOR EACH ROW EXECUTE FUNCTION protect_execution_intent();

DO $$ DECLARE item record; BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('policy_outbox','luma_policies'),('policy_decisions','luma_policies'),('policy_approvals','luma_policies'),
  ('execution_intents','luma_execution'),('executed_actions','luma_execution'),('execution_outbox','luma_execution'),('audit_entries','luma_audit')
 ) AS tables(name,role_name) LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',item.name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',item.name);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',item.name,item.role_name);
 END LOOP;
END $$;
