-- Existing workspaces retain their behavior; subsequently provisioned workspaces observe only.
ALTER TABLE organizations ADD COLUMN write_mode text NOT NULL DEFAULT 'writes_enabled'
 CHECK(write_mode IN ('observe_only','writes_enabled'));
ALTER TABLE organizations ALTER COLUMN write_mode SET DEFAULT 'observe_only';
GRANT UPDATE(write_mode) ON organizations TO luma_identity;
GRANT SELECT(id,write_mode) ON organizations TO luma_execution,luma_desk,luma_case_reader;
CREATE POLICY execution_write_mode ON organizations FOR SELECT TO luma_execution,luma_desk,luma_case_reader
 USING(id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT(tenant_id,id,document) ON connector_installations TO luma_execution;
CREATE POLICY execution_connection_mode ON connector_installations FOR SELECT TO luma_execution
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

CREATE TABLE execution_observe_only (
 tenant_id uuid NOT NULL, proposal_id uuid NOT NULL, action_hash text NOT NULL,
 document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,proposal_id),
 FOREIGN KEY(tenant_id,proposal_id) REFERENCES execution_intents(tenant_id,id)
);
ALTER TABLE execution_observe_only ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_observe_only FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON execution_observe_only TO luma_execution;
GRANT SELECT ON execution_observe_only TO luma_desk,luma_case_reader;
CREATE POLICY tenant_scope ON execution_observe_only TO luma_execution
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY desk_reads ON execution_observe_only FOR SELECT TO luma_desk,luma_case_reader
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

-- Mode changes and reservations serialize on the same workspace fence.
CREATE FUNCTION fence_write_mode() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('exceptions:'||NEW.tenant_id::text,0));
 IF EXISTS(SELECT FROM organizations WHERE id=NEW.tenant_id AND write_mode='observe_only')
 OR EXISTS(SELECT FROM connector_installations WHERE tenant_id=NEW.tenant_id AND id=(NEW.document->'intent'->>'connectionId')::uuid AND document->>'writeMode'='observe_only')
 OR EXISTS(SELECT FROM execution_observe_only WHERE tenant_id=NEW.tenant_id AND proposal_id=NEW.proposal_id)
 THEN RAISE EXCEPTION 'Observe-only prevents execution reservation' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER write_mode_fence BEFORE INSERT ON executed_actions FOR EACH ROW EXECUTE FUNCTION fence_write_mode();

-- Observations share delivery and audit recovery with executed effects.
ALTER TABLE execution_outbox DROP CONSTRAINT execution_outbox_tenant_id_proposal_id_fkey;
ALTER TABLE execution_outbox ADD FOREIGN KEY(tenant_id,proposal_id) REFERENCES execution_intents(tenant_id,id);

CREATE TRIGGER metric_change AFTER INSERT ON execution_observe_only FOR EACH ROW EXECUTE FUNCTION notify_metric_change();

ALTER TABLE workflow_process_steps DROP CONSTRAINT workflow_process_steps_state_check;
ALTER TABLE workflow_process_steps ADD CHECK(state IN ('completed','waiting','denied','failed','inconclusive','ended','escalated','not_executed'));

ALTER TABLE procurement_submissions DROP CONSTRAINT procurement_submissions_state_check;
ALTER TABLE procurement_submissions ADD CHECK(state IN ('approval_required','approved','rejected','expired','submitting','uncertain','submitted','failed','not_executed'));
DROP INDEX procurement_submissions_live;
CREATE UNIQUE INDEX procurement_submissions_live ON procurement_submissions(tenant_id,purchase_order_id) WHERE state NOT IN ('rejected','expired','failed','not_executed');
