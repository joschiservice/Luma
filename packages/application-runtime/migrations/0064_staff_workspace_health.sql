-- Workspace health and access history for staff support. The views expose metadata, codes and
-- counts only: no credentials, provider payloads, observations, customer profiles or order data.
-- The restricted view owner reads narrow columns; the staff runtime can read only the views.
-- Row security on every source table limits the view owner to the grant's workspace, and is
-- applied before caller-supplied conditions. The views are therefore not security barriers, which
-- lets ordered, limited reads use the tenant indexes instead of sorting the whole workspace.

-- The workspace of the caller's current support grant, or NULL. Used as an uncorrelated subquery,
-- PostgreSQL evaluates it once per statement, so row filters stay plain, indexable comparisons.
CREATE FUNCTION staff_inspected_workspace() RETURNS uuid LANGUAGE sql VOLATILE SET search_path=pg_catalog,public AS $$
 SELECT g.tenant_id FROM public.staff_support_grants g
 WHERE g.id=NULLIF(current_setting('staff.grant_id',true),'')::uuid
  AND g.staff_user_id=NULLIF(current_setting('staff.user_id',true),'')::uuid
  AND g.staff_session_id=NULLIF(current_setting('staff.session_id',true),'')::uuid
  AND g.expires_at>clock_timestamp() AND public.staff_has_access('staff.workspace.inspect')
$$;
REVOKE ALL ON FUNCTION staff_inspected_workspace() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION staff_inspected_workspace() TO luma_staff_runtime,luma_staff_views;

GRANT SELECT(tenant_id,id,connection_id,record_type,phase,paused,blocked,attempts,error_code,error_message,error_at,failing_since,last_success_at,scan,updated_at) ON commerce_sync_streams TO luma_staff_views;
GRANT SELECT(tenant_id,id,stream_id,kind,trigger,outcome,started_at,finished_at,records,changed,failed,errors) ON commerce_sync_runs TO luma_staff_views;
GRANT SELECT(tenant_id,id,version,document) ON connector_installations TO luma_staff_views;
GRANT SELECT(tenant_id,connection_id,version,event,actor_id,status,credential_version,created_at) ON connector_lifecycle_events TO luma_staff_views;
GRANT SELECT(tenant_id,id,connection_id,capability,observed_at,succeeded,document) ON connector_read_checks TO luma_staff_views;
GRANT SELECT(tenant_id,id,proposal_id,state,document,created_at,updated_at) ON executed_actions TO luma_staff_views;
GRANT SELECT(tenant_id,id,proposal_id,document,created_at) ON execution_failures TO luma_staff_views;
GRANT SELECT(tenant_id,run_id,sequence,step_id,state,document) ON workflow_process_steps TO luma_staff_views;
GRANT SELECT(tenant_id,id,definition_id,state,triggered_at) ON workflow_trigger_runs TO luma_staff_views;
GRANT SELECT(tenant_id,id,definition_id,principal_id,active,created_at) ON workflow_case_activations TO luma_staff_views;
GRANT SELECT(tenant_id,id,state,fingerprint,updated_at) ON exceptions TO luma_staff_views;
GRANT SELECT(tenant_id,fingerprint,first_deferred_at,review_required) ON exception_uncertainty TO luma_staff_views;
GRANT SELECT(tenant_id,id,kind,state,attempts,created_at,first_attempt_at) ON workspace_mail TO luma_staff_views;
GRANT SELECT(tenant_id,app_id,status,version,manifest,updated_at) ON workspace_apps TO luma_staff_views;
GRANT SELECT(tenant_id,timezone,always_require_approval) ON workspace_settings TO luma_staff_views;
GRANT SELECT(tenant_id,id,actor_id,event_type,target_id,before_value,after_value,created_at) ON workspace_access_events TO luma_staff_views;
GRANT SELECT(tenant_id,user_id,name,is_member) ON workspace_people TO luma_staff_views;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['commerce_sync_streams','commerce_sync_runs','connector_installations','connector_lifecycle_events',
  'connector_read_checks','executed_actions','execution_failures','workflow_process_steps','workflow_trigger_runs',
  'workflow_case_activations','exceptions','exception_uncertainty','workspace_mail','workspace_apps','workspace_settings',
  'workspace_access_events','workspace_people'] LOOP
  EXECUTE format('CREATE POLICY staff_health_read ON %I FOR SELECT TO luma_staff_views USING (tenant_id=(SELECT public.staff_inspected_workspace()))',name);
 END LOOP;
