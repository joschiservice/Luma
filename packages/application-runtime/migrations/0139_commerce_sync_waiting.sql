-- Admission waits preserve checkpoints; lease limits explain occupied sync capacity.
ALTER TABLE commerce_sync_streams
 ADD COLUMN admission_wait_reason text CHECK (admission_wait_reason IN ('request_capacity','admission_unavailable')),
 ADD COLUMN admission_wait_at timestamptz,
 ADD COLUMN lease_workspace_concurrency integer CHECK (lease_workspace_concurrency > 0),
 ADD COLUMN lease_connection_concurrency integer CHECK (lease_connection_concurrency > 0),
 ADD CONSTRAINT commerce_sync_admission_wait CHECK ((admission_wait_reason IS NULL) = (admission_wait_at IS NULL));
