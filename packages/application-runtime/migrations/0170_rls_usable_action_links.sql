-- Measurement and workflow cancellation find admission steps and executed actions through IDs
-- stored in their documents. Row-level security keeps PostgreSQL from using expression indexes
-- on JSON, because `->>` is not leakproof, so executed_actions_admission_run could not serve
-- these reads and each one scanned the tenant's rows. Typed generated columns can be indexed.
-- Malformed values become NULL, so they neither fail the backfill nor match a lookup.
ALTER TABLE action_admission_steps ADD COLUMN incident_id uuid GENERATED ALWAYS AS (
  CASE WHEN document->>'incidentId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN (document->>'incidentId')::uuid END
) STORED;
CREATE INDEX action_admission_steps_incident ON action_admission_steps(tenant_id,incident_id)
  WHERE incident_id IS NOT NULL;

ALTER TABLE executed_actions ADD COLUMN admission_run_id uuid GENERATED ALWAYS AS (
  CASE WHEN document->'admission'->>'runId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN (document->'admission'->>'runId')::uuid END
) STORED;
CREATE INDEX executed_actions_admission_run_id ON executed_actions(tenant_id,admission_run_id)
  WHERE admission_run_id IS NOT NULL;