END $$;

-- Recent-attention reads filter on plain columns; row security ignores JSON expression indexes.
CREATE INDEX executed_actions_attention ON executed_actions(tenant_id,updated_at DESC) WHERE state IN ('unknown','failed');
CREATE INDEX execution_failures_recent ON execution_failures(tenant_id,created_at DESC,id DESC);
CREATE INDEX workflow_process_steps_attention ON workflow_process_steps(tenant_id,sequence DESC) WHERE state IN ('waiting','failed','inconclusive','escalated');
CREATE INDEX workspace_mail_failed ON workspace_mail(tenant_id,created_at DESC) WHERE state='failed';

-- Sync error messages are Luma's fixed text for the error code; the length cap is a safeguard.
CREATE VIEW staff_health_sync_streams AS
SELECT s.tenant_id,s.id,s.connection_id,s.record_type,s.phase,s.scan,s.paused,s.blocked,s.attempts,
 s.error_code,left(s.error_message,300) AS error_message,s.error_at,s.failing_since,s.last_success_at,s.updated_at
FROM commerce_sync_streams s WHERE s.tenant_id=(SELECT public.staff_inspected_workspace());

CREATE VIEW staff_health_sync_runs AS
SELECT r.tenant_id,r.id,r.stream_id,s.connection_id,s.record_type,r.kind,r.trigger,r.outcome,r.started_at,r.finished_at,
 r.records,r.changed,r.failed,r.errors
FROM commerce_sync_runs r JOIN commerce_sync_streams s ON s.tenant_id=r.tenant_id AND s.id=r.stream_id
WHERE r.tenant_id=(SELECT public.staff_inspected_workspace());

-- Only status and version fields of the connection document; never its target or the secret.
CREATE VIEW staff_health_connections AS
SELECT c.tenant_id,c.id,left(COALESCE(c.document->>'provider',c.document->>'appId','unknown'),40) AS provider,
 c.document->>'status' AS status,c.version,
 CASE WHEN c.document->>'credentialVersion' ~ '^[0-9]{1,9}$' THEN (c.document->>'credentialVersion')::integer END AS credential_version
FROM connector_installations c WHERE c.tenant_id=(SELECT public.staff_inspected_workspace());

CREATE VIEW staff_health_connection_events AS
SELECT e.tenant_id,e.connection_id,e.version,left(e.event,60) AS event,e.status,e.credential_version,left(e.actor_id,100) AS actor_id,
 p.name AS actor_name,p.is_member AS actor_member,e.created_at
FROM connector_lifecycle_events e
LEFT JOIN workspace_people p ON p.tenant_id=e.tenant_id
 AND p.user_id=CASE WHEN e.actor_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN e.actor_id::uuid END
WHERE e.tenant_id=(SELECT public.staff_inspected_workspace());

-- The latest check per granted capability. Successful check documents hold provider observations,
-- so only the normalized connector failure code leaves the document.
CREATE VIEW staff_health_read_checks AS
SELECT c.tenant_id,c.id AS connection_id,k.capability,r.observed_at,r.succeeded,
 CASE WHEN NOT r.succeeded AND r.document->'error'->>'code' ~ '^[a-z_]{1,64}$' THEN r.document->'error'->>'code' END AS error_code
FROM connector_installations c
CROSS JOIN LATERAL (SELECT DISTINCT value AS capability FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(c.document->'granted')='array' THEN c.document->'granted' ELSE '[]'::jsonb END)) k
JOIN LATERAL (SELECT x.observed_at,x.succeeded,x.document FROM connector_read_checks x
 WHERE x.tenant_id=c.tenant_id AND x.connection_id=c.id AND x.capability=k.capability
 ORDER BY x.observed_at DESC,x.id DESC LIMIT 1) r ON true
