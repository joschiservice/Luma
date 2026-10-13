CREATE TABLE autonomy_epochs (
 tenant_id uuid PRIMARY KEY REFERENCES organizations(id), revision integer NOT NULL CHECK(revision > 0)
);
CREATE TABLE autonomy_policies (
 tenant_id uuid NOT NULL REFERENCES organizations(id), id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision > 0), document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,id),
 CHECK(COALESCE(document->>'tenantId'=tenant_id::text AND document->>'id'=id::text AND (document->>'revision')::integer=revision,false))
);
CREATE TABLE autonomy_policy_revisions (
 tenant_id uuid NOT NULL, policy_id uuid NOT NULL, revision integer NOT NULL CHECK(revision > 0), document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,policy_id,revision), FOREIGN KEY(tenant_id,policy_id) REFERENCES autonomy_policies(tenant_id,id)
);
CREATE TABLE autonomy_commands (
 tenant_id uuid NOT NULL REFERENCES organizations(id), id uuid NOT NULL, fingerprint text NOT NULL CHECK(length(fingerprint)=64), document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,id)
);
CREATE TABLE autonomy_history (
 tenant_id uuid NOT NULL REFERENCES organizations(id), proposal_id uuid NOT NULL, policy_id uuid NOT NULL, document jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,proposal_id), FOREIGN KEY(tenant_id,policy_id) REFERENCES autonomy_policies(tenant_id,id)
);
CREATE INDEX autonomy_history_policy ON autonomy_history(tenant_id,policy_id,updated_at DESC);
CREATE TABLE autonomy_reservations (
 tenant_id uuid NOT NULL, proposal_id uuid NOT NULL, policy_id uuid NOT NULL, policy_revision integer NOT NULL,
 budget_day date NOT NULL, quantity numeric(20,6) NOT NULL CHECK(quantity>0), exposure numeric(20,6) CHECK(exposure>=0), document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,proposal_id), FOREIGN KEY(tenant_id,policy_id,policy_revision) REFERENCES autonomy_policy_revisions(tenant_id,policy_id,revision)
);
CREATE INDEX autonomy_budget_day ON autonomy_reservations(tenant_id,policy_id,budget_day);
CREATE TABLE autonomy_outbox (
 tenant_id uuid NOT NULL REFERENCES organizations(id), id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), document jsonb NOT NULL, delivered_at timestamptz,
 PRIMARY KEY(tenant_id,id)
);
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['autonomy_epochs','autonomy_policies','autonomy_policy_revisions','autonomy_commands','autonomy_history','autonomy_reservations','autonomy_outbox'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO luma_policies USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',relation);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON autonomy_policies,autonomy_epochs,autonomy_history TO luma_policies;
GRANT SELECT,INSERT ON autonomy_policy_revisions,autonomy_commands,autonomy_reservations,autonomy_outbox TO luma_policies;
GRANT UPDATE(delivered_at) ON autonomy_outbox TO luma_policies;

CREATE TABLE procurement_follow_up_plans (
 tenant_id uuid NOT NULL REFERENCES organizations(id), id uuid NOT NULL, workflow_run_id uuid NOT NULL, order_id uuid NOT NULL,
 document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 CHECK(COALESCE(document->>'tenantId'=tenant_id::text AND document->>'id'=id::text,false))
);
CREATE TABLE procurement_follow_up_heads (
 tenant_id uuid NOT NULL, workflow_run_id uuid NOT NULL, proposal_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,workflow_run_id), FOREIGN KEY(tenant_id,proposal_id) REFERENCES procurement_follow_up_plans(tenant_id,id)
);
CREATE TABLE procurement_follow_up_renewals (
 tenant_id uuid NOT NULL, id uuid NOT NULL, previous_id uuid NOT NULL, actor_id text NOT NULL, document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,previous_id) REFERENCES procurement_follow_up_plans(tenant_id,id)
);
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['procurement_follow_up_plans','procurement_follow_up_heads','procurement_follow_up_renewals'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO luma_desk USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',relation);
 END LOOP;
END $$;
GRANT SELECT,INSERT ON procurement_follow_up_plans,procurement_follow_up_renewals TO luma_desk;
GRANT SELECT,INSERT,UPDATE ON procurement_follow_up_heads TO luma_desk;

-- The database fence binds every effect to the same enrollment epoch as its reviewed decision.
GRANT SELECT ON autonomy_epochs TO luma_execution,luma_desk;
ALTER POLICY tenant_scope ON autonomy_epochs TO luma_policies,luma_execution,luma_desk;
CREATE OR REPLACE FUNCTION fence_workspace_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE revision integer; autonomy_revision integer; decision_version text; expected text;
BEGIN
 IF NULLIF(current_setting('app.tenant_id',true),'')::uuid IS DISTINCT FROM NEW.tenant_id THEN
  RAISE EXCEPTION 'Reservation requires its workspace context' USING ERRCODE='42501';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('exceptions:'||NEW.tenant_id::text,0));
 SELECT policy_revision INTO revision FROM public.workspace_settings WHERE tenant_id=NEW.tenant_id;
 SELECT a.revision INTO autonomy_revision FROM public.autonomy_epochs a WHERE tenant_id=NEW.tenant_id;
 expected := 'v0.1'||CASE WHEN COALESCE(revision,0)=0 THEN '' ELSE ':workspace:'||revision::text END
  ||CASE WHEN public.workspace_requires_independent_approval() THEN '' ELSE ':self-approval' END
  ||CASE WHEN COALESCE(autonomy_revision,0)=0 THEN '' ELSE ':autonomy:'||autonomy_revision::text END;
 SELECT document->>'policyVersion' INTO decision_version FROM public.policy_decisions WHERE tenant_id=NEW.tenant_id AND id=(NEW.document->'attempt'->>'policyDecisionId')::uuid;
 IF decision_version IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Workspace policy changed before reservation'; END IF;
 RETURN NEW;
END $$;

-- Enrollment adds a suffix, without changing the effective self-response preference.
ALTER TABLE policy_approvals DROP CONSTRAINT policy_approvals_document_check1;
ALTER TABLE policy_approvals ADD CONSTRAINT policy_approvals_document_check1
 CHECK(COALESCE(document->>'approverId' <> document->>'requesterId',false)
 OR (document->>'approverId' IS NOT NULL AND document->>'requesterId' IS NOT NULL AND policy_version ~ ':self-approval(:autonomy:[1-9][0-9]*)?$'));
