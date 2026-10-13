-- Indexed order subjects keep operation targets distinct from the records their actions affect.
ALTER TABLE action_admission_steps
 ADD COLUMN subject_kind text GENERATED ALWAYS AS (document->'subject'->>'kind') STORED,
 ADD COLUMN subject_id text GENERATED ALWAYS AS (document->'subject'->>'id') STORED;
CREATE INDEX action_admission_steps_subject ON action_admission_steps(tenant_id,subject_kind,subject_id);