WHERE c.tenant_id=(SELECT public.staff_inspected_workspace());

CREATE VIEW staff_health_executions AS
SELECT a.tenant_id,a.id,a.proposal_id,a.state,left(a.document->'intent'->>'capability',100) AS capability,
 CASE WHEN a.document->'intent'->>'connectionId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (a.document->'intent'->>'connectionId')::uuid END AS connection_id,
 left(a.document->'attempt'->>'dispatch',20) AS dispatch,left(a.document->'attempt'->>'businessOutcome',20) AS business_outcome,
 a.created_at,a.updated_at
FROM executed_actions a
WHERE a.tenant_id=(SELECT public.staff_inspected_workspace()) AND a.state IN ('unknown','failed');

CREATE VIEW staff_health_execution_failures AS
SELECT f.tenant_id,f.id,f.proposal_id,left(f.document->>'phase',20) AS phase,left(f.document->>'code',64) AS code,
 left(f.document->>'retry',20) AS retry,left(f.document->>'effect',20) AS effect,f.created_at
FROM execution_failures f WHERE f.tenant_id=(SELECT public.staff_inspected_workspace());

-- A run's latest step when it ended without success or has waited for more than a day.
CREATE VIEW staff_health_workflow_steps AS
SELECT s.tenant_id,s.run_id,r.definition_id,left(s.step_id,100) AS step_id,left(s.document->>'kind',40) AS kind,s.state,
 CASE WHEN s.document->>'recordedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN (s.document->>'recordedAt')::timestamptz END AS recorded_at,s.sequence
FROM workflow_process_steps s JOIN workflow_trigger_runs r ON r.tenant_id=s.tenant_id AND r.id=s.run_id
WHERE s.tenant_id=(SELECT public.staff_inspected_workspace())
 AND s.state IN ('waiting','failed','inconclusive','escalated')
 AND NOT EXISTS(SELECT FROM workflow_process_steps later WHERE later.tenant_id=s.tenant_id AND later.run_id=s.run_id AND later.sequence>s.sequence)
 AND (s.state<>'waiting' OR NOT s.document->>'recordedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' OR (s.document->>'recordedAt')::timestamptz<now()-interval '24 hours');

-- Triggered runs no worker has recorded a step for yet.
CREATE VIEW staff_health_workflow_admissions AS
SELECT r.tenant_id,r.id AS run_id,r.definition_id,r.triggered_at
FROM workflow_trigger_runs r
WHERE r.tenant_id=(SELECT public.staff_inspected_workspace()) AND r.state='awaiting_admission'
 AND NOT EXISTS(SELECT FROM workflow_process_steps s WHERE s.tenant_id=r.tenant_id AND s.run_id=r.id);

CREATE VIEW staff_health_case_activations AS
SELECT a.tenant_id,a.id,a.definition_id,a.principal_id,p.name AS principal_name,p.is_member AS principal_member,a.created_at
FROM workflow_case_activations a
LEFT JOIN workspace_people p ON p.tenant_id=a.tenant_id
 AND p.user_id=CASE WHEN a.principal_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN a.principal_id::uuid END
WHERE a.tenant_id=(SELECT public.staff_inspected_workspace()) AND a.active;

CREATE VIEW staff_health_open_cases AS
SELECT e.tenant_id,e.id,e.state,COALESCE(u.review_required,false) AS review_required,u.first_deferred_at,e.updated_at
FROM exceptions e
LEFT JOIN exception_uncertainty u ON u.tenant_id=e.tenant_id AND u.fingerprint=e.fingerprint
WHERE e.tenant_id=(SELECT public.staff_inspected_workspace()) AND e.state<>'resolved';

