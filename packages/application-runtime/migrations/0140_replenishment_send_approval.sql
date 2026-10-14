ALTER TABLE workspace_settings ADD COLUMN replenishment_approval jsonb NOT NULL DEFAULT '{"separateSend":false,"threshold":null}';
