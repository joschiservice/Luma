-- Order detail and activity reach linked issues and workflow runs through their subject and
-- target. Row security keeps PostgreSQL from using indexes on JSON expressions (`->>` is not
-- leakproof), so the lookup keys are stored as plain generated columns with btree indexes.
ALTER TABLE exceptions
 ADD COLUMN subject_kind text GENERATED ALWAYS AS (document->'subject'->>'subjectKind') STORED,
 ADD COLUMN subject_id text GENERATED ALWAYS AS (document->'subject'->>'subjectId') STORED;
CREATE INDEX exceptions_subject ON exceptions(tenant_id,subject_kind,subject_id);

ALTER TABLE playbook_runs
 ADD COLUMN target_kind text GENERATED ALWAYS AS (document->'action'->'target'->>'kind') STORED,
 ADD COLUMN target_id text GENERATED ALWAYS AS (document->'action'->'target'->>'id') STORED,
 ADD COLUMN incident_id text GENERATED ALWAYS AS (document->>'incidentId') STORED;
CREATE INDEX playbook_runs_target ON playbook_runs(tenant_id,target_kind,target_id);
CREATE INDEX playbook_runs_incident ON playbook_runs(tenant_id,incident_id);

ALTER TABLE workflow_trigger_runs
 ADD COLUMN subject_kind text GENERATED ALWAYS AS (document->'subject'->>'kind') STORED,
 ADD COLUMN subject_id text GENERATED ALWAYS AS (document->'subject'->>'id') STORED;
CREATE INDEX workflow_trigger_runs_subject ON workflow_trigger_runs(tenant_id,subject_kind,subject_id);