CREATE VIEW staff_health_failed_mail AS
SELECT m.tenant_id,m.id,m.kind,m.attempts,m.created_at,m.first_attempt_at
FROM workspace_mail m WHERE m.tenant_id=(SELECT public.staff_inspected_workspace()) AND m.state='failed';

CREATE VIEW staff_health_apps AS
SELECT a.tenant_id,a.app_id,a.status,a.version,left(a.manifest->>'version',40) AS app_version,a.updated_at
FROM workspace_apps a WHERE a.tenant_id=(SELECT public.staff_inspected_workspace());

CREATE VIEW staff_health_settings AS
SELECT s.tenant_id,s.timezone,s.always_require_approval
FROM workspace_settings s WHERE s.tenant_id=(SELECT public.staff_inspected_workspace());

-- Access changes with a short summary: role names, the approval policy or the workspace name.
-- Invitation addresses and other before/after values stay in the table.
CREATE VIEW staff_access_history AS
SELECT e.tenant_id,e.id,left(e.event_type,100) AS event_type,left(e.target_id,200) AS target_id,e.actor_id,
 actor.name AS actor_name,actor.is_member AS actor_member,
 CASE WHEN COALESCE(e.after_value->>'userId',e.before_value->>'userId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN COALESCE(e.after_value->>'userId',e.before_value->>'userId')::uuid END AS subject_id,
 subject.name AS subject_name,subject.is_member AS subject_member,
 left(CASE
  WHEN e.event_type='role.app_permissions_removed' THEN 'App '||(e.after_value->'cause'->>'appId')||' uninstalled'
  WHEN e.event_type LIKE 'role.%' THEN COALESCE(e.after_value->>'name',e.before_value->>'name')
  WHEN e.event_type='member.update' THEN NULLIF(concat_ws(' → ',
   COALESCE(e.before_value->>'roleName',CASE WHEN jsonb_typeof(e.before_value->'role')='string' THEN e.before_value->>'role' END),
   COALESCE(e.after_value->>'roleName',CASE WHEN jsonb_typeof(e.after_value->'role')='string' THEN e.after_value->>'role' END)),'')
  WHEN e.event_type LIKE 'member.%' OR e.event_type LIKE 'invitation.%' THEN COALESCE(
   COALESCE(e.after_value->>'roleName',CASE WHEN jsonb_typeof(e.after_value->'role')='string' THEN e.after_value->>'role' END),
   COALESCE(e.before_value->>'roleName',CASE WHEN jsonb_typeof(e.before_value->'role')='string' THEN e.before_value->>'role' END))
  WHEN e.event_type='policy.updated' THEN CASE e.after_value->>'required' WHEN 'true' THEN 'Approval always required' WHEN 'false' THEN 'Approval follows the workspace policy' END
  WHEN e.event_type='workspace.updated' THEN e.after_value->>'name'
 END,200) AS summary,
 e.created_at,to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')||'_'||e.id::text AS cursor
FROM workspace_access_events e
LEFT JOIN workspace_people actor ON actor.tenant_id=e.tenant_id AND actor.user_id=e.actor_id
LEFT JOIN workspace_people subject ON subject.tenant_id=e.tenant_id
 AND subject.user_id=CASE WHEN COALESCE(e.after_value->>'userId',e.before_value->>'userId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN COALESCE(e.after_value->>'userId',e.before_value->>'userId')::uuid END
WHERE e.tenant_id=(SELECT public.staff_inspected_workspace());

DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['staff_health_sync_streams','staff_health_sync_runs','staff_health_connections',
  'staff_health_connection_events','staff_health_read_checks','staff_health_executions','staff_health_execution_failures',
  'staff_health_workflow_steps','staff_health_workflow_admissions','staff_health_case_activations','staff_health_open_cases',
  'staff_health_failed_mail','staff_health_apps','staff_health_settings','staff_access_history'] LOOP
  EXECUTE format('ALTER VIEW %I OWNER TO luma_staff_views',name);
  EXECUTE format('GRANT SELECT ON %I TO luma_staff_runtime',name);
 END LOOP;
END $$;
