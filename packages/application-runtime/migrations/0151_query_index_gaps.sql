-- Activity subject reads find proposals and admission steps that target an order. Row security
-- keeps PostgreSQL from using indexes on JSON expressions (`->>` is not leakproof), so the
-- target keys are stored as plain generated columns with btree indexes, as in 0039.
ALTER TABLE case_proposals
 ADD COLUMN target_kind text GENERATED ALWAYS AS (document->'target'->>'kind') STORED,
 ADD COLUMN target_id text GENERATED ALWAYS AS (document->'target'->>'id') STORED;
CREATE INDEX case_proposals_target ON case_proposals(tenant_id,target_kind,target_id);

ALTER TABLE action_admission_steps
 ADD COLUMN target_kind text GENERATED ALWAYS AS (document->'action'->'target'->>'kind') STORED,
 ADD COLUMN target_id text GENERATED ALWAYS AS (document->'action'->'target'->>'id') STORED;
CREATE INDEX action_admission_steps_target ON action_admission_steps(tenant_id,target_kind,target_id);

-- A workflow's trigger history lists its newest runs. Stored `createdAt` values are UTC ISO
-- strings, so text order is time order and the index also serves the ORDER BY and LIMIT.
CREATE INDEX workflow_trigger_runs_recent
 ON workflow_trigger_runs(tenant_id,definition_id,(document->>'createdAt') DESC,id DESC);
